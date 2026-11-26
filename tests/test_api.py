"""Session endpoints and the SSE stream."""

from __future__ import annotations

import pytest

from fake_owner import FakeOwner, OwnerService
from helpers import write_record


@pytest.fixture
def service(tmp_path):
    owner = FakeOwner()
    runner = OwnerService(owner)
    path = runner.start(str(tmp_path / "owner.sock"))
    try:
        yield owner, path
    finally:
        runner.stop()


@pytest.fixture
def auth(token):
    return {"Authorization": f"Bearer {token}"}


def test_session_list_reports_a_live_owner(client, service, temp_home, auth):
    owner, path = service
    write_record(temp_home["home"], session_id=owner.session_id, control=path)
    body = client.get("/api/sessions", headers=auth).json()
    assert [session["id"] for session in body["sessions"]] == [owner.session_id]
    assert body["sessions"][0]["state"] == "live"


def test_snapshot_endpoint(client, service, temp_home, auth):
    owner, path = service
    owner.entries.append({"role": "assistant", "content": [{"type": "text", "text": "hello"}]})
    write_record(temp_home["home"], session_id=owner.session_id, control=path)
    body = client.get(f"/api/sessions/{owner.session_id}", headers=auth).json()
    assert body["state"] == "idle"
    assert body["entries"][0]["content"][0]["text"] == "hello"


def test_unknown_session_is_404(client, auth):
    response = client.get("/api/sessions/absent", headers=auth)
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "not_found"


def test_input_is_delivered_and_never_retried(client, service, temp_home, auth):
    owner, path = service
    write_record(temp_home["home"], session_id=owner.session_id, control=path)
    response = client.post(f"/api/sessions/{owner.session_id}/input", json={"text": "  agree  "}, headers=auth)
    assert response.status_code == 200
    assert owner.texts == ["agree"]
    empty = client.post(f"/api/sessions/{owner.session_id}/input", json={"text": "   "}, headers=auth)
    assert empty.status_code == 422


def test_unconfirmed_delivery_is_502_with_a_message(client, service, temp_home, auth):
    owner, path = service
    write_record(temp_home["home"], session_id=owner.session_id, control=path)
    owner.fail_with = "The original session changed owners or ended."
    response = client.post(f"/api/sessions/{owner.session_id}/input", json={"text": "hi"}, headers=auth)
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "unconfirmed"
    assert "changed owners" in response.json()["error"]["message"]


def test_pause_and_resume(client, service, temp_home, auth):
    owner, path = service
    write_record(temp_home["home"], session_id=owner.session_id, control=path)
    assert client.post(f"/api/sessions/{owner.session_id}/pause", headers=auth).json()["paused"] is True
    assert client.post(f"/api/sessions/{owner.session_id}/resume", headers=auth).json()["paused"] is False
    assert owner.pause_calls == ["pause", "resume"]


def test_sse_emits_a_snapshot_then_a_delta(client, service, temp_home, auth, monkeypatch):
    owner, path = service
    write_record(temp_home["home"], session_id=owner.session_id, control=path)
    monkeypatch.setattr("misaka_web.api.app.POLL_SECONDS", 0.05)

    events = []
    with client.stream("GET", f"/api/sessions/{owner.session_id}/events", headers=auth) as response:
        assert response.status_code == 200
        assert response.headers["content-type"].startswith("text/event-stream")
        for line in response.iter_lines():
            if not line.startswith("event: "):
                continue
            name = line.split(": ", 1)[1]
            events.append(name)
            if name == "snapshot":
                owner.entries.append({"role": "assistant", "content": [{"type": "text", "text": "later"}]})
            if name == "delta":
                break

    assert events[:2] == ["snapshot", "delta"]
