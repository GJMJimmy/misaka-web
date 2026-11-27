"""A web-side list of runs and sessions this server keeps out of sight.

A run or a session lives in MISAKA's own state, and this server never writes there: no upstream
API deletes a run, and editing the board or a session file by hand would break the invariant that
keeps the TUI authoritative. So "delete" in the browser means "stop showing it in this web UI",
recorded in the token directory and reversible at any time.
"""

from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import Any

KINDS = ("runs", "sessions")


def _path() -> Path:
    from .. import config

    return config.settings().token_file.parent / "hidden.json"


def load() -> dict[str, list[str]]:
    path = _path()
    empty: dict[str, list[str]] = {kind: [] for kind in KINDS}
    if not path.is_file():
        return empty
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return empty
    if not isinstance(raw, dict):
        return empty
    return {kind: [str(item) for item in (raw.get(kind) or []) if isinstance(item, str)] for kind in KINDS}


def _save(state: dict[str, list[str]]) -> None:
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    handle, temp = tempfile.mkstemp(dir=str(path.parent), prefix=".hidden-", suffix=".json")
    try:
        with os.fdopen(handle, "w", encoding="utf-8") as stream:
            json.dump(state, stream, ensure_ascii=False, indent=2)
        os.replace(temp, path)
    except BaseException:
        Path(temp).unlink(missing_ok=True)
        raise


def _check(kind: str) -> str:
    if kind not in KINDS:
        raise ValueError(f"Unknown list: {kind}")
    return kind


def ids(kind: str) -> set[str]:
    return set(load()[_check(kind)])


def hide(kind: str, item_id: str) -> dict[str, Any]:
    kind = _check(kind)
    clean = str(item_id or "").strip()
    if not clean:
        raise ValueError("An id is required")
    state = load()
    if clean not in state[kind]:
        state[kind].append(clean)
        _save(state)
    return {"ok": True, "kind": kind, "id": clean, "hidden": len(state[kind])}


def unhide(kind: str, item_id: str) -> dict[str, Any]:
    kind = _check(kind)
    clean = str(item_id or "").strip()
    state = load()
    if clean in state[kind]:
        state[kind] = [item for item in state[kind] if item != clean]
        _save(state)
    return {"ok": True, "kind": kind, "id": clean, "hidden": len(state[kind])}


def hide_many(kind: str, item_ids: list[str]) -> dict[str, Any]:
    kind = _check(kind)
    state = load()
    added = 0
    for item in item_ids:
        clean = str(item or "").strip()
        if clean and clean not in state[kind]:
            state[kind].append(clean)
            added += 1
    if added:
        _save(state)
    return {"ok": True, "kind": kind, "added": added, "hidden": len(state[kind])}
