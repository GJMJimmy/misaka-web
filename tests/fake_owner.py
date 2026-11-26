"""A session owner that speaks the control protocol, for tests only.

It reproduces the real snapshot/delta semantics of misaka/core/session_control.py: entries are
returned only when the caller's cursor differs, and streaming only when its stream cursor does.
"""

from __future__ import annotations

import asyncio
import json
import threading
from typing import Any

from misaka.utils import local_socket  # type: ignore[import-not-found]  # dev-only dependency


class FakeOwner:
    def __init__(self, *, session_id: str = "sess-1", instance: str = "inst-sess-1") -> None:
        self.session_id = session_id
        self.instance = instance
        self.state = "idle"
        self.paused = False
        self.entries: list[dict[str, Any]] = []
        self.streaming: dict[str, Any] | None = None
        self.revision = 0
        self.texts: list[str] = []
        self.pause_calls: list[str] = []
        self.fail_with: str | None = None
        self.path: str | None = None
        self.server = None

    def snapshot_reply(self, command: dict[str, Any]) -> dict[str, Any]:
        cursor = [None, len(self.entries)]
        stream_cursor = [self.session_id, None, len(self.entries), self.revision, self.streaming is not None]
        return {
            "id": self.session_id,
            "cwd": "/research",
            "state": self.state,
            "paused": self.paused,
            "error": "",
            "workflow": None,
            "cursor": cursor,
            "stream_cursor": stream_cursor,
            "steering": [],
            "follow_up": [],
            "streaming": self.streaming if command.get("stream_cursor") != stream_cursor else None,
            "entries": list(self.entries) if command.get("cursor") != cursor else None,
        }

    async def _serve(self, reader, writer) -> None:  # noqa: ANN001 - protocol callback
        try:
            line = await reader.readline()
            command = json.loads(line or b"{}")
            if command.get("session") != self.session_id or command.get("instance") != self.instance:
                reply = {"ok": False, "error": "The original session changed owners or ended."}
            elif self.fail_with:
                reply = {"ok": False, "error": self.fail_with}
            else:
                operation = command.get("operation")
                if operation == "snapshot":
                    reply = {"ok": True, "result": self.snapshot_reply(command)}
                elif operation == "input":
                    self.texts.append(str(command.get("text")))
                    reply = {"ok": True, "result": "Delivered to the original session."}
                elif operation in {"pause", "resume"}:
                    self.paused = operation == "pause"
                    self.pause_calls.append(operation)
                    reply = {"ok": True, "result": "ok"}
                else:
                    reply = {"ok": False, "error": f"Unknown session operation: {operation}"}
            writer.write((json.dumps(reply) + "\n").encode())
            await writer.drain()
        finally:
            writer.close()
            try:
                await writer.wait_closed()
            except (ConnectionError, OSError):
                pass

    async def start(self, path: str) -> str:
        self.path = path
        self.server = await local_socket.start_server(self._serve, path, limit=1024 * 1024)
        return path

    def stop(self) -> None:
        if self.server is not None:
            self.server.close()
            self.server = None


class OwnerService:
    """Runs a FakeOwner on its own thread loop so sync TestClient tests can reach it."""

    def __init__(self, owner: FakeOwner) -> None:
        self.owner = owner
        self.loop: asyncio.AbstractEventLoop | None = None
        self.thread: threading.Thread | None = None
        self.path: str | None = None

    def start(self, path: str) -> str:
        self.loop = asyncio.new_event_loop()
        ready = threading.Event()

        def run() -> None:
            assert self.loop is not None
            asyncio.set_event_loop(self.loop)
            self.loop.run_until_complete(self.owner.start(path))
            ready.set()
            self.loop.run_forever()

        self.thread = threading.Thread(target=run, daemon=True)
        self.thread.start()
        if not ready.wait(10):
            raise RuntimeError("fake owner did not start")
        self.path = path
        return path

    def stop(self) -> None:
        if self.loop is not None:
            self.loop.call_soon_threadsafe(self.owner.stop)
            self.loop.call_soon_threadsafe(self.loop.stop)
        if self.thread is not None:
            self.thread.join(timeout=5)
