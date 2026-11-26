"""Run the UI against a fake session owner: misaka-web demo without a live MISAKA.

    MISAKA_WEB_TOKEN_FILE=... python scripts/dev-demo.py

Needs the dev extra (misaka, for its local_socket helper) and the tests/ package on the path.
"""

from __future__ import annotations

import json
import os
import pathlib
import sys
import tempfile
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tests"))

try:
    from fake_owner import FakeOwner, OwnerService
except ImportError as error:  # pragma: no cover - developer aid
    raise SystemExit(
        "This demo needs the dev extra and a MISAKA checkout: pip install -e '.[dev]' from a checkout of upstream."
    ) from error

GRADUAL_REPLY = [
    "收到。",
    "三条线索里，",
    "重复记账最容易证伪。",
    "我把这条开成节点，先核州县与督抚两套账。",
]


def _respond(owner: FakeOwner) -> None:
    """Reply to anything typed in the UI, chunk by chunk, so deltas have something to stream."""
    seen = 0
    while True:
        time.sleep(0.2)
        if len(owner.texts) <= seen:
            continue
        text, seen = owner.texts[-1], len(owner.texts)
        owner.state = "working"
        owner.entries.append({"role": "user", "content": [{"type": "text", "text": text}]})
        owner.revision += 1
        body = ""
        for chunk in GRADUAL_REPLY:
            time.sleep(0.4)
            body += chunk
            owner.streaming = {"role": "assistant", "content": [{"type": "text", "text": body}]}
            owner.revision += 1
        time.sleep(0.4)
        owner.streaming = None
        owner.entries.append({"role": "assistant", "content": [{"type": "text", "text": body}]})
        owner.state = "idle"
        owner.revision += 1


def _seed_board(home: "pathlib.Path", workspace: "pathlib.Path") -> None:
    """Give the UI a board to read: two runs, three depths, markdown on disk.

    Guarded so the demo never writes into a real board: it only seeds the demo home.
    """
    from misaka.core.platform import tasks as task_store
    from misaka.core.research import runs as upstream

    state = home / "state"
    state.mkdir(parents=True, exist_ok=True)
    con = task_store.connect(str(state / "board.db"))
    upstream.init(con)
    if upstream.listing(con):
        con.close()
        return
    workspace.mkdir(parents=True, exist_ok=True)
    limits = upstream.normalize_limits({"max_nodes": 6})
    first = upstream.create(con, workspace=str(workspace), question="庚子赈灾账册与地方财政弹性", limits=limits)
    root = upstream.root(con, first["id"])
    assert root is not None, "create() plants the root node"
    alternative = upstream.create_node(con, first["id"], question="若账册口径失真，赈灾实绩还能否从税关记录复原？", parents=[root["id"]])
    upstream.create_node(con, first["id"], question="捐输进项是否被州县与督抚重复记账？", parents=[alternative["id"]])
    second = upstream.create(con, workspace=str(workspace), question="晚清书院藏书目录里的西学分类是如何被译介的？", limits=limits)
    upstream.root(con, second["id"])  # create() already plants the root node
    con.commit()

    plan = "# 研究计划\n\n## 问题的两种读法\n\n一是财政弹性，二是记账口径。\n\n## 覆盖表\n\n| 子问题 | 卡片 |\n|---|---|\n| 捐输进项 | c1 |\n| 折色比例 | —（空白即缺口） |\n\n## 分工\n\n- Sister 10032：清代财政与捐输制度。\n"
    card = "# 卡片 c1\n\n- 声明：捐输进项在灾年反而上升。\n- 类型：事实\n- 依据：p.42，字符偏移 1180\n- 引文：「是岁捐输倍于常年。」\n"
    synthesis = "# 结论（第 1 版）\n\n三条线索互相冲突。所谓弹性，可能只是记账口径造成的幻觉。\n\n## 未采纳的方向\n\n税关记录与账册不同源，需要另开节点。\n"
    folder = workspace / "nodes" / root["id"]
    (folder / "cards").mkdir(parents=True, exist_ok=True)
    (folder / "plan.md").write_text(plan, encoding="utf-8")
    (folder / "cards" / "c1.md").write_text(card, encoding="utf-8")
    (folder / "synthesis.md").write_text(synthesis, encoding="utf-8")
    (folder / "SOURCES.md").write_text("# 来源\n\n- 《赈灾账册》卷三（p.42）\n", encoding="utf-8")
    con.close()


def main() -> int:
    home = pathlib.Path(os.environ.get("MISAKA_WEB_MISAKA_HOME") or (ROOT / ".demo-home"))
    os.environ.setdefault("MISAKA_WEB_MISAKA_HOME", str(home))
    catalog = home / "state" / "sessions" / ".catalog"
    catalog.mkdir(parents=True, exist_ok=True)

    owner = FakeOwner(session_id="sess-demo-1", instance="inst-demo-1")
    owner.entries = [
        {"role": "user", "content": [{"type": "text", "text": "庚子年间的赈灾账册，能否说明地方财政的实际弹性？"}]},
        {"role": "assistant", "content": [{"type": "text", "text": "账册给出三条互相冲突的线索。第一，捐输名目下的进项在灾年反而上升；第二，同一批银两在州县与督抚两级账上各记一次；第三，赈粮折色的比例与市价脱钩。所谓弹性，可能只是一种记账口径造成的幻觉。"}]},
    ]
    socket_path = str(pathlib.Path(tempfile.gettempdir()) / "misaka-web-demo.sock")
    OwnerService(owner).start(socket_path)
    (catalog / "sess-demo-1.json").write_text(
        json.dumps({
            "id": owner.session_id,
            "instance": owner.instance,
            "control": socket_path,
            "path": None,
            "role": "last_order",
            "cwd": "/home/misaka/Documents/qing-famine",
            "pid": os.getpid(),
        }),
        encoding="utf-8",
    )
    threading.Thread(target=_respond, args=(owner,), daemon=True).start()
    _seed_board(home, home / "demo-project")

    import uvicorn

    host = os.environ.get("MISAKA_WEB_HOST", "127.0.0.1")
    port = int(os.environ.get("MISAKA_WEB_PORT", "8787"))
    print(f"demo session ready at {socket_path}; UI on http://{host}:{port}/", flush=True)
    uvicorn.run("misaka_web.api.app:app", host=host, port=port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())