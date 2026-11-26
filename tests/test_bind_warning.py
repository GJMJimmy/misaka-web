"""The warning that fires before someone exposes the bridge to a LAN."""

from __future__ import annotations

from misaka_web.__main__ import _bind_warning


def test_loopback_is_quiet():
    for host in ("127.0.0.1", "localhost", "::1"):
        assert _bind_warning(host) is None


def test_a_wildcard_bind_explains_itself():
    message = _bind_warning("0.0.0.0")
    assert message is not None
    assert "cleartext" in message
    assert "insecure context" in message
    assert "Caddy" in message


def test_a_lan_address_gets_the_same_warning():
    assert "cleartext" in (_bind_warning("192.168.1.20") or "")
