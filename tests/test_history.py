"""A finished session: no control socket, but the transcript is still readable."""

from __future__ import annotations

import json
from pathlib import Path

NEWLINE = chr(10)


def _write_session(home: Path, session_id: str = "sess-saved-1") -> Path:
    folder = home / "state" / "sessions" / "research" / "r_x--root-lo"
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / ("2026-01-01T00-00-00-000Z_" + session_id + ".jsonl")
    lines = [
        {"type": "session", "version": 3, "id": session_id, "cwd": "/research/qing",
         "timestamp": "2026-01-01T00:00:00.000Z"},
        {"type": "model_change", "id": "a1", "parentId": None, "provider": "deepseek",
         "modelId": "deepseek-flash", "timestamp": "2026-01-01T00:00:01.000Z"},
        {"type": "message", "id": "a2", "parentId": "a1", "timestamp": "2026-01-01T00:00:02.000Z",
         "message": {"role": "user", "content": [{"type": "text", "text": "账册能否说明弹性？"}]}},
        {"type": "message", "id": "a3", "parentId": "a2", "timestamp": "2026-01-01T00:00:03.000Z",
         "message": {"role": "assistant", "content": [{"type": "text", "text": "三条线索互相冲突。"}]}},
    ]
    body = NEWLINE.join(json.dumps(line, ensure_ascii=False) for line in lines) + NEWLINE
    path.write_text(body, encoding="utf-8")
    catalog = home / "state" / "sessions" / ".catalog"
    catalog.mkdir(parents=True, exist_ok=True)
    (catalog / (session_id + ".json")).write_text(json.dumps({
        "id": session_id,
        "path": str(path),
        "control": None,
        "instance": "inst-saved",
        "role": "last_order",
        "cwd": "/research/qing",
    }), encoding="utf-8")
    return path


def test_a_finished_session_serves_its_transcript(client, auth, temp_home):
    _write_session(temp_home["home"])
    listed = client.get("/api/sessions", headers=auth).json()["sessions"]
    entry = next(item for item in listed if item["id"] == "sess-saved-1")
    assert entry["state"] == "saved" and entry["has_control"] is False

    response = client.get("/api/sessions/sess-saved-1", headers=auth)
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["read_only"] is True
    assert body["cwd"] == "/research/qing"
    roles = [str((item.get("message") or {}).get("role")) for item in body["entries"]]
    assert "user" in roles and "assistant" in roles, "the session header must not become an entry"


def test_a_record_without_a_transcript_says_so(client, auth, temp_home):
    catalog = temp_home["home"] / "state" / "sessions" / ".catalog"
    catalog.mkdir(parents=True, exist_ok=True)
    (catalog / "gone.json").write_text(json.dumps({
        "id": "gone", "path": "/nope/missing.jsonl", "control": None, "role": "last_order",
    }), encoding="utf-8")
    response = client.get("/api/sessions/gone", headers=auth)
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "no_control"
