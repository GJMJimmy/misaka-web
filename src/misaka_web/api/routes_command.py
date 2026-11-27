"""One chat line that starts with a slash, answered by the bridge."""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from .. import audit, auth
from ..bridge import commands, runs as board

router = APIRouter(prefix="/api", tags=["commands"], dependencies=[Depends(auth.require_auth)])

WRITES = {"research stop", "research resume", "research limits", "research tell"}


class CommandBody(BaseModel):
    text: str = ""


@router.get("/commands")
async def list_commands() -> dict[str, Any]:
    return {"commands": list(commands.SUPPORTED)}


@router.post("/command")
async def run_command(body: CommandBody) -> dict[str, Any]:
    try:
        result = await commands.run_text(body.text)
    except commands.CommandError as error:
        raise HTTPException(status_code=422, detail={"code": "invalid_request", "message": str(error)}) from error
    except board.BoardUnavailable as error:
        raise HTTPException(status_code=503, detail={"code": "board_unavailable", "message": str(error)}) from error
    if result.get("ok") and result.get("command") in WRITES:
        audit.record("command", command=result["command"], text=(body.text or "")[:200])
    return result
