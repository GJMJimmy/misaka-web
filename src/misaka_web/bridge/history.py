"""Read a finished session from its transcript: the control socket is gone, the history is not."""

from __future__ import annotations

import json
import os
from typing import Any


class HistoryUnavailable(RuntimeError):
    """No transcript on disk for this record."""


def read_entries(path: str) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
    """The session header and the entries that follow it, tolerant of a broken line."""
    if not path or not os.path.isfile(path):
        raise HistoryUnavailable("No transcript on disk for this session: " + (path or "no path recorded"))
    header: dict[str, Any] | None = None
    entries: list[dict[str, Any]] = []
    with open(path, "r", encoding="utf-8", errors="replace") as handle:
        for line in handle:
            line = line.strip()
            if not line:
                continue
            try:
                value = json.loads(line)
            except ValueError:
                continue
            if not isinstance(value, dict):
                continue
            if value.get("type") == "session":
                header = value
                continue
            entries.append(value)
    return header, entries


def context_entries(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The view the live snapshot gives: leaf path after the latest compaction boundary."""
    try:
        from misaka.core.session_manager import buildContextEntries
    except Exception:  # noqa: BLE001
        return entries
    try:
        return list(buildContextEntries(entries))
    except Exception:  # noqa: BLE001
        return entries


def saved_snapshot(record: Any) -> dict[str, Any]:
    path = record.get("path") if isinstance(record, dict) else getattr(record, "path", None)
    session_id = record.get("id") if isinstance(record, dict) else getattr(record, "id", None)
    cwd = record.get("cwd") if isinstance(record, dict) else getattr(record, "cwd", None)
    header, entries = read_entries(str(path or ""))
    return {
        "id": session_id,
        "cwd": (header or {}).get("cwd") or cwd,
        "state": "idle",
        "paused": False,
        "error": "",
        "workflow": None,
        "streaming": None,
        "entries": context_entries(entries),
        "cursor": None,
        "stream_cursor": None,
        "read_only": True,
    }