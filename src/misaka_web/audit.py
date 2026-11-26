"""One line per write action, so a phone cannot change a run invisibly."""

from __future__ import annotations

import datetime
import json
import os
from typing import Any

from . import config


def audit_path():
    return config.settings().token_file.parent / "audit.jsonl"


def record(action: str, **detail: Any) -> None:
    """Append one JSON line; never let a logging failure break the action itself."""
    entry = {
        "at": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "action": action,
        **detail,
    }
    try:
        path = audit_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        new = not path.exists()
        with open(path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry, ensure_ascii=False, default=str) + "\n")
        if new:
            os.chmod(path, 0o600)
    except OSError:
        return
