"""Shared fixtures: a temporary MISAKA home, a token, and a fake session owner."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
# Dev convenience: the upstream checkout next door supplies misaka.utils.local_socket.
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from misaka_web import config  # noqa: E402


@pytest.fixture(autouse=True)
def temp_home(tmp_path, monkeypatch):
    home = tmp_path / "misaka"
    (home / "state" / "sessions" / ".catalog").mkdir(parents=True, exist_ok=True)
    token = tmp_path / "config" / "token"
    token.parent.mkdir(parents=True, exist_ok=True)
    token.write_text("test-token\n", encoding="utf-8")
    static = tmp_path / "static"
    static.mkdir()
    monkeypatch.setenv("MISAKA_WEB_MISAKA_HOME", str(home))
    # upstream resolves its own home from MISAKA_HOME; keep it inside the test too
    monkeypatch.setenv("MISAKA_HOME", str(home))
    monkeypatch.setenv("MISAKA_WEB_TOKEN_FILE", str(token))
    monkeypatch.setenv("MISAKA_WEB_STATIC", str(static))
    monkeypatch.delenv("MISAKA_WEB_DEV_ORIGIN", raising=False)
    config.reset_settings_cache()
    yield {"home": home, "token": "test-token", "static": static}
    config.reset_settings_cache()


@pytest.fixture
def token(temp_home):
    return temp_home["token"]

@pytest.fixture
def client():
    from fastapi.testclient import TestClient

    from misaka_web.api.app import create_app

    with TestClient(create_app()) as test_client:
        yield test_client

@pytest.fixture
def auth(token):
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture
def board(tmp_path, temp_home):
    """One run, a root node and a child node, written the way MISAKA writes them."""
    from misaka.core.platform import tasks as task_store
    from misaka.core.research import runs as upstream

    state = temp_home["home"] / "state"
    state.mkdir(parents=True, exist_ok=True)
    con = task_store.connect(str(state / "board.db"))
    upstream.init(con)
    workspace = tmp_path / "project"
    workspace.mkdir()
    run = upstream.create(
        con, workspace=str(workspace),
        question="庚子赈灾账册与地方财政弹性", limits=upstream.normalize_limits({}),
    )
    root_node = upstream.root(con, run["id"]) or upstream.create_node(
        con, run["id"], question="庚子赈灾账册与地方财政弹性", parents=[]
    )
    child = upstream.create_node(con, run["id"], question="捐输进项是否被重复记账？", parents=[root_node["id"]])
    con.commit()
    folder = workspace / "nodes" / root_node["id"]
    (folder / "cards").mkdir(parents=True, exist_ok=True)
    (folder / "plan.md").write_text("# 计划\n\n覆盖表：空白即声明的研究缺口。\n", encoding="utf-8")
    (folder / "cards" / "c1.md").write_text("# 卡片 1\n\n声明：捐输进项在灾年上升。\n", encoding="utf-8")
    (tmp_path / "secret.md").write_text("do not serve me", encoding="utf-8")
    yield {"run": run, "node": root_node, "child": child, "workspace": workspace, "con": con}
    con.close()