"""Slash commands typed into the web chat box, answered by the bridge instead of the model.

The TUI parses /research, /model and friends in its input loop; a browser has no input loop, so
a leading slash would otherwise reach the model as plain text. This module implements the small
whitelist the phone needs and answers with structure (lines + an optional place to go), never by
forwarding the text.
"""

from __future__ import annotations

import shlex
from typing import Any

from . import catalog, console, runs as board, supervisor

LIMIT_FLAGS = {
    "--depth": "max_depth",
    "--parallel": "parallel",
    "--sister-parallel": "sister_parallel",
    "--followups": "max_followups",
    "--revisions": "max_revisions",
    "--max-nodes": "max_nodes",
}

SUPPORTED = (
    "/help",
    "/research status [RUN_ID]",
    "/research stop [RUN_ID]",
    "/research resume [RUN_ID]",
    "/research limits [RUN_ID] --sister-parallel 2 …",
    "/research tell [RUN_ID] [--to NODE_ID] MESSAGE",
    "/sister ID",
    "/model",
    "/board",
)

HINTS = {
    "/read": "精读工作台还没上手机；先到终端里用 /read。",
    "/mcp": "MCP 管理还没上手机；到终端里用 /mcp。",
    "/share": "会话分享还没上手机；到终端里用 /share。",
    "/export": "导出还没有；终端里用 /export。",
    "/compact": "上下文压缩由上游自动触发；手动 /compact 还没上手机。",
    "/login": "在「设置 → 模型与密钥」里配 provider 与 key。",
    "/model": "用 /model 看当前默认，或在「设置 → 模型与密钥」里改。",
    "/create": "在「设置 → Sisters」里新建。",
    "/remove": "在「设置 → Sisters」里删除。",
    "/commit": "提交还在终端里做：/commit。",
    "/skill": "技能管理还没上手机。",
    "/quit": "关掉标签页就行。",
}


class CommandError(ValueError):
    """A refusal meant for the person typing."""


def _result(command: str, *, title: str, lines: list[str], navigate: str | None = None,
            data: Any = None, ok: bool = True) -> dict[str, Any]:
    return {"ok": ok, "command": command, "title": title, "lines": lines, "navigate": navigate, "data": data}


def help_lines() -> list[str]:
    return ["web 端支持这些命令：", *SUPPORTED, "", "其它命令会告诉你去哪儿做同一件事。"]


def _latest_run(run_id: str | None) -> dict[str, Any]:
    if run_id:
        try:
            return board.run_detail(run_id)
        except board.RunNotFound as error:
            raise CommandError(f"没有这个 run：{run_id}") from error
    every = board.list_runs()
    if not every:
        raise CommandError("还没有任何研究运行；先「新建研究」。")
    return board.run_detail(every[0]["id"])


def _status(run: dict[str, Any]) -> dict[str, Any]:
    nodes = run.get("nodes") or []
    pending = [node for node in nodes if node.get("status") == "awaiting_approval"]
    running = [node for node in nodes if node.get("status") in {"running", "review"}]
    lines = [
        f"{run['id']} · {run.get('status')} · phase {run.get('phase') or '-'}",
        f"节点 {len(nodes)}（运行中 {len(running)}，待审批 {len(pending)}）· driver {'活跃' if run.get('driver_active') else '空闲'}",
    ]
    if pending:
        for node in pending[:5]:
            lines.append(f"· 待审批 {node['id']}（depth {node['depth']}）：{(node.get('question') or '')[:40]}")
    if run.get("last_error"):
        lines.append(f"最近错误：{run['last_error']}")
    return _result("research status", title=f"运行 {run['id']}", lines=lines,
                   navigate=f"#/run/{run['id']}", data={"nodes": len(nodes), "pending": len(pending)})


def _limits(run_id: str | None, argv: list[str]) -> dict[str, Any]:
    changes: dict[str, int] = {}
    index = 0
    while index < len(argv):
        flag = argv[index]
        if flag not in LIMIT_FLAGS:
            raise CommandError(f"不认识的参数：{flag}（可用：{', '.join(LIMIT_FLAGS)}）")
        if index + 1 >= len(argv):
            raise CommandError(f"{flag} 需要一个整数")
        try:
            changes[LIMIT_FLAGS[flag]] = int(argv[index + 1])
        except ValueError as error:
            raise CommandError(f"{flag} 需要一个整数") from error
        index += 2
    if not changes:
        raise CommandError("/research limits 需要至少一个参数，例如 --sister-parallel 2")
    run = _latest_run(run_id)
    result = board.update_limits(run["id"], changes)
    after = result.get("after") or {}
    return _result("research limits", title=f"已改 {run['id']} 的上限",
                   lines=[f"{key} = {after.get(key)}" for key in changes],
                   navigate=f"#/run/{run['id']}", data=result)


async def _tell(run_id: str | None, argv: list[str]) -> dict[str, Any]:
    node_id = None
    words = list(argv)
    if "--to" in words:
        index = words.index("--to")
        if index + 1 >= len(words):
            raise CommandError("--to 需要一个节点 id")
        node_id = words[index + 1]
        del words[index:index + 2]
    message = " ".join(words).strip()
    if not message:
        raise CommandError("/research tell 需要一句话")
    run = _latest_run(run_id)
    try:
        result = await board.tell(run["id"], node_id, message)
    except ValueError as error:
        raise CommandError(str(error)) from error
    return _result("research tell", title=f"已投递给节点 {result.get('node_id')}",
                   lines=[f"会话：{result.get('session_id')}", "投递 ≠ 开始；回读状态看节点是否推进。"],
                   navigate=f"#/run/{run['id']}", data=result)


def _sister(sid: str) -> dict[str, Any]:
    record = next((item for item in catalog.load_records() if item.role == sid and item.has_control), None)
    if record is None:
        live = [item.role for item in catalog.load_records() if item.has_control]
        raise CommandError(f"Sister {sid} 现在没有在听的会话。" + (f"正在听：{', '.join(live)}" if live else ""))
    return _result("sister", title=f"打开 Sister {sid}", lines=[f"会话 {record.id} · {record.cwd or ''}"],
                   navigate=f"#/session/{record.id}", data={"session_id": record.id})


async def _model() -> dict[str, Any]:
    state = await console.model_state()
    glob = state.get("global") or {}
    lines = [f"全局默认：{glob.get('provider') or '未设置'} / {glob.get('model') or '-'}"]
    for entry in state.get("roles") or []:
        settings = entry.get("settings") or {}
        provider = settings.get("defaultProvider")
        model = settings.get("defaultModel")
        lines.append(f"{entry['role']}：{provider}/{model}" if provider else f"{entry['role']}：跟随全局")
    return _result("model", title="模型", lines=lines, navigate="#/settings", data={"global": glob})


def _board(run_id: str | None) -> dict[str, Any]:
    run = _latest_run(run_id)
    detail = board.node_detail(run["id"], (run.get("nodes") or [{}])[0].get("id")) if run.get("nodes") else None
    lines: list[str] = []
    if detail:
        tasks = detail.get("tasks") or []
        if not tasks:
            lines.append("这个节点还没有任务卡片。")
        for task in tasks[:12]:
            lines.append(f"· {task.get('status') or '-'} {task.get('title') or task.get('id')}")
    else:
        lines.append("这个运行还没有节点。")
    return _result("board", title=f"任务板 · {run['id']}", lines=lines, navigate=f"#/run/{run['id']}")


async def run_text(text: str) -> dict[str, Any]:
    """Answer one chat line that starts with a slash. Never forwards it to the model."""
    raw = (text or "").strip()
    if not raw.startswith("/"):
        raise CommandError("Not a command.")
    try:
        tokens = shlex.split(raw)
    except ValueError:
        tokens = raw.split()
    head = tokens[0].lower()
    rest = tokens[1:]

    if head == "/help":
        return _result("help", title="可用命令", lines=help_lines())

    if head == "/research":
        action = rest[0].lower() if rest else "status"
        args = rest[1:]
        run_id = next((arg for arg in args if not arg.startswith("-") and arg.startswith("r_")), None)
        if action == "status":
            return _status(_latest_run(run_id))
        if action == "stop":
            run = _latest_run(run_id)
            board.request_stop(run["id"])
            return _result("research stop", title=f"已请求停止 {run['id']}",
                           lines=["工作流会在节点边界收尾，并写一份部分报告。"], navigate=f"#/run/{run['id']}")
        if action == "resume":
            run = _latest_run(run_id)
            try:
                result = supervisor.resume(run["id"])
            except supervisor.SupervisorError as error:
                raise CommandError(str(error)) from error
            return _result("research resume", title=f"已重新拉起 {run['id']}",
                           lines=[f"pid {result.get('pid')} · 日志 {result.get('log')}"], navigate=f"#/run/{run['id']}",
                           data=result)
        if action == "limits":
            return _limits(run_id, [arg for arg in args if arg != run_id])
        if action == "tell":
            return await _tell(run_id, [arg for arg in args if arg != run_id])
        if action in {"close", "help"}:
            return _result("research help", title="/research 用法", lines=list(SUPPORTED))
        raise CommandError(f"web 端暂不支持 /research {action}；可用：status / stop / resume / limits / tell")

    if head == "/sister":
        if not rest:
            live = [item.role for item in catalog.load_records() if item.has_control]
            return _result("sister", title="正在听的会话", lines=live or ["现在没有会话在听。"])
        return _sister(rest[0])

    if head == "/model":
        return await _model()

    if head == "/board":
        return _board(next((arg for arg in rest if arg.startswith("r_")), None))

    hint = HINTS.get(head)
    return {**_result(head, title=f"{head} 在 web 端暂不可用", lines=[hint or "这条命令还没上手机。"], ok=False),
            "unsupported": True}
