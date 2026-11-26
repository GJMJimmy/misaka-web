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

    import uvicorn

    host = os.environ.get("MISAKA_WEB_HOST", "127.0.0.1")
    port = int(os.environ.get("MISAKA_WEB_PORT", "8787"))
    print(f"demo session ready at {socket_path}; UI on http://{host}:{port}/", flush=True)
    uvicorn.run("misaka_web.api.app:app", host=host, port=port, log_level="info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
