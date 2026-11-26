"""The settings console over HTTP: provider/model, keys, Sisters, project folders."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from .. import audit, auth
from ..bridge import console, runs as board

router = APIRouter(prefix="/api", tags=["settings"], dependencies=[Depends(auth.require_auth)])


class ModelBody(BaseModel):
    provider: str = ""
    model: str = ""
    role: str | None = None


class KeyBody(BaseModel):
    value: str = ""


class SisterBody(BaseModel):
    id: str = ""
    specialty: str = ""
    model: str = ""
    thinking: str = ""


class SisterPatch(BaseModel):
    specialty: str | None = None
    model: str | None = None
    thinking: str | None = None


class ConfirmBody(BaseModel):
    confirm: bool = False


class ProjectBody(BaseModel):
    name: str = ""
    git: bool = True


def _fail(error: Exception) -> None:
    if isinstance(error, console.SettingsError):
        raise HTTPException(status_code=422, detail={"code": "invalid_request", "message": str(error)})
    if isinstance(error, board.BoardUnavailable):
        raise HTTPException(status_code=503, detail={"code": "board_unavailable", "message": str(error)})
    if isinstance(error, FileNotFoundError):
        raise HTTPException(status_code=404, detail={"code": "not_found", "message": str(error)})
    raise error


@router.get("/settings/model")
async def read_model() -> dict[str, Any]:
    try:
        return await console.model_state()
    except Exception as error:  # noqa: BLE001
        _fail(error)
        raise


@router.get("/settings/models")
async def read_models(provider: str) -> dict[str, Any]:
    try:
        return await console.models_of(provider)
    except Exception as error:  # noqa: BLE001
        _fail(error)
        raise


@router.put("/settings/model")
async def write_model(body: ModelBody) -> dict[str, Any]:
    try:
        result = await console.set_model(body.provider, body.model, role=body.role)
    except Exception as error:  # noqa: BLE001
        _fail(error)
        raise
    audit.record("model", role=body.role or "global", provider=body.provider, model=body.model)
    return result


@router.get("/settings/keys")
async def read_keys() -> dict[str, Any]:
    try:
        return console.key_state()
    except Exception as error:  # noqa: BLE001
        _fail(error)
        raise


@router.put("/settings/keys/{name}")
async def write_key(name: str, body: KeyBody) -> dict[str, Any]:
    try:
        result = console.set_key(name, body.value)
    except Exception as error:  # noqa: BLE001
        _fail(error)
        raise
    # the value never reaches the log: only the masked hint does
    audit.record("key_set", name=name, hint=result.get("hint"))
    return result


@router.delete("/settings/keys/{name}")
async def drop_key(name: str) -> dict[str, Any]:
    try:
        result = console.clear_key(name)
    except Exception as error:  # noqa: BLE001
        _fail(error)
        raise
    audit.record("key_clear", name=name)
    return result


@router.get("/sisters")
async def read_sisters() -> dict[str, Any]:
    try:
        return {"sisters": console.sisters()}
    except Exception as error:  # noqa: BLE001
        _fail(error)
        raise


@router.post("/sisters")
async def add_sister(body: SisterBody) -> dict[str, Any]:
    try:
        result = console.create_sister(body.id, specialty=body.specialty, model=body.model, thinking=body.thinking)
    except Exception as error:  # noqa: BLE001
        _fail(error)
        raise
    audit.record("sister_add", sister=body.id, specialty=body.specialty[:120], model=body.model)
    return result


@router.patch("/sisters/{sid}")
async def edit_sister(sid: str, body: SisterPatch) -> dict[str, Any]:
    try:
        result = console.update_sister(sid, specialty=body.specialty, model=body.model, thinking=body.thinking)
    except Exception as error:  # noqa: BLE001
        _fail(error)
        raise
    audit.record("sister_edit", sister=sid, changed=result.get("changed"))
    return result


@router.delete("/sisters/{sid}")
async def drop_sister(sid: str, body: ConfirmBody) -> dict[str, Any]:
    if not body.confirm:
        raise HTTPException(status_code=422, detail={"code": "confirmation_required",
                                                    "message": "Removing a Sister needs an explicit confirm."})
    try:
        result = console.remove_sister(sid)
    except Exception as error:  # noqa: BLE001
        _fail(error)
        raise
    audit.record("sister_remove", sister=sid)
    return result


@router.get("/projects")
async def read_projects() -> dict[str, Any]:
    try:
        return console.projects()
    except Exception as error:  # noqa: BLE001
        _fail(error)
        raise


@router.post("/projects")
async def add_project(body: ProjectBody) -> dict[str, Any]:
    try:
        result = console.create_project(body.name, git=body.git)
    except Exception as error:  # noqa: BLE001
        _fail(error)
        raise
    audit.record("project_create", project=body.name, path=result.get("path"), git=body.git)
    return result