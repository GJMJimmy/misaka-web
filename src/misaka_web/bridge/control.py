"""The four operations a session owner accepts: snapshot, input, pause, resume.

Semantics mirror misaka/core/session_control.py: one command, one acknowledgement; an input
whose ack never arrives is reported as unconfirmed and is never resent automatically.
"""

from __future__ import annotations

from typing import Any

from . import transport

SNAPSHOT_OPERATIONS = ("snapshot", "input", "pause", "resume")


class ControlError(RuntimeError):
    def __init__(self, message: str, *, code: str = "control_failed") -> None:
        super().__init__(message)
        self.code = code


def _endpoint(record: Any) -> str:
    control = getattr(record, "control", None) if not isinstance(record, dict) else record.get("control")
    if not control:
        raise ControlError("This session has no control socket (its owner already exited).", code="no_control")
    return str(control)


def _identity(record: Any) -> tuple[str, str | None]:
    if isinstance(record, dict):
        return str(record.get("id")), record.get("instance")
    return str(getattr(record, "id")), getattr(record, "instance", None)


async def _request(record: Any, operation: str, *, timeout: float = 10.0, **arguments: Any) -> Any:
    session_id, instance = _identity(record)
    payload = {"session": session_id, "instance": instance, "operation": operation, **arguments}
    try:
        return await transport.call(_endpoint(record), payload, timeout=timeout)
    except transport.TransportError as error:
        raise ControlError(str(error), code="unconfirmed") from error


async def snapshot(record: Any, *, cursor: Any = None, stream_cursor: Any = None) -> dict[str, Any]:
    extra: dict[str, Any] = {}
    if cursor is not None:
        extra["cursor"] = cursor
    if stream_cursor is not None:
        extra["stream_cursor"] = stream_cursor
    result = await _request(record, "snapshot", **extra)
    if not isinstance(result, dict):
        raise ControlError("The session returned no snapshot.", code="bad_reply")
    return result


async def send(record: Any, text: str) -> str:
    result = await _request(record, "input", text=text)
    return str(result or "")


async def set_paused(record: Any, paused: bool) -> str:
    result = await _request(record, "pause" if paused else "resume")
    return str(result or "")
