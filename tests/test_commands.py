"""Slash commands typed into the web chat box."""

from __future__ import annotations


def send(client, auth, text):
    return client.post("/api/command", json={"text": text}, headers=auth)


def test_help_lists_the_whitelist(client, auth):
    body = send(client, auth, "/help").json()
    assert body["ok"] is True and body["command"] == "help"
    joined = " ".join(body["lines"])
    assert "/research status" in joined and "/sister ID" in joined


def test_status_reads_the_board(client, auth, board):
    body = send(client, auth, "/research status").json()
    assert body["ok"] is True
    assert board["run"]["id"] in body["title"]
    assert any("节点" in line for line in body["lines"])
    assert body["navigate"] == f"#/run/{board['run']['id']}"


def test_stop_and_limits_write_through(client, auth, board):
    run_id = board["run"]["id"]
    stopped = send(client, auth, f"/research stop {run_id}").json()
    assert stopped["ok"] is True
    detail = client.get(f"/api/runs/{run_id}", headers=auth).json()
    assert detail["stop_requested"] is True

    limited = send(client, auth, f"/research limits {run_id} --sister-parallel 3").json()
    assert limited["ok"] is True
    after = client.get(f"/api/runs/{run_id}", headers=auth).json()["limits"]
    assert after["sister_parallel"] == 3

    log = client.get("/api/audit", params={"action": "command"}, headers=auth).json()
    assert [entry["command"] for entry in log["entries"]][:2] == ["research limits", "research stop"]


def test_tell_reports_who_is_listening(client, auth, board):
    response = send(client, auth, f"/research tell {board['run']['id']} 同意开始")
    assert response.status_code == 422
    assert "not running now" in response.json()["error"]["message"]


def test_sister_without_a_live_session_is_a_refusal(client, auth):
    response = send(client, auth, "/sister 10032")
    assert response.status_code == 422
    assert "没有在听" in response.json()["error"]["message"]


def test_model_and_board_answer(client, auth, board):
    model = send(client, auth, "/model").json()
    assert model["ok"] is True and model["navigate"] == "#/settings"
    assert any("全局默认" in line for line in model["lines"])

    task_board = send(client, auth, "/board").json()
    assert task_board["ok"] is True and "任务板" in task_board["title"]


def test_an_unsupported_command_explains_itself(client, auth):
    body = send(client, auth, "/read open sources --question 什么是弹性").json()
    assert body["ok"] is False and body.get("unsupported") is True
    assert "精读工作台" in body["lines"][0]


def test_plain_text_is_not_a_command(client, auth):
    assert send(client, auth, "你好").status_code == 422


def test_command_list_is_served(client, auth):
    body = client.get("/api/commands", headers=auth).json()
    assert any(item.startswith("/research") for item in body["commands"])
