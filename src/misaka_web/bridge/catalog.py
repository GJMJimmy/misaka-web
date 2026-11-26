"""Session discovery from MISAKA's catalog index, without importing MISAKA.

Each live session writes <sessions_root>/.catalog/<sha256(realpath)>.json holding the session
id, transcript path, control socket, instance fence and role. Reading those files is the whole
discovery story, so the bridge works even when MISAKA is not installed in this interpreter.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .. import config


class UnknownSession(KeyError):
    pass


@dataclass(frozen=True)
class SessionRecord:
    id: str
    instance: str | None
    control: str | None
    path: str | None
    role: str
    cwd: str | None
    title: str | None
    pid: int | None
    mtime: float | None

    @property
    def has_control(self) -> bool:
        return bool(self.control) and os.path.exists(str(self.control))

    def as_api(self) -> dict[str, Any]:
        live = self.has_control
        return {
            "id": self.id,
            "role": self.role,
            "cwd": self.cwd,
            "state": "live" if live else "saved",
            "title": self.title,
            "has_control": live,
            "last_activity": _iso(self.mtime),
        }


def _iso(mtime: float | None) -> str | None:
    if not mtime:
        return None
    import datetime

    return datetime.datetime.fromtimestamp(mtime, tz=datetime.timezone.utc).isoformat()


def _role(value: Any) -> str:
    name = str(value or "unknown").rsplit("/", 1)[-1]
    return "last-order" if name == "last_order" else name


def _record_from_json(value: dict[str, Any], *, mtime: float | None) -> SessionRecord | None:
    session_id = value.get("id")
    if not session_id:
        return None
    path = value.get("path")
    transcript = str(path) if path else None
    if transcript and not os.path.isabs(transcript):
        transcript = str(config.misaka_home() / transcript)
    stamp = mtime
    if transcript and os.path.exists(transcript):
        try:
            stamp = os.path.getmtime(transcript)
        except OSError:
            pass
    return SessionRecord(
        id=str(session_id),
        instance=value.get("instance"),
        control=value.get("control") or None,
        path=transcript,
        role=_role(value.get("role")),
        cwd=value.get("cwd") or None,
        title=value.get("title") or value.get("name") or None,
        pid=value.get("pid") if isinstance(value.get("pid"), int) else None,
        mtime=stamp,
    )


def catalog_dir() -> Path:
    return config.sessions_root() / ".catalog"


def load_records() -> list[SessionRecord]:
    directory = catalog_dir()
    if not directory.is_dir():
        return []
    records: dict[str, SessionRecord] = {}
    for file in sorted(directory.glob("*.json")):
        try:
            value = json.loads(file.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(value, dict):
            continue
        try:
            stamp = file.stat().st_mtime
        except OSError:
            stamp = None
        record = _record_from_json(value, mtime=stamp)
        if record is None:
            continue
        previous = records.get(record.id)
        if previous is None or (record.mtime or 0) >= (previous.mtime or 0):
            records[record.id] = record
    return sorted(records.values(), key=lambda item: item.mtime or 0, reverse=True)


def find_path(path: str | None) -> SessionRecord | None:
    """The record whose transcript is this file, comparing real paths."""
    if not path:
        return None
    target = os.path.realpath(str(path))
    for record in load_records():
        if record.path and os.path.realpath(record.path) == target:
            return record
    return None


def find(session_id: str) -> SessionRecord | None:
    for record in load_records():
        if record.id == session_id:
            return record
    return None


def require(session_id: str) -> SessionRecord:
    record = find(session_id)
    if record is None:
        raise UnknownSession(session_id)
    return record