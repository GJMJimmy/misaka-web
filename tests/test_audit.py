"""Write actions leave a line behind, and never fail because logging did."""

from __future__ import annotations

import json

from helpers import write_record


def test_stop_and_limits_are_audited(client, board, auth):
    from misaka_web import config

    run_id = board["run"]["id"]
    assert client.post(f"/api/runs/{run_id}/stop", headers=auth).status_code == 200
    assert client.post(
        f"/api/runs/{run_id}/limits", json={"changes": {"sister_parallel": 3}}, headers=auth,
    ).status_code == 200

    path = config.settings().token_file.parent / "audit.jsonl"
    lines = [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]
    actions = [line["action"] for line in lines]
    assert actions == ["stop", "limits"]
    assert lines[1]["changes"] == {"sister_parallel": 3}
    assert all(line["at"] for line in lines)


def test_audit_never_breaks_the_action(tmp_path, monkeypatch, caplog):
    from misaka_web import audit, config

    monkeypatch.setenv("MISAKA_WEB_TOKEN_FILE", str(tmp_path / "cfg" / "token"))
    config.reset_settings_cache()
    audit.record("stop", run_id="r_x")  # must not raise even though nothing else exists
