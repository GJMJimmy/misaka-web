"""Run processes this bridge started, so a phone can start, watch and stop them.

Nothing here reimplements the workflow: the child IS ``misaka research``. The bridge only owns
argv, cwd, the log file and the PID, and discovers the run id the child commits to the board.
"""

from __future__ import annotations

import json
import os
import shlex
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

from . import runs as board

POLL_SECONDS = 0.5
DISCOVER_TIMEOUT = 25.0
LOG_LINES = 400


class SupervisorError(RuntimeError):
    pass


def state_path() -> Path:
    from .. import config

    return config.settings().token_file.parent / "runs.json"


def log_dir() -> Path:
    from .. import config

    return config.settings().token_file.parent / "runs"


def workspace_root() -> Path:
    """Where a user may start research from; everything outside it is refused."""
    override = os.environ.get("MISAKA_WEB_WORKSPACE_ROOT")
    if override:
        return Path(override).expanduser().resolve()
    documents = Path(os.path.expanduser("~")) / "Documents"
    return (documents if documents.is_dir() else Path(os.path.expanduser("~"))).resolve()


def check_workspace(value: str | None, *, create: bool = False) -> tuple[str, bool]:
    """Resolve a workspace inside the allowlist. With create, a missing folder is made.

    Starting a run may create its folder (one less reason to open an SSH session); resuming an
    existing run may not, because its folder disappearing is a fact worth reporting.
    """
    root = workspace_root()
    if not value:
        return str(root), False
    path = Path(str(value)).expanduser()
    if not path.is_absolute():
        path = root / path
    resolved = path.resolve()
    if resolved != root and root not in resolved.parents:
        raise SupervisorError(f"A workspace must live under {root}; refused: {resolved}")
    if resolved.is_dir():
        return str(resolved), False
    if resolved.exists():
        raise SupervisorError(f"{resolved} exists and is not a folder.")
    if not create:
        raise SupervisorError(f"A research project folder must already exist: {resolved}")
    try:
        resolved.mkdir(parents=True)
    except OSError as error:
        raise SupervisorError(f"Could not create {resolved}: {error}") from error
    return str(resolved), True


def research_command() -> list[str]:
    """How to invoke the workflow: the installed CLI, or an override for tests."""
    override = os.environ.get("MISAKA_WEB_RESEARCH_CMD")
    if override:
        return shlex.split(override)
    binary = os.environ.get("MISAKA_WEB_MISAKA_BIN")
    if binary:
        return [binary, "research"]
    return [sys.executable, "-m", "misaka", "research"]


LIMIT_FLAGS = {
    "max_depth": "--depth",
    "parallel": "--parallel",
    "sister_parallel": "--sister-parallel",
    "max_followups": "--followups",
    "max_revisions": "--revisions",
    "max_nodes": "--max-nodes",
}


def _limit_args(limits: dict[str, Any] | None) -> list[str]:
    args: list[str] = []
    for key, flag in LIMIT_FLAGS.items():
        value = (limits or {}).get(key)
        if value is None:
            continue
        if isinstance(value, bool) or not isinstance(value, int):
            raise SupervisorError(f"{key} must be a whole number")
        args.extend([flag, str(value)])
    return args


def _load_state() -> dict[str, dict[str, Any]]:
    path = state_path()
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


def _save_state(state: dict[str, dict[str, Any]]) -> None:
    path = state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    os.replace(temp, path)
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass


def alive(pid: int | None, started_at: float | None = None) -> bool:
    if not pid:
        return False
    try:
        import psutil
    except Exception:  # noqa: BLE001 - without psutil we can only guess
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    try:
        process = psutil.Process(pid)
    except Exception:  # noqa: BLE001
        return False
    if started_at:
        try:
            if abs(process.create_time() - started_at) > 5:
                return False
        except Exception:  # noqa: BLE001
            pass
    return process.is_running() and process.status() != psutil.STATUS_ZOMBIE


def _spawn(argv: list[str], *, cwd: str, log_file: Path) -> subprocess.Popen:
    log_file.parent.mkdir(parents=True, exist_ok=True)
    handle = open(log_file, "ab", buffering=0)
    kwargs: dict[str, Any] = {"cwd": cwd, "stdout": handle, "stderr": subprocess.STDOUT, "stdin": subprocess.DEVNULL}
    if os.name == "posix":
        kwargs["start_new_session"] = True
    else:
        kwargs["creationflags"] = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    try:
        return subprocess.Popen(argv, **kwargs)
    finally:
        handle.close()


def _record(run_id: str, *, pid: int, argv: list[str], workspace: str, kind: str, log_file: Path) -> dict[str, Any]:
    entry = {
        "run_id": run_id,
        "pid": pid,
        "argv": argv,
        "workspace": workspace,
        "kind": kind,
        "log": str(log_file),
        "started_at": time.time(),
    }
    state = _load_state()
    state[run_id] = entry
    _save_state(state)
    return entry


def info(run_id: str) -> dict[str, Any] | None:
    entry = _load_state().get(run_id)
    if not entry:
        return None
    return {**entry, "alive": alive(entry.get("pid"), entry.get("started_at"))}


def managed(run_id: str) -> bool:
    return run_id in _load_state()


def log_tail(run_id: str, *, lines: int = LOG_LINES) -> dict[str, Any]:
    entry = _load_state().get(run_id)
    if not entry:
        raise SupervisorError(f"This bridge did not start run {run_id}; no log is held for it.")
    path = Path(entry["log"])
    if not path.is_file():
        return {"path": str(path), "text": ""}
    with open(path, "rb") as handle:
        handle.seek(0, os.SEEK_END)
        size = handle.tell()
        window = min(size, 200_000)
        handle.seek(size - window)
        blob = handle.read().decode("utf-8", errors="replace")
    kept = blob.splitlines()[-max(1, min(int(lines), 2000)):]
    return {"path": str(path), "text": "\n".join(kept)}


def _await_run_id(*, workspace: str, question: str, since: float) -> str | None:
    deadline = time.monotonic() + DISCOVER_TIMEOUT
    while time.monotonic() < deadline:
        try:
            for run in board.list_runs():
                if run["workspace"] != workspace:
                    continue
                if run["question"].strip() != question.strip():
                    continue
                if float(run.get("created_at") or 0) >= since - 5:
                    return str(run["id"])
        except Exception:  # noqa: BLE001 - the board may not be readable yet
            pass
        time.sleep(POLL_SECONDS)
    return None


def start(*, workspace: str, question: str, limits: dict[str, Any] | None = None, diagnostics: bool = False) -> dict[str, Any]:
    text = (question or "").strip()
    if len(text) < 2:
        raise SupervisorError("A research question is required.")
    folder, created = check_workspace(workspace, create=True)
    argv = [*research_command(), text, *_limit_args(limits)]
    if diagnostics:
        argv.append("--diagnostics")
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
    log_file = log_dir() / f"new-{stamp}-{os.getpid()}.log"
    since = time.time()
    process = _spawn(argv, cwd=folder, log_file=log_file)
    run_id = _await_run_id(workspace=folder, question=text, since=since)
    if run_id:
        _record(run_id, pid=process.pid, argv=argv, workspace=folder, kind="new", log_file=log_file)
    return {"pid": process.pid, "run_id": run_id, "workspace": folder, "log": str(log_file), "argv": argv,
            "workspace_created": created}


def resume(run_id: str) -> dict[str, Any]:
    detail = board.run_detail(run_id)
    folder, _created = check_workspace(detail["workspace"])
    argv = [*research_command(), "--resume", run_id]
    stamp = time.strftime("%Y%m%d-%H%M%S", time.localtime())
    log_file = log_dir() / f"resume-{run_id}-{stamp}.log"
    process = _spawn(argv, cwd=folder, log_file=log_file)
    entry = _record(run_id, pid=process.pid, argv=argv, workspace=folder, kind="resume", log_file=log_file)
    return {**entry, "alive": True}


def terminate(run_id: str) -> dict[str, Any]:
    entry = _load_state().get(run_id)
    if not entry:
        raise SupervisorError(f"No process of this bridge is attached to run {run_id}.")
    pid = int(entry.get("pid") or 0)
    if not alive(pid, entry.get("started_at")):
        return {"ok": True, "pid": pid, "already_stopped": True}
    try:
        import psutil

        process = psutil.Process(pid)
        for child in process.children(recursive=True):
            child.terminate()
        process.terminate()
        try:
            process.wait(timeout=10)
        except Exception:  # noqa: BLE001
            process.kill()
    except Exception as error:  # noqa: BLE001
        raise SupervisorError(f"Could not stop pid {pid}: {error}") from error
    return {"ok": True, "pid": pid, "already_stopped": False}