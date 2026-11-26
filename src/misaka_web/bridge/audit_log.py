"""Read back the audit trail this bridge writes: one JSON line per write action."""

from __future__ import annotations

import json
import os
from typing import Any

from .. import audit, config


def tail(*, limit: int = 100, action: str | None = None) -> dict[str, Any]:
    """Newest first. A trailing partial line (a crash mid-write) is skipped, not fatal."""
    path = audit.audit_path()
    if not os.path.isfile(path):
        return {"path": str(path), "entries": [], "total": 0}
    with open(path, "rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        window = min(size, 512_000)
        handle.seek(size - window)
        blob = handle.read().decode("utf-8", errors="replace")
    lines = blob.splitlines()
    if window < size and lines:
        lines = lines[1:]  # the first line may be cut by the window
    entries: list[dict[str, Any]] = []
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        if not isinstance(entry, dict):
            continue
        if action and entry.get("action") != action:
            continue
        entries.append(entry)
    total = len(entries)
    newest = list(reversed(entries))[: max(1, min(int(limit), 1000))]
    return {"path": str(path), "entries": newest, "total": total}
