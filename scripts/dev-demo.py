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


def _demo_pdf(path: "pathlib.Path", pages: int = 3) -> None:
    """A tiny valid PDF, so the citation jump has a real page target in the demo."""
    objs = ["<< /Type /Catalog /Pages 2 0 R >>"]
    kids = " ".join("{0} 0 R".format(3 + i * 2) for i in range(pages))
    objs.append("<< /Type /Pages /Kids [{0}] /Count {1} >>".format(kids, pages))
    for index in range(pages):
        objs.append(
            "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents {0} 0 R "
            "/Resources << /Font << /F1 {1} 0 R >> >> >>".format(4 + index * 2, 3 + pages * 2)
        )
        stream = "BT /F1 28 Tf 72 760 Td (Page {0}) Tj ET".format(index + 1)
        objs.append("<< /Length {0} >>\nstream\n{1}\nendstream".format(len(stream), stream))
    objs.append("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>")
    out = bytearray(b"%PDF-1.4\n")
    offsets = []
    for index, body in enumerate(objs, start=1):
        offsets.append(len(out))
        out += "{0} 0 obj\n{1}\nendobj\n".format(index, body).encode()
    xref = len(out)
    count = len(objs) + 1
    out += "xref\n0 {0}\n".format(count).encode() + b"0000000000 65535 f \n"
    for offset in offsets:
        out += "{0:010d} 00000 n \n".format(offset).encode()
    out += "trailer\n<< /Size {0} /Root 1 0 R >>\nstartxref\n{1}\n%%EOF\n".format(count, xref).encode()
    path.write_bytes(bytes(out))


def _seed_board(home: "pathlib.Path", workspace: "pathlib.Path", owner_session_id: str = "sess-demo-1") -> None:
    """Give the UI a board to read: two runs, three depths, markdown on disk.

    Guarded so the demo never writes into a real board: it only seeds the demo home.
    """
    from misaka.core.platform import tasks as task_store
    from misaka.core.research import runs as upstream

    state = home / "state"
    state.mkdir(parents=True, exist_ok=True)
    con = task_store.connect(str(state / "board.db"))
    upstream.init(con)
    existing = upstream.listing(con)
    workspace.mkdir(parents=True, exist_ok=True)
    limits = upstream.normalize_limits({"max_nodes": 6})
    if not existing:
        first = upstream.create(con, workspace=str(workspace), question="庚子赈灾账册与地方财政弹性", limits=limits)
        root = upstream.root(con, first["id"])
        assert root is not None, "create() plants the root node"
        alternative = upstream.create_node(con, first["id"], question="若账册口径失真，赈灾实绩还能否从税关记录复原？", parents=[root["id"]])
        upstream.create_node(con, first["id"], question="捐输进项是否被州县与督抚重复记账？", parents=[alternative["id"]])
        second = upstream.create(con, workspace=str(workspace), question="晚清书院藏书目录里的西学分类是如何被译介的？", limits=limits)
        upstream.root(con, second["id"])  # create() already plants the root node
        con.commit()

        plan = "# 研究计划\n\n## 问题的两种读法\n\n一是财政弹性，二是记账口径。依据见 doc:1a2b3c4d#p2，另参 p.3。\n\n## 覆盖表\n\n| 子问题 | 卡片 |\n|---|---|\n| 捐输进项 | c1 |\n| 折色比例 | —（空白即缺口） |\n\n## 分工\n\n- Sister 10032：清代财政与捐输制度，材料在 `downloads/zhenzai-v3.pdf`。\n"
        card = "# 卡片 c1\n\n- 声明：捐输进项在灾年反而上升。\n- 类型：事实\n- 依据：doc:1a2b3c4d#p2，字符偏移 1180\n- 引文：「是岁捐输倍于常年。」\n"
        synthesis = "# 结论（第 1 版）\n\n三条线索互相冲突（doc:1a2b3c4d#p3，另见 `doc:1a2b3c4d#p2`）。所谓弹性，可能只是记账口径造成的幻觉。\n\n## 未采纳的方向\n\n税关记录与账册不同源，需要另开节点。\n"
        sources_md = (
            "# Sources — 庚子赈灾账册与地方财政弹性\n\n"
            "Files gathered for this product.\n\n## Products\n\n"
            "- `synthesis.md` — 结论 (synthesis)\n\n"
            "## Cited sources (under `sources/`/)\n\n"
            "- `sources/zhenzai-v3.pdf` ← `downloads/zhenzai-v3.pdf`\n"
            "  - 赈灾账册卷三（扫描件）\n"
            "  - sha256 9f2c0d1eaa\n"
            "  - cited as `doc:1a2b3c4d#p2` in plan\n"
            "  - cited as `doc:1a2b3c4d#p3` in conclusion\n"
            "- `sources/tax-records.txt` ← `downloads/tax-records.txt`\n"
            "  - 税关记录抄件\n"
            "  - sha256 77aa11\n"
            "- `sources/absent-notice.pdf` ← `downloads/absent-notice.pdf`\n"
            "  - 清单里有、磁盘上故意没放（演示 exists=false）\n"
        )


        folder = workspace / "nodes" / root["id"]
        (folder / "cards").mkdir(parents=True, exist_ok=True)
        (folder / "plan.md").write_text(plan, encoding="utf-8")
        (folder / "cards" / "c1.md").write_text(card, encoding="utf-8")
        (folder / "synthesis.md").write_text(synthesis, encoding="utf-8")
        (folder / "SOURCES.md").write_text(sources_md, encoding="utf-8")
        sources_dir = folder / "sources"
        sources_dir.mkdir(parents=True, exist_ok=True)
        _demo_pdf(sources_dir / "zhenzai-v3.pdf", 3)
        (sources_dir / "tax-records.txt").write_text("税关记录：是岁捐输倍于常年。", encoding="utf-8")
    # Make the root node look like a Last Order is attached, so the approval path is demoable:
    # the run points at the demo transcript, the catalog record carries that path, and the node
    # waits for the go-ahead.
    sessions = home / "state" / "sessions"
    sessions.mkdir(parents=True, exist_ok=True)
    transcript = sessions / "demo-session.jsonl"
    transcript.write_text(json.dumps({"type": "session", "id": owner_session_id}) + "\n", encoding="utf-8")
    record_file = sessions / ".catalog" / (owner_session_id + ".json")
    if record_file.is_file():
        record = json.loads(record_file.read_text(encoding="utf-8"))
        record["path"] = str(transcript)
        record_file.write_text(json.dumps(record), encoding="utf-8")
    newest = (existing or [upstream.get(con, first["id"])])[0]
    root_node = upstream.root(con, newest["id"])
    con.execute("UPDATE research_runs SET root_session=? WHERE id=?", (str(transcript), newest["id"]))
    if root_node is not None:
        con.execute("UPDATE research_execution SET status=? WHERE id=?", ("awaiting_approval", root_node["id"]))
    con.commit()
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
    _seed_board(home, home / "demo-project", owner.session_id)

    # Keep demo activity inside the demo home, and simulate new runs instead of spending tokens.
    os.environ.setdefault("MISAKA_WEB_WORKSPACE_ROOT", str(home / "demo-project"))
    (home / "demo-project").mkdir(parents=True, exist_ok=True)
    if not os.environ.get("MISAKA_WEB_RESEARCH_CMD"):
        fake = ROOT / "tests" / "fake_research.py"
        if fake.is_file():
            os.environ["MISAKA_WEB_RESEARCH_CMD"] = '"{0}" "{1}"'.format(sys.executable, fake)
            os.environ.setdefault("MISAKA_WEB_FAKE_SLEEP", "15")
            print("demo: new runs are simulated by tests/fake_research.py (no model calls)", flush=True)

    import uvicorn

    host = os.environ.get("MISAKA_WEB_HOST", "127.0.0.1")
    port = int(os.environ.get("MISAKA_WEB_PORT", "8787"))
    print(f"demo session ready at {socket_path}; UI on http://{host}:{port}/", flush=True)
    uvicorn.run("misaka_web.api.app:app", host=host, port=port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())