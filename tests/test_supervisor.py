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


def test_an_unnamed_workspace_gets_its_own_project_folder(workspace_root):
    """The bug the phone found: an empty workspace ran in the root and made the root a project."""
    result = supervisor.start(workspace="", question="庚子赈灾账册与地方财政弹性", limits={})
    try:
        assert result["workspace_created"] is True
        folder = pathlib.Path(result["workspace"])
        assert folder.parent == workspace_root.resolve(), folder
        assert folder != workspace_root.resolve()
        assert "庚子赈灾" in folder.name and folder.name[:4].isdigit(), folder.name
    finally:
        supervisor.terminate(result["run_id"])


def test_a_named_workspace_is_used_as_given(workspace_root):
    project = workspace_root / "kept"
    project.mkdir()
    result = supervisor.start(workspace=str(project), question="命名的工作区", limits={})
    try:
        assert result["workspace_created"] is False
        assert pathlib.Path(result["workspace"]) == project.resolve()
    finally:
        supervisor.terminate(result["run_id"])


def test_the_slug_keeps_cjk_and_folds_punctuation():
    assert supervisor._slug("庚子赈灾账册，能否说明弹性？") == "庚子赈灾账册-能否说明弹性"
    assert supervisor._slug("") == "research"
    assert len(supervisor._slug("x" * 100)) == 40


def test_a_workspace_outside_the_root_is_refused(workspace_root, tmp_path):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    with pytest.raises(supervisor.SupervisorError):
        supervisor.start(workspace=str(outside), question="越界的工作区")


def test_a_missing_workspace_is_created_for_a_new_run(workspace_root):
    """Starting a run may make its folder: the phone should not need an SSH session for mkdir."""
    target = workspace_root / "brand-new"
    assert not target.exists()
    result = supervisor.start(workspace=str(target), question="新建目录里的研究", limits={})
    try:
        assert target.is_dir(), "the run's folder should exist now"
        assert result["workspace_created"] is True
        assert result["run_id"], "the run still starts in the folder it just made"
    finally:
        if result.get("run_id"):
            supervisor.terminate(result["run_id"])


def test_a_file_in_the_way_is_refused(workspace_root):
    blocker = workspace_root / "not-a-folder"
    blocker.write_text("x", encoding="utf-8")
    with pytest.raises(supervisor.SupervisorError):
        supervisor.start(workspace=str(blocker), question="路径被文件占了")


def test_resume_still_requires_the_folder_to_exist(workspace_root):
    gone = workspace_root / "vanished"
    with pytest.raises(supervisor.SupervisorError):
        folder, created = supervisor.check_workspace(str(gone))


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