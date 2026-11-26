"""The supervisor owns argv, cwd, the log and the PID; the child is the real workflow."""

from __future__ import annotations

import pathlib
import sys
import time

import pytest

from misaka_web.bridge import supervisor


@pytest.fixture
def workspace_root(tmp_path, monkeypatch):
    root = tmp_path / "research"
    root.mkdir()
    fake = pathlib.Path(__file__).with_name("fake_research.py")
    monkeypatch.setenv("MISAKA_WEB_WORKSPACE_ROOT", str(root))
    monkeypatch.setenv("MISAKA_WEB_RESEARCH_CMD", '"{0}" "{1}"'.format(sys.executable, fake))
    monkeypatch.setenv("MISAKA_WEB_FAKE_SLEEP", "30")
    yield root


def test_start_discovers_the_run_id_and_keeps_the_log(workspace_root):
    project = workspace_root / "project"
    project.mkdir()
    result = supervisor.start(workspace=str(project), question="赈灾账册与地方财政弹性", limits={"max_depth": 1})
    try:
        assert result["run_id"], "the run id should be discovered from the board"
        info = supervisor.info(result["run_id"])
        assert info["alive"] is True
        assert info["pid"] == result["pid"]
        assert "--depth" in result["argv"] and "1" in result["argv"]
        log = supervisor.log_tail(result["run_id"], lines=20)
        assert "fake research child started" in log["text"]
    finally:
        supervisor.terminate(result["run_id"])
    time.sleep(0.6)
    assert supervisor.info(result["run_id"])["alive"] is False


def test_resume_spawns_against_the_same_run(workspace_root):
    project = workspace_root / "project"
    project.mkdir()
    first = supervisor.start(workspace=str(project), question="重复记账问题", limits={})
    try:
        supervisor.terminate(first["run_id"])
        time.sleep(0.5)
        restarted = supervisor.resume(first["run_id"])
        assert restarted["kind"] == "resume"
        assert restarted["run_id"] == first["run_id"]
        assert supervisor.info(first["run_id"])["alive"] is True
        time.sleep(1.2)
        assert "fake research child resumed" in supervisor.log_tail(first["run_id"])["text"]
    finally:
        supervisor.terminate(first["run_id"])


def test_a_workspace_outside_the_root_is_refused(workspace_root, tmp_path):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    with pytest.raises(supervisor.SupervisorError):
        supervisor.start(workspace=str(outside), question="越界的工作区")


def test_a_missing_workspace_is_refused(workspace_root):
    with pytest.raises(supervisor.SupervisorError):
        supervisor.start(workspace=str(workspace_root / "absent"), question="不存在的工作区")


def test_a_one_character_question_is_refused(workspace_root):
    with pytest.raises(supervisor.SupervisorError):
        supervisor.start(workspace=str(workspace_root), question="x")


def test_log_for_an_unmanaged_run_is_a_404(client, board, auth):
    response = client.get("/api/runs/{0}/log".format(board["run"]["id"]), headers=auth)
    assert response.status_code == 404


def test_api_starts_a_run_and_reports_its_process(client, workspace_root, auth):
    project = workspace_root / "project"
    project.mkdir()
    created = client.post(
        "/api/runs",
        json={"question": "税关记录能否复原赈灾实绩", "workspace": str(project), "limits": {"max_nodes": 4}},
        headers=auth,
    )
    assert created.status_code == 200, created.text
    body = created.json()
    run_id = body["run_id"]
    try:
        assert run_id
        detail = client.get("/api/runs/{0}".format(run_id), headers=auth).json()
        assert detail["process"]["pid"] == body["pid"]
        assert detail["process"]["alive"] is True
        log = client.get("/api/runs/{0}/log".format(run_id), params={"lines": 10}, headers=auth).json()
        assert "fake research child started" in log["text"]
        stopped = client.post("/api/runs/{0}/stop".format(run_id), json={"force": True}, headers=auth).json()
        assert stopped["terminated"]["ok"] is True
    finally:
        if supervisor.info(run_id):
            try:
                supervisor.terminate(run_id)
            except supervisor.SupervisorError:
                pass


def test_api_refuses_a_workspace_outside_the_root(client, workspace_root, tmp_path, auth):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    response = client.post(
        "/api/runs", json={"question": "越界的工作区", "workspace": str(outside)}, headers=auth,
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "invalid_request"
