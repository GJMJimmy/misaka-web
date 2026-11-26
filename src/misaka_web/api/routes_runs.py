"""Research endpoints: read a run, read a node and its markdown, approve by talking."""

from __future__ import annotations

from typing import Any

import mimetypes

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from .. import audit, auth
from ..bridge import runs as board
from ..bridge import supervisor

router = APIRouter(prefix="/api/runs", tags=["runs"], dependencies=[Depends(auth.require_auth)])


class TellBody(BaseModel):
    text: str = ""
    node_id: str | None = None


class LimitsBody(BaseModel):
    changes: dict[str, Any] = Field(default_factory=dict)


class CreateRunBody(BaseModel):
    question: str = ""
    workspace: str | None = None
    limits: dict[str, Any] = Field(default_factory=dict)
    diagnostics: bool = False


class StopBody(BaseModel):
    force: bool = False


def _fail(status: int, message: str, *, code: str) -> None:
    raise HTTPException(status_code=status, detail={"code": code, "message": message})


def _board_error(error: Exception) -> None:
    if isinstance(error, board.BoardUnavailable):
        _fail(503, str(error), code="board_unavailable")
    if isinstance(error, (board.RunNotFound, board.NodeNotFound)):
        _fail(404, f"Not found: {error}", code="not_found")
    if isinstance(error, FileNotFoundError):
        _fail(404, f"No such file: {error}", code="not_found")
    if isinstance(error, ValueError):
        _fail(422, str(error), code="invalid_request")
    raise error


@router.get("")
async def list_runs() -> dict[str, Any]:
    try:
        return {"runs": board.list_runs()}
    except Exception as error:  # noqa: BLE001 - mapped to a typed HTTP error below
        _board_error(error)
        raise


@router.get("/{run_id}")
async def run_detail(run_id: str) -> dict[str, Any]:
    try:
        return board.run_detail(run_id)
    except Exception as error:  # noqa: BLE001
        _board_error(error)
        raise


@router.get("/{run_id}/nodes/{node_id}")
async def node_detail(run_id: str, node_id: str) -> dict[str, Any]:
    try:
        return board.node_detail(run_id, node_id)
    except Exception as error:  # noqa: BLE001
        _board_error(error)
        raise


@router.get("/{run_id}/nodes/{node_id}/file")
async def node_file(run_id: str, node_id: str, name: str) -> dict[str, Any]:
    try:
        return board.read_node_file(run_id, node_id, name)
    except Exception as error:  # noqa: BLE001
        _board_error(error)
        raise


@router.post("/{run_id}/tell")
async def tell(run_id: str, body: TellBody) -> dict[str, Any]:
    try:
        result = await board.tell(run_id, body.node_id, body.text)
        audit.record("tell", run_id=run_id, node_id=result.get("node_id"), session_id=result.get("session_id"), chars=len(body.text or ""))
        return result
    except Exception as error:  # noqa: BLE001
        _board_error(error)
        raise


@router.post("")
async def create_run(body: CreateRunBody) -> dict[str, Any]:
    """Start `misaka research` as a child of this service and wait for its run id."""
    try:
        result = supervisor.start(
            workspace=body.workspace or "",
            question=body.question,
            limits=body.limits,
            diagnostics=body.diagnostics,
        )
    except supervisor.SupervisorError as error:
        _fail(422, str(error), code="invalid_request")
    if result.get("workspace_created"):
        audit.record("workspace_create", workspace=result.get("workspace"))
    audit.record("run_start", run_id=result.get("run_id"), pid=result.get("pid"), workspace=result.get("workspace"),
                 question=(body.question or "")[:200])
    return result


@router.post("/{run_id}/resume")
async def resume_run(run_id: str) -> dict[str, Any]:
    try:
        result = supervisor.resume(run_id)
    except supervisor.SupervisorError as error:
        _fail(422, str(error), code="invalid_request")
    except Exception as error:  # noqa: BLE001
        _board_error(error)
        raise
    audit.record("resume", run_id=run_id, pid=result.get("pid"))
    return result


@router.get("/{run_id}/log")
async def run_log(run_id: str, lines: int = 200) -> dict[str, Any]:
    try:
        return supervisor.log_tail(run_id, lines=lines)
    except supervisor.SupervisorError as error:
        _fail(404, str(error), code="not_found")
        raise


@router.post("/{run_id}/stop")
async def stop(run_id: str, body: StopBody | None = None) -> dict[str, Any]:
    try:
        result = board.request_stop(run_id)
    except Exception as error:  # noqa: BLE001
        _board_error(error)
        raise
    audit.record("stop", run_id=run_id)
    if body is not None and body.force and supervisor.managed(run_id):
        try:
            killed = supervisor.terminate(run_id)
        except supervisor.SupervisorError as error:
            _fail(422, str(error), code="invalid_request")
        audit.record("terminate", run_id=run_id, pid=killed.get("pid"))
        result = {**result, "terminated": killed}
    return result


@router.post("/{run_id}/limits")
async def limits(run_id: str, body: LimitsBody) -> dict[str, Any]:
    if not body.changes:
        _fail(422, "Name the limits to change, for example {\"sister_parallel\": 2}.", code="invalid_request")
    try:
        result = board.update_limits(run_id, body.changes)
        audit.record("limits", run_id=run_id, changes=body.changes)
        return result
    except Exception as error:  # noqa: BLE001
        _board_error(error)
        raise

@router.get("/{run_id}/sources")
async def run_sources(run_id: str, node: str | None = None) -> dict[str, Any]:
    """The SOURCES manifest beside a node's product, or beside the final report."""
    try:
        return board.sources(run_id, node_id=node)
    except Exception as error:  # noqa: BLE001
        _board_error(error)
        raise


@router.get("/{run_id}/file")
async def run_file(run_id: str, path: str, node: str | None = None) -> FileResponse:
    """Stream one file from the run workspace; Range is passed through for PDF viewers."""
    try:
        target = board.resolve_file(run_id, path, node_id=node)
    except Exception as error:  # noqa: BLE001
        _board_error(error)
        raise
    media_type = mimetypes.guess_type(target)[0] or "application/octet-stream"
    return FileResponse(
        target,
        media_type=media_type,
        filename=None,
        headers={"cache-control": "private, max-age=60", "content-disposition": "inline"},
    )