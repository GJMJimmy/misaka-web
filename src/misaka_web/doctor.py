"""misaka-web doctor: every pre-flight check a deploy gets wrong at least once."""

from __future__ import annotations

import os
import sqlite3
import sys
from pathlib import Path
from typing import Any

from . import __version__, config


def _check(name: str, ok: bool | None, detail: str, *, fatal: bool = True) -> dict[str, Any]:
    return {"name": name, "ok": ok, "detail": detail, "fatal": fatal}


def run_checks() -> list[dict[str, Any]]:
    settings = config.settings()
    checks: list[dict[str, Any]] = []
    # Terminal: the phone's way to run commands without SSH.
    try:
        from .bridge import pty as terminal_bridge

        if terminal_bridge.pty_available():
            checks.append(("terminal", "ok", "PTY available: shell, misaka chat, panel and attach all work"))
        else:
            checks.append(("terminal", "warn",
                           "no POSIX PTY on this host: only the shell profile runs (no TUI). "
                           "Run the web UI on Linux or macOS for the full terminal"))
    except Exception as error:  # noqa: BLE001
        checks.append(("terminal", "warn", f"terminal bridge unavailable: {error}"))

    token = config.read_token()
    checks.append(_check("token", bool(token), str(settings.token_file) if token else f"missing: {settings.token_file}"))
    if token:
        try:
            mode = oct(settings.token_file.stat().st_mode & 0o777)
        except OSError:
            mode = "unknown"
        checks.append(_check("token mode", mode in {"0o600", "0o400"}, mode, fatal=False))

    # 这个服务必须和研究账号共用 ~/.misaka；用 root 跑是最常见的一次性错误。
    home = os.path.expanduser("~")
    is_root = hasattr(os, "geteuid") and os.geteuid() == 0
    if is_root:
        checks.append(_check(
            "account",
            False,
            f"running as root (HOME={home}): MISAKA sessions, credentials and ~/.misaka belong to the research account. "
            "Reinstall and run as that user, or set User= in the systemd unit to it.",
            fatal=False,
        ))
    else:
        try:
            import getpass

            who = getpass.getuser()
        except Exception:  # noqa: BLE001 - some containers have no passwd entry
            who = "unknown user"
        checks.append(_check("account", True, f"{who} (HOME={home})", fatal=False))

    static = settings.static_dir / "index.html"
    checks.append(_check("ui build", static.is_file(), str(static) if static.is_file() else f"no build at {static}; run scripts/sync-web.sh"))

    try:
        import misaka  # type: ignore[import-not-found]  # noqa: F401
        from .bridge import runs as board

        checks.append(_check("misaka package", True, "importable in this interpreter"))
        path = board.board_path()
        exists = Path(path).is_file()
        checks.append(_check("research board", exists, path if exists else f"no board yet at {path}", fatal=False))
        if exists:
            try:
                con = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
                try:
                    version = con.execute("PRAGMA user_version").fetchone()[0]
                finally:
                    con.close()
                checks.append(_check("board readable", True, f"user_version={version}", fatal=False))
            except sqlite3.Error as error:
                checks.append(_check("board readable", False, str(error), fatal=False))
    except Exception as error:  # noqa: BLE001 - the whole research surface is unavailable
        checks.append(_check("misaka package", False, f"{error} (pip install 'misaka[providers]' in this venv)"))

    from .bridge import catalog

    records = catalog.load_records()
    checks.append(_check("session catalog", catalog.catalog_dir().is_dir(), f"{len(records)} record(s) under {catalog.catalog_dir()}", fatal=False))

    import tempfile

    parent = tempfile.gettempdir() if sys.platform == "win32" else "/tmp"
    try:
        names = os.listdir(parent)
    except OSError as error:
        names = []
        checks.append(_check("control sockets", False, f"{parent} unreadable: {error}"))
    if names or not any(c["name"] == "control sockets" for c in checks):
        visible = any(str(name).startswith("misaka-session-") for name in names)
        detail = f"{parent} " + ("holds live misaka-session-* directories" if visible else "is readable but holds no live control socket now")
        if not visible:
            detail += "; if a session IS running, this process cannot see it (systemd PrivateTmp=yes does exactly this)"
        checks.append(_check("control sockets", True if visible else None, detail, fatal=False))

    from .bridge import supervisor

    try:
        root = supervisor.workspace_root()
        checks.append(_check("workspace root", root.is_dir(), str(root)))
    except Exception as error:  # noqa: BLE001
        checks.append(_check("workspace root", False, str(error)))
    state = supervisor.state_path()
    checks.append(_check("run ledger", True, str(state) if state.is_file() else f"empty (no run started from here yet): {state}", fatal=False))

    checks.append(_check("version", True, f"misaka-web {__version__}", fatal=False))
    return checks


def main() -> int:
    checks = run_checks()
    width = max(len(check["name"]) for check in checks)
    failures = 0
    for check in checks:
        # FAIL only for what blocks a deploy; a non-fatal miss is a warning, not a failure.
        if check["ok"] is False and check["fatal"]:
            mark = "FAIL"
            failures += 1
        elif check["ok"] is False:
            mark = "warn"
        elif check["ok"] is None:
            mark = "warn"
        else:
            mark = "ok  "
        print(f"[{mark}] {check['name'].ljust(width)}  {check['detail']}")
    print("")
    print("All fatal checks passed." if failures == 0 else f"{failures} fatal check(s) failed.")
    return 0 if failures == 0 else 1