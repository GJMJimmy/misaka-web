"""SSE frame building: a finished reply must stop being a growing partial."""

from __future__ import annotations

from misaka_web.api.app import _delta_frame


def test_a_finished_reply_forwards_an_explicit_null():
    # The bug the phone found: the final frame said "no streaming" and the bridge dropped that
    # key, so the browser kept the frozen half message until the page was reopened.
    payload, state = _delta_frame({"streaming": None, "state": "idle", "entries": [{"type": "message"}]}, "working")
    assert "streaming" in payload and payload["streaming"] is None
    assert payload["state"] == "idle"
    assert state == "idle"
    assert payload["entries"] == [{"type": "message"}]


def test_a_frame_without_the_streaming_key_keeps_the_previous_partial():
    payload, state = _delta_frame({"entries": None, "state": "working"}, "working")
    assert payload == {}
    assert state == "working"


def test_an_unchanged_state_is_not_resent():
    payload, state = _delta_frame({"state": "working", "streaming": {"role": "assistant"}}, "working")
    assert "state" not in payload
    assert payload["streaming"] == {"role": "assistant"}
    assert state == "working"