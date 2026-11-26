"""Small helpers shared by the tests."""

from __future__ import annotations

import json
from pathlib import Path


def write_record(home: Path, *, session_id: str, control: str | None, role: str = "last-order", cwd: str = "/research") -> Path:
    directory = home / "state" / "sessions" / ".catalog"
    directory.mkdir(parents=True, exist_ok=True)
    record = {
        "id": session_id,
        "instance": f"inst-{session_id}",
        "control": control,
        "path": None,
        "role": role,
        "cwd": cwd,
        "pid": 4242,
    }
    path = directory / f"{session_id}.json"
    path.write_text(json.dumps(record), encoding="utf-8")
    return path
