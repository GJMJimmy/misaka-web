"""Research endpoints: read a run, read a node and its markdown, approve by talking."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import audit, auth
from ..bridge import runs as board

router = APIRouter(prefix="/api/runs", tags=["runs"], dependencies=[Depends(auth.require_auth)])


class TellBody(BaseModel):
    text: str = ""
    node_id: str | None = None


class LimitsBody(BaseModel):
    changes: dict[str, Any] = Field(default_factory=dict)


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


@router.post("/{run_id}/stop")
async def stop(run_id: str) -> dict[str, Any]:
    try:
        result = board.request_stop(run_id)
        audit.record("stop", run_id=run_id)
        return result
    except Exception as error:  # noqa: BLE001
        _board_error(error)
        raise


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