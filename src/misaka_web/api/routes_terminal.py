"""The terminal: a ticket over authorized HTTP, then a WebSocket onto a real child process."""

from __future__ import annotations

import asyncio
import hashlib
import os
import secrets
import time
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from .. import audit
from ..bridge import pty as terminal_bridge
from ..bridge import supervisor

router = APIRouter(prefix="/api", tags=["terminal"])

TICKET_TTL = 30.0
TICKETS: dict[str, dict[str, Any]] = {}
ACTIVE: dict[str, int] = {}


def _limit() -> int:
    try:
        return max(1, int(os.environ.get("MISAKA_WEB_TERMINAL_MAX") or 1))
    except ValueError:
        return 1


def _client_hint(request: Request | WebSocket) -> str:
    """The client a ticket belongs to. The user agent only: the peer address differs between
    the HTTP request and the WebSocket on some proxies, while the UA does not. The real
    protections are the 30-second TTL and single use."""
    headers = getattr(request, "headers", {}) or {}
    ua = str(headers.get("user-agent", ""))
    return hashlib.sha256(ua.encode("utf-8", "replace")).hexdigest()[:16]


def _prune() -> None:
    now = time.time()
    for key in [key for key, value in TICKETS.items() if value["expires"] < now]:
        TICKETS.pop(key, None)


class TicketBody(BaseModel):
    profile: str = "shell"
    cwd: str | None = None
    arg: str | None = None
    cols: int = 100
    rows: int = 30


@router.post("/terminal/ticket", dependencies=[Depends(__import__("misaka_web.auth", fromlist=["require_auth"]).require_auth)])
async def create_ticket(body: TicketBody, request: Request) -> dict[str, Any]:
    _prune()
    profile = (body.profile or "shell").strip()
    if profile not in terminal_bridge.PROFILES:
        raise HTTPException(status_code=422, detail={"code": "bad_profile",
                                                    "message": f"Unknown profile: {profile}"})
    if profile in terminal_bridge.TUI_PROFILES and not terminal_bridge.pty_available():
        raise HTTPException(status_code=501, detail={
            "code": "pty_unavailable",
            "message": "This host has no POSIX PTY, so misaka chat / panel / attach cannot run here.",
        })
    try:
        cwd, _created = supervisor.check_workspace(body.cwd)
    except supervisor.SupervisorError as error:
        raise HTTPException(status_code=422, detail={"code": "bad_cwd", "message": str(error)}) from error
    if (ACTIVE.get(_client_hint(request), 0)) >= _limit():
        raise HTTPException(status_code=429, detail={"code": "too_many_terminals",
                                                    "message": f"At most {_limit()} terminal(s) at once."})
    ticket = secrets.token_urlsafe(24)
    TICKETS[ticket] = {
        "expires": time.time() + TICKET_TTL,
        "client": _client_hint(request),
        "profile": profile,
        "cwd": cwd,
        "arg": body.arg,
        "cols": body.cols,
        "rows": body.rows,
    }
    return {
        "ticket": ticket,
        "ws_url": f"/api/terminal/ws?ticket={ticket}",
        "expires_in": int(TICKET_TTL),
        "profile": profile,
        "cwd": cwd,
        "mode": terminal_bridge.mode(),
        "cols": body.cols,
        "rows": body.rows,
    }


@router.websocket("/terminal/ws")
async def terminal_ws(websocket: WebSocket, ticket: str = "") -> None:
    _prune()
    entry = TICKETS.pop(ticket, None)
    await websocket.accept()
    if entry is None:
        await websocket.send_json({"type": "error", "code": "ticket_expired",
                                   "message": "The ticket expired or was already used."})
        await websocket.close()
        return
    if entry["client"] != _client_hint(websocket):
        await websocket.send_json({"type": "error", "code": "ticket_mismatch",
                                   "message": "This ticket was issued to another client."})
        await websocket.close()
        return
    try:
        argv = terminal_bridge.command_for(entry["profile"], entry["arg"])
    except terminal_bridge.TerminalError as error:
        await websocket.send_json({"type": "error", "code": error.code, "message": str(error)})
        await websocket.close()
        return

    loop = asyncio.get_running_loop()
    pending: asyncio.Queue[bytes] = asyncio.Queue()
    terminal = terminal_bridge.Terminal(
        argv, entry["cwd"], cols=entry["cols"], rows=entry["rows"],
        on_output=lambda chunk: loop.call_soon_threadsafe(pending.put_nowait, chunk),
    )
    hint = entry["client"]
    ACTIVE[hint] = ACTIVE.get(hint, 0) + 1
    started = time.time()
    audit.record("terminal_open", profile=entry["profile"], cwd=entry["cwd"], mode=terminal.mode)
    try:
        await terminal.start()
    except Exception as error:  # noqa: BLE001
        ACTIVE[hint] -= 1
        await websocket.send_json({"type": "error", "code": "spawn_failed", "message": str(error)})
        await websocket.close()
        return

    async def pump() -> None:
        while True:
            chunk = await pending.get()
            await websocket.send_json({"type": "output", "data": chunk.decode("utf-8", "replace")})

    async def reader() -> None:
        while True:
            message = await websocket.receive_json()
            kind = message.get("type")
            if kind == "input":
                await terminal.write(str(message.get("data") or "").encode("utf-8"))
            elif kind == "resize":
                await terminal.resize(int(message.get("cols") or 100), int(message.get("rows") or 30))
            elif kind == "ping":
                await websocket.send_json({"type": "pong"})

    pump_task = asyncio.create_task(pump())
    reader_task = asyncio.create_task(reader())
    try:
        code = await terminal.wait()
        await asyncio.sleep(0.05)
        await websocket.send_json({"type": "exit", "code": code})
    except WebSocketDisconnect:
        pass
    except Exception as error:  # noqa: BLE001
        try:
            await websocket.send_json({"type": "error", "code": "terminal_error", "message": str(error)})
        except Exception:  # noqa: BLE001
            pass
    finally:
        for task in (pump_task, reader_task):
            task.cancel()
        await terminal.close()
        ACTIVE[hint] = max(0, ACTIVE.get(hint, 1) - 1)
        audit.record("terminal_close", profile=entry["profile"], seconds=round(time.time() - started, 1),
                     exit_code=terminal.exit_code)
        try:
            await websocket.close()
        except Exception:  # noqa: BLE001
            pass