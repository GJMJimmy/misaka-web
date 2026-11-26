"""Research endpoints against a real board built by upstream's own API."""

from __future__ import annotations

import pytest


def test_run_list_reports_counts(client, board, auth):
    body = client.get("/api/runs", headers=auth).json()
    assert [run["id"] for run in body["runs"]] == [board["run"]["id"]]
    entry = body["runs"][0]
    assert entry["node_count"] == 2
    assert entry["status"] == "active"
    assert entry["question"].startswith("庚子赈灾")


def test_run_detail_exposes_nodes_and_limits(client, board, auth):
    body = client.get(f"/api/runs/{board['run']['id']}", headers=auth).json()
    assert [node["id"] for node in body["nodes"]] == [board["node"]["id"], board["child"]["id"]]
    assert [node["depth"] for node in body["nodes"]] == [0, 1]
    # RunDetail is RunSummary plus detail: the counts must survive, or the phone UI renders empty chips
    assert body["node_count"] == 2
    assert body["awaiting_approval"] == 0
    assert body["nodes"][0]["listening"] is False
    assert body["limits"]["max_nodes"] >= 1
    assert [item["kind"] for item in body["products"]] == ["question"]


def test_node_detail_lists_the_markdown_it_owns(client, board, auth):
    body = client.get(f"/api/runs/{board['run']['id']}/nodes/{board['node']['id']}", headers=auth).json()
    names = [item["name"] for item in body["files"]]
    assert names == ["plan.md", "cards/c1.md"]
    assert body["kind"]


def test_node_file_is_served_as_text(client, board, auth):
    response = client.get(
        f"/api/runs/{board['run']['id']}/nodes/{board['node']['id']}/file",
        params={"name": "plan.md"}, headers=auth,
    )
    assert response.status_code == 200
    assert "覆盖表" in response.json()["text"]


def test_node_file_cannot_escape_the_node_folder(client, board, auth):
    response = client.get(
        f"/api/runs/{board['run']['id']}/nodes/{board['node']['id']}/file",
        params={"name": "../../secret.md"}, headers=auth,
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"


def test_unknown_run_is_404(client, board, auth):
    response = client.get("/api/runs/r_missing", headers=auth)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_tell_says_who_is_listening_when_nobody_is(client, board, auth):
    response = client.post(
        f"/api/runs/{board['run']['id']}/tell", json={"text": "同意，开始吧"}, headers=auth,
    )
    assert response.status_code == 422
    message = response.json()["error"]["message"]
    assert "not running now" in message
    assert "Listening now" in message


def test_stop_requests_a_stop(client, board, auth):
    assert client.post(f"/api/runs/{board['run']['id']}/stop", headers=auth).json()["status"] == "stopping"
    detail = client.get(f"/api/runs/{board['run']['id']}", headers=auth).json()
    assert detail["stop_requested"] is True


def test_limits_are_adjusted_through_upstream(client, board, auth):
    response = client.post(
        f"/api/runs/{board['run']['id']}/limits", json={"changes": {"sister_parallel": 2}}, headers=auth,
    )
    assert response.status_code == 200
    assert response.json()["after"]["sister_parallel"] == 2
    detail = client.get(f"/api/runs/{board['run']['id']}", headers=auth).json()
    assert detail["limits"]["sister_parallel"] == 2


def test_limits_reject_an_unknown_key(client, board, auth):
    response = client.post(
        f"/api/runs/{board['run']['id']}/limits", json={"changes": {"nope": 1}}, headers=auth,
    )
    assert response.status_code == 422
    assert "not adjustable" in response.json()["error"]["message"]


def test_board_missing_is_a_typed_503(client, tmp_path, monkeypatch, auth):
    from misaka_web import config

    empty = tmp_path / "bare"
    (empty / "state").mkdir(parents=True)
    monkeypatch.setenv("MISAKA_WEB_MISAKA_HOME", str(empty))
    config.reset_settings_cache()
    response = client.get("/api/runs", headers=auth)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "board_unavailable"