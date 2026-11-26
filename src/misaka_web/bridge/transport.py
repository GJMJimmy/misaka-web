"""One newline-delimited JSON request/response over a MISAKA local socket.

Upstream MISAKA opens these sockets itself (AF_UNIX on POSIX, a named pipe on Windows) and
exposes the client through misaka.utils.local_socket; when that module is importable we reuse
it verbatim so the Windows named-pipe path keeps working. Without MISAKA installed we fall
back to AF_UNIX, which is all a Linux server needs.
"""

from __future__ import annotations

import asyncio
import json
from typing import Any


class TransportError(RuntimeError):
    """The socket could not be opened, or the peer closed it without a reply."""


async def _open(path: str, *, limit: int = 1024 * 1024):
    try:
        from misaka.utils import local_socket  # type: ignore[import-not-found]
    except Exception:
        local_socket = None
    if local_socket is not None:
        return await local_socket.open_connection(path, limit=limit)
    try:
        return await asyncio.open_unix_connection(path, limit=limit)
    except AttributeError as error:  # Windows without MISAKA installed
        raise TransportError("local sockets need MISAKA on this platform") from error


async def call(path: str, payload: dict[str, Any], *, timeout: float = 10.0) -> Any:
    """Send exactly one command and return its result. Never retried: an uncertain write stays uncertain."""
    body = (json.dumps(payload) + "\n").encode()
    try:
        async with asyncio.timeout(timeout):
            reader, writer = await _open(path)
            try:
                writer.write(body)
                await writer.drain()
                line = await reader.read()
            finally:
                writer.close()
                try:
                    await writer.wait_closed()
                except (ConnectionError, OSError):
                    pass
    except TimeoutError as error:
        raise TransportError("no reply before the timeout; delivery is unconfirmed") from error
    except (ConnectionError, OSError) as error:
        raise TransportError(str(error) or "the local socket could not be reached") from error
    if not line:
        raise TransportError("the session disconnected; delivery is unconfirmed. Do not resend automatically.")
    try:
        reply = json.loads(line)
    except ValueError as error:
        raise TransportError(f"unreadable reply: {error}") from error
    if not isinstance(reply, dict) or "ok" not in reply:
        raise TransportError("the peer sent no acknowledgement")
    if not reply["ok"]:
        raise TransportError(str(reply.get("error") or "the session refused the command"))
    return reply.get("result")
