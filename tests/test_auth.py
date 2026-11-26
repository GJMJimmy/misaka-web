"""Auth surface: one token, bearer or cookie, and nothing else."""

from __future__ import annotations


def test_health_is_public(client):
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["ok"] is True
    assert body["version"]


def test_sessions_requires_auth(client):
    response = client.get("/api/sessions")
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_login_rejects_a_wrong_token(client):
    response = client.post("/api/login", json={"token": "nope"})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "unauthorized"


def test_login_sets_a_cookie_that_authenticates(client, token):
    login = client.post("/api/login", json={"token": token})
    assert login.status_code == 200
    assert "mw_session" in client.cookies
    assert client.get("/api/me").json()["authenticated"] is True


def test_bearer_token_authenticates_without_a_cookie(client, token):
    response = client.get("/api/me", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 200
    assert response.json()["version"]


def test_missing_token_file_reports_unauthorized(tmp_path, monkeypatch):
    from fastapi.testclient import TestClient

    from misaka_web import config
    from misaka_web.api.app import create_app

    monkeypatch.setenv("MISAKA_WEB_TOKEN_FILE", str(tmp_path / "absent" / "token"))
    config.reset_settings_cache()
    response = TestClient(create_app()).get("/api/me", headers={"Authorization": "Bearer anything"})
    assert response.status_code == 401
