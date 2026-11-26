"""The settings console: keys, Sisters, projects, model choices — through a real MISAKA home."""

from __future__ import annotations

import json
import os
import stat
import subprocess
from pathlib import Path

import pytest


@pytest.fixture
def home(temp_home):
    """The temp MISAKA home the rest of conftest set up (MISAKA_HOME + our own)."""
    return temp_home["home"]


def test_keys_list_the_whitelist_and_start_empty(client, auth):
    body = client.get("/api/settings/keys", headers=auth).json()
    names = [item["name"] for item in body["keys"]]
    assert "DEEPSEEK_API_KEY" in names
    assert "TAVILY_API_KEY" in names
    assert all(item["configured"] is False for item in body["keys"])
    assert body["path"].endswith(".env")


def test_key_is_written_to_env_masked_and_removed(client, auth, home):
    secret = "sk-test-0123456789abcdef"
    written = client.put("/api/settings/keys/DEEPSEEK_API_KEY", json={"value": secret}, headers=auth)
    assert written.status_code == 200
    body = written.json()
    assert secret not in json.dumps(body), "the value must never come back"
    assert body["hint"].startswith("sk-t")

    env_file = home / ".env"
    assert secret in env_file.read_text(encoding="utf-8")
    if os.name == "posix":
        assert stat.S_IMODE(env_file.stat().st_mode) in {0o600, 0o400}

    listed = client.get("/api/settings/keys", headers=auth).json()
    entry = next(item for item in listed["keys"] if item["name"] == "DEEPSEEK_API_KEY")
    assert entry["configured"] is True and entry["source"] == "env file"
    assert secret not in json.dumps(listed)

    cleared = client.delete("/api/settings/keys/DEEPSEEK_API_KEY", headers=auth)
    assert cleared.status_code == 200
    assert "DEEPSEEK_API_KEY" not in env_file.read_text(encoding="utf-8")


def test_unknown_key_name_is_refused(client, auth):
    assert client.put("/api/settings/keys/PATH", json={"value": "x" * 12}, headers=auth).status_code == 422
    assert client.put("/api/settings/keys/OPENAI_API_KEY", json={"value": "short"}, headers=auth).status_code == 422


def test_sister_lifecycle(client, auth, home):
    created = client.post("/api/sisters", json={"id": "10032", "specialty": "清代财政与捐赈制度"}, headers=auth)
    assert created.status_code == 200, created.text
    profile = home / "profiles" / "sisters" / "10032"
    assert (profile / "DESCRIBE.md").is_file() and (profile / "SOUL.md").is_file()

    listed = client.get("/api/sisters", headers=auth).json()["sisters"]
    assert [item["id"] for item in listed] == ["10032"]
    assert listed[0]["specialty"].startswith("清代财政")

    edited = client.patch("/api/sisters/10032", json={"specialty": "计量经济学与因果推断"}, headers=auth)
    assert edited.status_code == 200 and edited.json()["changed"] == ["specialty"]
    describe = (profile / "DESCRIBE.md").read_text(encoding="utf-8")
    assert "计量经济学与因果推断" in describe

    assert client.request("DELETE", "/api/sisters/10032", json={"confirm": False}, headers=auth).status_code == 422
    removed = client.request("DELETE", "/api/sisters/10032", json={"confirm": True}, headers=auth)
    assert removed.status_code == 200
    assert not profile.exists()


def test_sister_edits_keep_a_hand_written_body(client, auth, home):
    client.post("/api/sisters", json={"id": "10033", "specialty": "晚清报刊"}, headers=auth)
    profile = home / "profiles" / "sisters" / "10033"
    describe = profile / "DESCRIBE.md"
    text = describe.read_text(encoding="utf-8")
    describe.write_text(text.replace("Add concrete routing guidance here.", "她擅长处理竖排铅印报刊。"), encoding="utf-8")

    client.patch("/api/sisters/10033", json={"specialty": "晚清报刊与西学译介"}, headers=auth)
    updated = describe.read_text(encoding="utf-8")
    assert "晚清报刊与西学译介" in updated
    assert "她擅长处理竖排铅印报刊。" in updated, "a body the user edited must survive"


def test_duplicate_sister_is_refused(client, auth):
    assert client.post("/api/sisters", json={"id": "10032"}, headers=auth).status_code == 200
    assert client.post("/api/sisters", json={"id": "10032"}, headers=auth).status_code == 422
    assert client.post("/api/sisters", json={"id": "last-order"}, headers=auth).status_code == 422


def test_project_creation_and_refusals(client, auth, tmp_path, monkeypatch):
    root = tmp_path / "research"
    root.mkdir()
    monkeypatch.setenv("MISAKA_WEB_WORKSPACE_ROOT", str(root))

    created = client.post("/api/projects", json={"name": "庚子赈灾"}, headers=auth)
    assert created.status_code == 200, created.text
    folder = root / "庚子赈灾"
    assert (folder / "PROJECT.md").is_file()
    assert (folder / "cards").is_dir()
    assert (folder / "sources").is_dir()

    listed = client.get("/api/projects", headers=auth).json()
    names = [item["name"] for item in listed["projects"]]
    assert "庚子赈灾" in names
    entry = next(item for item in listed["projects"] if item["name"] == "庚子赈灾")
    assert entry["has_project_md"] is True and entry["has_sources"] is True
    # artifact folders inside a project must not be listed as projects themselves
    (root / "庚子赈灾" / "nodes").mkdir(exist_ok=True)
    (root / "庚子赈灾" / "final").mkdir(exist_ok=True)
    again = client.get("/api/projects", headers=auth).json()
    assert [item["name"] for item in again["projects"]] == ["庚子赈灾"]

    assert client.post("/api/projects", json={"name": "庚子赈灾"}, headers=auth).status_code == 422
    assert client.post("/api/projects", json={"name": "../escape"}, headers=auth).status_code == 422
    assert client.post("/api/projects", json={"name": ""}, headers=auth).status_code == 422


def test_model_catalog_lists_providers_and_models(client, auth):
    body = client.get("/api/settings/model", headers=auth).json()
    ids = {item["id"] for item in body["providers"]}
    assert "deepseek" in ids
    deepseek = next(item for item in body["providers"] if item["id"] == "deepseek")
    # the provider list stays small: counts only, models are fetched per provider
    assert deepseek["model_count"] > 0
    assert "models" not in deepseek
    assert "global" in body and "roles" in body

    models = client.get("/api/settings/models", params={"provider": "deepseek"}, headers=auth).json()
    assert models["provider"] == "deepseek"
    assert any(item["id"] for item in models["models"])


def test_unknown_provider_models_is_422(client, auth):
    assert client.get("/api/settings/models", params={"provider": "nope"}, headers=auth).status_code == 422


def test_an_unknown_model_is_refused(client, auth):
    response = client.put("/api/settings/model", json={"provider": "deepseek", "model": "nope"}, headers=auth)
    assert response.status_code == 422
    assert "catalog" in response.json()["error"]["message"]