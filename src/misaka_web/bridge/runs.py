"""Read models for research runs, plus the two mutations a phone may need.

The board is MISAKA's own sqlite store; its read models (runs.listing, runs.nodes,
views.syntheses) are imported rather than re-derived, so the UI keeps matching upstream when
the graph grows new concepts. The bridge never writes a session file, and the only board writes
here are the ones upstream already exposes as verbs (stop, limits).
"""

from __future__ import annotations

import os
import sqlite3
from contextlib import contextmanager
from typing import Any, Iterator

from .. import config
from . import catalog


class BoardUnavailable(RuntimeError):
    """MISAKA or its board is missing; sessions still work without it."""


class RunNotFound(KeyError):
    pass


class NodeNotFound(KeyError):
    pass


def _research() -> dict[str, Any]:
    try:
        from misaka.core.platform import tasks as task_store
        from misaka.core.research import planner, runs, views
    except Exception as error:  # noqa: BLE001 - any import failure means the board cannot be read
        raise BoardUnavailable(
            "Reading research runs needs MISAKA in this environment (pip install 'misaka[providers]'): "
            + (str(error) or error.__class__.__name__)
        ) from error
    return {"planner": planner, "runs": runs, "views": views, "task_store": task_store}


def board_path() -> str:
    return str(config.misaka_home() / "state" / "board.db")


@contextmanager
def connect() -> Iterator[sqlite3.Connection]:
    path = board_path()
    if not os.path.isfile(path):
        raise BoardUnavailable(f"No research board yet at {path} (start a run first).")
    try:
        from misaka.core.platform import tasks as task_store

        con = task_store.connect(path)
    except Exception:  # noqa: BLE001 - plain sqlite can still read a board MISAKA made
        con = sqlite3.connect(path, timeout=10)
    con.row_factory = sqlite3.Row
    try:
        con.execute("PRAGMA busy_timeout=5000")
        yield con
    finally:
        con.close()


def _load(con: sqlite3.Connection, run_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
    modules = _research()
    run = modules["runs"].get(con, run_id)
    if not run:
        raise RunNotFound(run_id)
    return run, modules


def _listening(planner: Any, run: dict[str, Any], node: dict[str, Any]) -> catalog.SessionRecord | None:
    """The catalog record of the node's Last Order, when that conversation is still attached."""
    try:
        path = planner.lo_session_file(run, node)
    except Exception:  # noqa: BLE001 - a node without a window simply is not listening
        return None
    if not path:
        return None
    record = catalog.find_path(path)
    return record if record is not None and record.has_control else None


def _node_rows(con: sqlite3.Connection, modules: dict[str, Any], run: dict[str, Any]) -> list[dict[str, Any]]:
    runs, views, planner = modules["runs"], modules["views"], modules["planner"]
    rows = []
    for node in runs.nodes(con, run["id"]):
        rows.append({
            "id": node["id"],
            "question": node.get("question"),
            "depth": int(node.get("depth") or 0),
            "status": node.get("status"),
            "kind": views.kind(con, node),
            "session_file": node.get("session_file"),
            "listening": bool(_listening(planner, run, node)),
            "last_error": node.get("last_error"),
            "created_at": node.get("created_at"),
            "syntheses": len(views.syntheses(con, run, node)),
        })
    return rows


def list_runs() -> list[dict[str, Any]]:
    modules = _research()
    runs = modules["runs"]
    with connect() as con:
        out = []
        for run in runs.listing(con):
            nodes = runs.nodes(con, run["id"])
            out.append({
                "id": run["id"],
                "question": run["question"],
                "workspace": run["workspace"],
                "status": run["status"],
                "phase": run.get("phase"),
                "stop_requested": bool(run.get("stop_requested")),
                "driver_active": bool(run.get("driver_lock")),
                "node_count": len(nodes),
                "awaiting_approval": sum(1 for node in nodes if node.get("status") == "awaiting_approval"),
                "created_at": run.get("created_at"),
                "updated_at": run.get("updated_at"),
                "last_error": run.get("last_error"),
            })
        return out


def run_detail(run_id: str) -> dict[str, Any]:
    with connect() as con:
        run, modules = _load(con, run_id)
        runs, views = modules["runs"], modules["views"]
        nodes = _node_rows(con, modules, run)
        products = [
            {"kind": row["kind"], "title": row["title"], "path": row["path"]}
            for row in runs.artifacts(con, run_id, run_level=True)
        ]
        return {
            "id": run["id"],
            "question": run["question"],
            "workspace": run["workspace"],
            "status": run["status"],
            "phase": run.get("phase"),
            "limits": runs.limits(run),
            "stop_requested": bool(run.get("stop_requested")),
            "driver_active": bool(run.get("driver_lock")),
            "created_at": run.get("created_at"),
            "updated_at": run.get("updated_at"),
            "last_error": run.get("last_error"),
            "node_count": len(nodes),
            "awaiting_approval": sum(1 for node in nodes if node.get("status") == "awaiting_approval"),
            "nodes": nodes,
            "products": products,
            "process": _process(run_id),
            "dissolving": [node["id"] for node in views.dissolving_nodes(con, run)],
        }


def node_detail(run_id: str, node_id: str) -> dict[str, Any]:
    with connect() as con:
        run, modules = _load(con, run_id)
        runs, views = modules["runs"], modules["views"]
        node = runs.node(con, node_id)
        if not node or node.get("run_id") != run_id:
            raise NodeNotFound(node_id)
        tasks = [
            {
                "id": row["id"],
                "title": row.get("title"),
                "status": row.get("status"),
                "assignee": row.get("assignee"),
                "kind": row.get("kind"),
                "round": row.get("round"),
                "updated_at": row.get("updated_at"),
            }
            for row in runs.tasks(con, run_id, node_id=node_id)
        ]
        artifacts = [
            {"kind": row["kind"], "title": row["title"], "path": row["path"], "created_at": row["created_at"]}
            for row in runs.artifacts(con, run_id, branch_id=node_id)
        ]
        syntheses = [
            {"path": row["path"], "title": row["title"], "created_at": row["created_at"]}
            for row in views.syntheses(con, run, node)
        ]
        return {
            "id": node["id"],
            "run_id": run_id,
            "question": node.get("question"),
            "depth": int(node.get("depth") or 0),
            "status": node.get("status"),
            "kind": views.kind(con, node),
            "session_file": node.get("session_file"),
            "listening": bool(_listening(modules["planner"], run, node)),
            "last_error": node.get("last_error"),
            "tasks": tasks,
            "artifacts": artifacts,
            "syntheses": syntheses,
            "files": node_files(run, node),
        }


def _process(run_id: str) -> dict[str, Any] | None:
    """What this bridge knows about the run process it started, if it started one."""
    from . import supervisor

    return supervisor.info(run_id)


def node_files(run: dict[str, Any], node: dict[str, Any]) -> list[dict[str, Any]]:
    """Markdown a node owns on disk: plan, cards, synthesis versions, SOURCES."""
    runs = _research()["runs"]
    folder = os.path.join(run["workspace"], runs.node_dir(node["id"]))
    if not os.path.isdir(folder):
        return []
    files = []
    for dirpath, _dirs, names in os.walk(folder):
        for name in sorted(names):
            if not name.lower().endswith((".md", ".txt")):
                continue
            full = os.path.join(dirpath, name)
            relative = os.path.relpath(full, folder).replace(os.sep, "/")
            try:
                stamp = os.path.getmtime(full)
                size = os.path.getsize(full)
            except OSError:
                continue
            files.append({"name": relative, "size": size, "mtime": stamp})
    return sorted(files, key=lambda item: (item["name"].count("/"), item["name"]))


def read_node_file(run_id: str, node_id: str, name: str) -> dict[str, Any]:
    with connect() as con:
        run, modules = _load(con, run_id)
        node = modules["runs"].node(con, node_id)
        if not node or node.get("run_id") != run_id:
            raise NodeNotFound(node_id)
        folder = os.path.join(run["workspace"], modules["runs"].node_dir(node_id))
    root = os.path.realpath(folder)
    target = os.path.realpath(os.path.join(root, name))
    if target != root and not target.startswith(root + os.sep):
        raise ValueError(f"Path escapes the node folder: {name}")
    if not os.path.isfile(target):
        raise FileNotFoundError(name)
    with open(target, "r", encoding="utf-8", errors="replace") as handle:
        return {"name": name, "text": handle.read()}


async def tell(run_id: str, node_id: str | None, text: str) -> dict[str, Any]:
    """Say something to a node's Last Order: the same channel as misaka chat --attach."""
    from . import control

    body = (text or "").strip()
    if not body:
        raise ValueError("Say what to tell the run.")
    with connect() as con:
        run, modules = _load(con, run_id)
        runs = modules["runs"]
        every = runs.nodes(con, run_id)
        if not every:
            raise ValueError(f"Research run {run_id} has no nodes yet.")
        target = next((row for row in every if (row["id"] == node_id if node_id else runs.is_root(row))), None)
        if target is None:
            raise ValueError(f"Research run {run_id} has no node {node_id}.")
        listening = [(row, _listening(modules["planner"], run, row)) for row in every]
        listening = [(row, record) for row, record in listening if record]
        record = next((rec for row, rec in listening if row["id"] == target["id"]), None)
        if record is None:
            who = "; ".join(f"{row['id']} (depth {row['depth']})" for row, _rec in listening) or "nobody"
            raise ValueError(
                f"The Last Order of node {target['id']} is not running now ({target.get('status')}). "
                f"Listening now: {who}"
            )
    from . import control as control_module

    try:
        await control_module.send(record, body)
    except control_module.ControlError as error:
        raise ValueError(f"Delivery to node {target['id']} is unconfirmed: {error}") from error
    return {"ok": True, "node_id": target["id"], "session_id": record.id}


def request_stop(run_id: str) -> dict[str, Any]:
    modules = _research()
    runs, task_store = modules["runs"], modules["task_store"]
    with connect() as con:
        _load(con, run_id)
        with task_store.write_txn(con):
            runs.request_stop(con, run_id)
    return {"ok": True, "status": "stopping"}


def update_limits(run_id: str, changes: dict[str, Any]) -> dict[str, Any]:
    modules = _research()
    runs = modules["runs"]
    with connect() as con:
        _load(con, run_id)
        before, after = runs.update_limits(con, run_id, changes)
    return {"ok": True, "before": before, "after": after}