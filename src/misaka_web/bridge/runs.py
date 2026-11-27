"""Read models for research runs, plus the two mutations a phone may need.

The board is MISAKA's own sqlite store; its read models (runs.listing, runs.nodes,
views.syntheses) are imported rather than re-derived, so the UI keeps matching upstream when
the graph grows new concepts. The bridge never writes a session file, and the only board writes
here are the ones upstream already exposes as verbs (stop, limits).
"""

from __future__ import annotations

import json
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


def _session_ids_of(path: Any) -> set[str]:
    """Every id a transcript file answers to: its name, and the id in its header line.

    MISAKA names transcripts "<timestamp>_<id>.jsonl"; a hand-made or imported file may not.
    """
    ids: set[str] = set()
    name = os.path.basename(str(path or ""))
    stem = name[:-6] if name.endswith(".jsonl") else name
    if stem:
        ids.add(stem.rsplit("_", 1)[-1])
    try:
        with open(str(path), "r", encoding="utf-8", errors="replace") as handle:
            header = json.loads(handle.readline() or "{}")
        if isinstance(header, dict) and isinstance(header.get("id"), str):
            ids.add(header["id"])
    except (OSError, ValueError):
        pass
    return ids


def session_run_map() -> dict[str, dict[str, Any]]:
    """session id → the run (and node) whose conversation it is.

    The board is the only place that knows this: a node's Last Order session file is recorded
    per node, and the root conversation is the run's root_session.
    """
    try:
        modules = _research()
    except Exception:  # noqa: BLE001 - no MISAKA means no runs to map
        return {}
    runs, planner = modules["runs"], modules["planner"]
    mapping: dict[str, dict[str, Any]] = {}
    try:
        with connect() as con:
            for run in runs.listing(con):
                root = run.get("root_session")
                if root:
                    root_node = runs.root(con, run["id"])
                    root_id = root_node["id"] if root_node else None
                    for session_id in _session_ids_of(root):
                        mapping.setdefault(session_id, {"run_id": run["id"], "node_id": root_id})
                for node in runs.nodes(con, run["id"]):
                    paths = {node.get("session_file")}
                    try:
                        paths.add(planner.lo_session_file(run, node))
                    except Exception:  # noqa: BLE001
                        pass
                    for value in paths:
                        if not value:
                            continue
                        target = {"run_id": run["id"],
                                  "node_id": None if runs.is_root(node) else node["id"]}
                        for session_id in _session_ids_of(value):
                            mapping.setdefault(session_id, target)
    except Exception:  # noqa: BLE001 - a broken board must not hide the sessions
        return mapping
    return mapping


def run_for_session(session_id: str) -> dict[str, Any] | None:
    return session_run_map().get(session_id)


def workspace_missing(workspace: str | None) -> bool:
    return not workspace or not os.path.isdir(str(workspace))


def list_runs(*, include_hidden: bool = False) -> list[dict[str, Any]]:
    from . import hidden

    modules = _research()
    runs = modules["runs"]
    skipped = set() if include_hidden else hidden.ids("runs")
    with connect() as con:
        out = []
        for run in runs.listing(con):
            if run["id"] in skipped:
                continue
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
                # the project files may be gone (a deleted folder, a moved machine): the row
                # stays honest instead of 404-ing only when someone opens it
                "workspace_missing": workspace_missing(run.get("workspace")),
                "hidden": run["id"] in hidden.ids("runs") if include_hidden else False,
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
            "workspace_missing": workspace_missing(run.get("workspace")),
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

def resolve_file(run_id: str, path: str, *, node_id: str | None = None) -> str:
    """A file inside the run workspace, resolved and fenced; never outside it."""
    with connect() as con:
        run, modules = _load(con, run_id)
        workspace = os.path.realpath(run["workspace"])
        base = workspace
        if node_id:
            node = modules["runs"].node(con, node_id)
            if not node or node.get("run_id") != run_id:
                raise NodeNotFound(node_id)
            base = os.path.realpath(os.path.join(workspace, modules["runs"].node_dir(node_id)))
    target = os.path.realpath(os.path.join(base, str(path or "")))
    root = os.path.realpath(workspace)
    if target != root and not target.startswith(root + os.sep):
        raise ValueError(f"Path escapes the run workspace: {path}")
    if not os.path.isfile(target):
        raise FileNotFoundError(path)
    return target


def _final_manifest(workspace: str) -> dict[str, Any] | None:
    """The newest ``final/*-SOURCES.md``, or None when the run has not written one."""
    from . import sources as manifests

    final = os.path.join(workspace, "final")
    if not os.path.isdir(final):
        return None
    candidates = sorted(name for name in os.listdir(final) if name.endswith("-SOURCES.md"))
    if not candidates:
        return None
    return manifests.read_manifest_path(os.path.join(final, candidates[-1]))


def sources(run_id: str, *, node_id: str | None = None) -> dict[str, Any]:
    """The SOURCES manifest of one node, or of the run's final report when no node is named."""
    from . import sources as manifests

    final = ""
    candidates: list[str] = []
    root_folder: str | None = None
    workspace = ""
    with connect() as con:
        run, modules = _load(con, run_id)
        workspace = run["workspace"]
        if node_id:
            node = modules["runs"].node(con, node_id)
            if not node or node.get("run_id") != run_id:
                raise NodeNotFound(node_id)
            folder = os.path.join(workspace, modules["runs"].node_dir(node_id))
        else:
            folder = None
            final = os.path.join(workspace, "final")
            candidates = sorted(
                (name for name in os.listdir(final) if name.endswith("-SOURCES.md"))
                if os.path.isdir(final) else [],
            )
            root_node = modules["runs"].root(con, run_id)
            if root_node is not None:
                root_folder = os.path.join(workspace, modules["runs"].node_dir(root_node["id"]))
            if not candidates and not root_folder:
                raise FileNotFoundError("This run has no final SOURCES.md yet.")
    parsed = manifests.read_manifest(folder) if folder else None
    if parsed is None and folder is None and candidates:
        parsed = manifests.read_manifest_path(os.path.join(final, candidates[-1]))
    if parsed is None and folder is not None:
        # a node that never wrote its own list still has the run's final one
        parsed = _final_manifest(workspace)
    if parsed is None and folder is None and root_folder:
        # ...and the other way round: no final list yet, so the root node's list it is
        parsed = manifests.read_manifest(root_folder)
    if parsed is None:
        raise FileNotFoundError("This node has no SOURCES.md yet.")
    manifest_dir = os.path.dirname(parsed["path"])
    for source in parsed["sources"]:
        placed = os.path.join(manifest_dir, source["placed"])
        source["exists"] = os.path.isfile(placed)
        source["size"] = os.path.getsize(placed) if source["exists"] else None
    parsed["node_id"] = node_id
    return parsed