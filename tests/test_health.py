"""Health tells a deploy apart from a working install."""

from __future__ import annotations

from helpers import write_record


def test_health_reports_environment_without_leaking_secrets(client, temp_home, token):
    write_record(temp_home["home"], session_id="sess-x", control=None)
    body = client.get("/api/health").json()
    assert body["ok"] is True
    assert body["catalog_present"] is True
    assert body["catalog_records"] == 1
    assert body["sessions_live"] == 0
    assert body["sessions_root"].endswith("state/sessions") or body["sessions_root"].endswith("state\\sessions")
    assert body["control_parent"] in {"visible", "empty", "unreadable"}
    assert token not in str(body), "health must never echo the token"


def test_health_survives_a_missing_catalog(tmp_path, monkeypatch, client):
    from misaka_web import config

    empty = tmp_path / "bare"
    empty.mkdir()
    monkeypatch.setenv("MISAKA_WEB_MISAKA_HOME", str(empty))
    config.reset_settings_cache()
    body = client.get("/api/health").json()
    assert body["catalog_present"] is False
    assert body["catalog_records"] == 0
