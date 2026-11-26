"""The web terminal: tickets, the client check, the pipe fallback, and the limit."""

from __future__ import annotations

import json
import sys

import pytest

UA = {"user-agent": "pytest-terminal"}


@pytest.fixture(autouse=True)
def _clean_terminal_state():
    """Tickets and the concurrency counter are module state: start every test clean."""
    from misaka_web.api import routes_terminal as routes

    routes.TICKETS.clear()
    routes.ACTIVE.clear()
    yield
    routes.TICKETS.clear()
    routes.ACTIVE.clear()


def _echo_cmd() -> str:
    return json.dumps([sys.executable, "-u", "-c",
                       "import sys\nprint('ready', flush=True)\n"
                       "for line in sys.stdin:\n    print('echo:' + line.strip(), flush=True)\n"])


def test_a_ticket_is_issued_for_the_shell_profile(client, auth, monkeypatch):
    monkeypatch.setenv("MISAKA_WEB_TERMINAL_CMD", _echo_cmd())
    response = client.post("/api/terminal/ticket", json={"profile": "shell"}, headers={**auth, **UA})
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["ws_url"].startswith("/api/terminal/ws?ticket=")
    assert body["profile"] == "shell"
    assert body["mode"] in {"pty", "pipe"}


def test_an_unknown_profile_is_refused(client, auth):
    response = client.post("/api/terminal/ticket", json={"profile": "root-shell"}, headers={**auth, **UA})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "bad_profile"


def test_a_tui_profile_without_a_pty_says_so(client, auth, monkeypatch):
    from misaka_web.bridge import pty as bridge

    if bridge.pty_available():
        pytest.skip("this host has a PTY, so the profile is allowed")
    response = client.post("/api/terminal/ticket", json={"profile": "panel"}, headers={**auth, **UA})
    assert response.status_code == 501
    assert response.json()["error"]["code"] == "pty_unavailable"


def test_a_workspace_outside_the_allowlist_is_refused(client, auth, tmp_path, monkeypatch):
    root = tmp_path / "ws"
    root.mkdir()
    monkeypatch.setenv("MISAKA_WEB_WORKSPACE_ROOT", str(root))
    response = client.post("/api/terminal/ticket", json={"profile": "shell", "cwd": str(tmp_path / "outside")},
                           headers={**auth, **UA})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "bad_cwd"


def test_the_websocket_streams_output_and_echoes_input(client, auth, monkeypatch):
    monkeypatch.setenv("MISAKA_WEB_TERMINAL_CMD", _echo_cmd())
    ticket = client.post("/api/terminal/ticket", json={"profile": "shell"}, headers={**auth, **UA}).json()
    with client.websocket_connect(ticket["ws_url"], headers=UA) as socket:
        first = socket.receive_json()
        assert first["type"] == "output" and "ready" in first["data"]
        socket.send_json({"type": "input", "data": "hello\n"})
        seen = ""
        while "echo:hello" not in seen:
            frame = socket.receive_json()
            assert frame["type"] == "output", frame
            seen += frame["data"]
    assert "echo:hello" in seen


def test_a_ticket_belongs_to_the_client_that_asked_for_it():
    """TestClient does not forward custom WS headers, so the rule is checked directly."""
    from misaka_web.api import routes_terminal as routes

    class Stub:
        def __init__(self, ua: str) -> None:
            self.headers = {"user-agent": ua}

    assert routes._client_hint(Stub("phone")) == routes._client_hint(Stub("phone"))
    assert routes._client_hint(Stub("phone")) != routes._client_hint(Stub("laptop"))


def test_a_second_terminal_is_refused_while_one_is_open(client, auth, monkeypatch):
    """The counter is per client; one open terminal means the next ticket is refused."""
    from misaka_web.api import routes_terminal as routes

    monkeypatch.setenv("MISAKA_WEB_TERMINAL_MAX", "1")
    monkeypatch.setenv("MISAKA_WEB_TERMINAL_CMD", _echo_cmd())
    monkeypatch.setattr(routes, "_client_hint", lambda request: "fixed-client")
    routes.ACTIVE["fixed-client"] = 1
    try:
        response = client.post("/api/terminal/ticket", json={"profile": "shell"}, headers={**auth, **UA})
    finally:
        routes.ACTIVE.pop("fixed-client", None)
    assert response.status_code == 429
    assert response.json()["error"]["code"] == "too_many_terminals"


def test_a_used_ticket_cannot_be_replayed(client, auth, monkeypatch):
    from misaka_web.api import routes_terminal as routes

    monkeypatch.setenv("MISAKA_WEB_TERMINAL_CMD", _echo_cmd())
    ticket = client.post("/api/terminal/ticket", json={"profile": "shell"}, headers={**auth, **UA}).json()
    routes.TICKETS.pop(ticket["ticket"])  # a ticket that was used (or expired) is gone
    with client.websocket_connect(ticket["ws_url"], headers=UA) as socket:
        frame = socket.receive_json()
        assert frame["type"] == "error" and frame["code"] == "ticket_expired"
