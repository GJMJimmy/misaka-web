"""Hiding a stale run or session from the web list (never deleting upstream state)."""

from __future__ import annotations

import json

import pytest

from fake_owner import FakeOwner, OwnerService
from helpers import write_record
from misaka_web.bridge import hidden, runs as board


@pytest.fixture
def service(tmp_path):
    owner = FakeOwner()
    runner = OwnerService(owner)
    path = runner.start(str(tmp_path / "owner.sock"))
    try:
        yield owner, path
    finally:
        runner.stop()


def test_workspace_missing_flags_a_deleted_folder(tmp_path):
    assert board.workspace_missing(str(tmp_path / "gone")) is True
    assert board.workspace_missing(str(tmp_path)) is False
    assert board.workspace_missing(None) is True


def test_hiding_a_run_takes_it_off_the_list(client, auth, board):
    run_id = board["run"]["id"]
    listed = client.get("/api/runs", headers=auth).json()["runs"]
    assert run_id in [item["id"] for item in listed]

    assert client.post(f"/api/runs/{run_id}/hide", headers=auth).status_code == 200
    assert run_id not in [item["id"] for item in client.get("/api/runs", headers=auth).json()["runs"]]

    every = client.get("/api/runs", params={"include_hidden": True}, headers=auth).json()["runs"]
    entry = next(item for item in every if item["id"] == run_id)
    assert entry["hidden"] is True

    assert client.request("DELETE", f"/api/runs/{run_id}/hide", headers=auth).status_code == 200
    assert run_id in [item["id"] for item in client.get("/api/runs", headers=auth).json()["runs"]]


def test_hide_stale_hides_only_missing_workspaces(client, auth, board, monkeypatch):
    from misaka_web.bridge import runs as module

    monkeypatch.setattr(module, "workspace_missing", lambda workspace: True)
    body = client.post("/api/runs/hide-stale", headers=auth).json()
    assert body["ok"] is True and body["added"] >= 1
    assert client.get("/api/runs", headers=auth).json()["runs"] == []


def test_a_hidden_run_still_opens(client, auth, board):
    run_id = board["run"]["id"]
    client.post(f"/api/runs/{run_id}/hide", headers=auth)
    detail = client.get(f"/api/runs/{run_id}", headers=auth)
    assert detail.status_code == 200, "hiding is a list decision, not a tombstone"
    assert detail.json()["id"] == run_id


def test_hiding_a_session_takes_it_off_the_list(client, auth, service, temp_home):
    owner, path = service
    write_record(temp_home["home"], session_id=owner.session_id, control=path)
    items = client.get("/api/sessions", headers=auth).json()["sessions"]
    assert items, "the fake owner registers one session"
    session_id = items[0]["id"]
    assert "workspace_missing" in items[0]

    assert client.post(f"/api/sessions/{session_id}/hide", headers=auth).status_code == 200
    assert session_id not in [item["id"] for item in client.get("/api/sessions", headers=auth).json()["sessions"]]

    every = client.get("/api/sessions", params={"include_hidden": True}, headers=auth).json()["sessions"]
    assert session_id in [item["id"] for item in every]

    assert client.request("DELETE", f"/api/sessions/{session_id}/hide", headers=auth).status_code == 200
    assert session_id in [item["id"] for item in client.get("/api/sessions", headers=auth).json()["sessions"]]


def test_the_hidden_file_lives_in_the_token_directory(client, auth, board, temp_home):
    run_id = board["run"]["id"]
    client.post(f"/api/runs/{run_id}/hide", headers=auth)
    path = hidden._path()
    assert path.is_file()
    assert run_id in json.loads(path.read_text(encoding="utf-8"))["runs"]


def test_an_unknown_list_is_refused():
    try:
        hidden.hide("cards", "x")
    except ValueError as error:
        assert "Unknown list" in str(error)
    else:
        raise AssertionError("expected a refusal")