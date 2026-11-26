"""Static hosting: the built UI, its assets, and no way out of the directory."""

from __future__ import annotations

import pytest

from misaka_web import config


@pytest.fixture
def built_ui(tmp_path, monkeypatch):
    static = tmp_path / "built"
    (static / "assets").mkdir(parents=True)
    (static / "index.html").write_text("<!doctype html><title>misaka</title><div id=root></div>", encoding="utf-8")
    (static / "assets" / "app.js").write_text("console.log('ui')", encoding="utf-8")
    (tmp_path / "secret.txt").write_text("do not serve me", encoding="utf-8")
    monkeypatch.setenv("MISAKA_WEB_STATIC", str(static))
    config.reset_settings_cache()
    return static


def test_root_serves_index_html(client, built_ui):
    response = client.get("/")
    assert response.status_code == 200
    assert "misaka" in response.text


def test_asset_is_served(client, built_ui):
    response = client.get("/assets/app.js")
    assert response.status_code == 200
    assert "console.log" in response.text


def test_unknown_client_route_falls_back_to_the_app(client, built_ui):
    response = client.get("/sessions/abc")
    assert response.status_code == 200
    assert "id=root" in response.text


def test_unknown_api_path_stays_json(client, built_ui, token):
    response = client.get("/api/does-not-exist", headers={"Authorization": f"Bearer {token}"})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_path_traversal_cannot_escape_the_static_root(client, built_ui):
    for attempt in ("/../secret.txt", "/..%2Fsecret.txt", "/assets/..%2F..%2Fsecret.txt"):
        response = client.get(attempt)
        assert "do not serve me" not in response.text, attempt
