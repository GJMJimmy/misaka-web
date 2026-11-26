"""The M0 HTTP surface: sessions, streaming deltas, input, pause, resume.

Everything the UI needs here is a thin, typed view over the session owner's control socket.
Nothing in this module writes to the MISAKA store.
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any, AsyncIterator

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from pydantic import BaseModel

from .. import __version__, auth, config
from ..bridge import catalog, control

POLL_SECONDS = 0.8
HEARTBEAT_SECONDS = 25.0
STARTED = time.monotonic()

_STATUS_CODES = {
    401: "unauthorized",
    404: "not_found",
    422: "invalid_request",
    502: "unconfirmed_delivery",
    503: "not_configured",
}


class LoginBody(BaseModel):
    token: str = ""


class InputBody(BaseModel):
    text: str = ""


def _fail(status: int, message: str, *, code: str | None = None) -> None:
    raise HTTPException(status_code=status, detail={"code": code or _STATUS_CODES.get(status, "error"), "message": message})


def _record(session_id: str) -> catalog.SessionRecord:
    try:
        return catalog.require(session_id)
    except catalog.UnknownSession:
        _fail(404, f"Unknown session: {session_id}")


def _sse(event: str, data: Any) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False, default=str)}\n\n"


def create_app() -> FastAPI:
    app = FastAPI(title="misaka-web", version=__version__, docs_url="/api/docs", openapi_url="/api/openapi.json")

    if config.settings().dev_origin:
        from fastapi.middleware.cors import CORSMiddleware

        app.add_middleware(
            CORSMiddleware,
            allow_origins=[config.settings().dev_origin or ""],
            allow_credentials=True,
            allow_methods=["*"],
            allow_headers=["*"],
        )

    @app.exception_handler(HTTPException)
    async def _http_error(_request: Request, exc: HTTPException) -> JSONResponse:
        detail = exc.detail
        body = detail if isinstance(detail, dict) and "code" in detail else {
            "code": _STATUS_CODES.get(exc.status_code, "error"),
            "message": str(detail),
        }
        return JSONResponse({"error": body}, status_code=exc.status_code)

    @app.get("/api/health")
    async def health() -> dict[str, Any]:
        """Public by design: the fastest answer to 'why does nothing work' after a deploy."""
        return {
            "ok": True,
            "version": __version__,
            "misaka_version": _misaka_version(),
            "board_schema": _board_schema(),
            "uptime_s": round(time.monotonic() - STARTED, 3),
            **_environment(),
        }

    @app.post("/api/login")
    async def login(body: LoginBody, request: Request) -> JSONResponse:
        if not auth.token_matches(body.token):
            _fail(401, "That token is not accepted.")
        response = JSONResponse({"ok": True})
        secure = request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https"
        auth.set_cookie(response, (config.read_token() or "").strip(), secure=secure)
        return response

    @app.post("/api/logout")
    async def logout() -> JSONResponse:
        response = JSONResponse({"ok": True})
        auth.clear_cookie(response)
        return response

    @app.get("/api/me", dependencies=[Depends(auth.require_auth)])
    async def me() -> dict[str, Any]:
        return {"authenticated": True, "version": __version__}

    @app.get("/api/sessions", dependencies=[Depends(auth.require_auth)])
    async def sessions() -> dict[str, Any]:
        return {"sessions": [record.as_api() for record in catalog.load_records()]}

    @app.get("/api/sessions/{session_id}", dependencies=[Depends(auth.require_auth)])
    async def session_snapshot(session_id: str) -> dict[str, Any]:
        record = _record(session_id)
        try:
            return await control.snapshot(record)
        except control.ControlError as error:
            _fail(502, str(error), code=error.code)

    @app.post("/api/sessions/{session_id}/input", dependencies=[Depends(auth.require_auth)])
    async def session_input(session_id: str, body: InputBody) -> dict[str, Any]:
        text = (body.text or "").strip()
        if not text:
            _fail(422, "Enter a message for this session.")
        record = _record(session_id)
        try:
            await control.send(record, text)
        except control.ControlError as error:
            _fail(502, str(error), code=error.code)
        return {"ok": True}

    async def _pause(session_id: str, paused: bool) -> dict[str, Any]:
        record = _record(session_id)
        try:
            await control.set_paused(record, paused)
        except control.ControlError as error:
            _fail(502, str(error), code=error.code)
        return {"ok": True, "paused": paused}

    @app.post("/api/sessions/{session_id}/pause", dependencies=[Depends(auth.require_auth)])
    async def session_pause(session_id: str) -> dict[str, Any]:
        return await _pause(session_id, True)

    @app.post("/api/sessions/{session_id}/resume", dependencies=[Depends(auth.require_auth)])
    async def session_resume(session_id: str) -> dict[str, Any]:
        return await _pause(session_id, False)

    @app.get("/api/sessions/{session_id}/events", dependencies=[Depends(auth.require_auth)])
    async def session_events(session_id: str, request: Request, since: str | None = None) -> StreamingResponse:
        record = _record(session_id)
        return StreamingResponse(
            _stream(record, request),
            media_type="text/event-stream",
            headers={"cache-control": "no-cache", "x-accel-buffering": "no", "connection": "keep-alive"},
        )

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str) -> FileResponse:
        if path == "api" or path.startswith("api/"):
            _fail(404, f"No such endpoint: /{path}")
        root = config.settings().static_dir.resolve()
        if path:
            candidate = (root / path).resolve()
            if root in candidate.parents and candidate.is_file():
                return FileResponse(candidate)
        index = root / "index.html"
        if index.is_file():
            return FileResponse(index)
        _fail(404, "No UI is built into this package yet (run scripts/sync-web.sh).")

    return app


async def _stream(record: catalog.SessionRecord, request: Request) -> AsyncIterator[str]:
    cursor: Any = None
    stream_cursor: Any = None
    try:
        first = await control.snapshot(record)
    except control.ControlError as error:
        yield _sse("error", {"code": error.code, "message": str(error)})
        return
    cursor, stream_cursor = first.get("cursor"), first.get("stream_cursor")
    state = first.get("state")
    yield _sse("snapshot", first)
    last_beat = time.monotonic()
    while True:
        if await request.is_disconnected():
            return
        await asyncio.sleep(POLL_SECONDS)
        try:
            delta = await control.snapshot(record, cursor=cursor, stream_cursor=stream_cursor)
        except control.ControlError as error:
            yield _sse("error", {"code": error.code, "message": str(error)})
            return
        cursor = delta.get("cursor", cursor)
        stream_cursor = delta.get("stream_cursor", stream_cursor)
        payload: dict[str, Any] = {}
        if delta.get("entries") is not None:
            payload["entries"] = delta["entries"]
        if delta.get("streaming") is not None:
            payload["streaming"] = delta["streaming"]
        new_state = delta.get("state")
        if new_state != state:
            payload["state"] = new_state
            state = new_state
        if payload:
            payload["cursor"] = cursor
            payload["stream_cursor"] = stream_cursor
            last_beat = time.monotonic()
            yield _sse("delta", payload)
        elif time.monotonic() - last_beat >= HEARTBEAT_SECONDS:
            last_beat = time.monotonic()
            yield ": ping\n\n"


def _environment() -> dict[str, Any]:
    """Facts that separate 'no sessions yet' from 'this process cannot see them'."""
    from ..bridge import catalog

    directory = catalog.catalog_dir()
    records = catalog.load_records() if directory.is_dir() else []
    return {
        "sessions_root": str(config.sessions_root()),
        "catalog_present": directory.is_dir(),
        "catalog_records": len(records),
        "sessions_live": sum(1 for record in records if record.has_control),
        "control_parent": _control_parent_seen(),
    }


def _control_parent_seen() -> str | None:
    """Where MISAKA keeps control sockets: /tmp on POSIX (session_catalog._CONTROL_PARENT).

    Report a boolean-ish string so a deploy that hides /tmp (systemd PrivateTmp=yes) is
    diagnosed from /api/health instead of from a UI where every session looks saved.
    """
    import os
    import sys
    import tempfile

    parent = tempfile.gettempdir() if sys.platform == "win32" else "/tmp"
    try:
        entries = os.listdir(parent)
    except OSError:
        return "unreadable"
    if any(name.startswith("misaka-session-") for name in entries):
        return "visible"
    return "empty"


def _misaka_version() -> str | None:
    try:
        import misaka  # type: ignore[import-not-found]

        return str(getattr(misaka, "__version__", None) or "unknown")
    except Exception:
        return None


def _board_schema() -> int | None:
    import sqlite3

    database = config.misaka_home() / "state" / "board.db"
    if not database.is_file():
        return None
    try:
        con = sqlite3.connect(f"file:{database}?mode=ro", uri=True)
        try:
            row = con.execute("PRAGMA user_version").fetchone()
        finally:
            con.close()
    except sqlite3.Error:
        return None
    return int(row[0]) if row else None


app = create_app()