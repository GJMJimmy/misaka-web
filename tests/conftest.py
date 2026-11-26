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
