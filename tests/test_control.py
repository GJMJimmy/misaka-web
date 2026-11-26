"""The control client against a real local socket."""

from __future__ import annotations

import pytest

from fake_owner import FakeOwner
from misaka_web.bridge import catalog, control


def _record(owner: FakeOwner, path: str) -> catalog.SessionRecord:
    return catalog.SessionRecord(
        id=owner.session_id,
        instance=owner.instance,
        control=path,
        path=None,
        role="last-order",
        cwd="/research",
        title=None,
        pid=1,
        mtime=None,
    )


@pytest.mark.asyncio
async def test_snapshot_and_delta_cursors(tmp_path):
    owner = FakeOwner()
    path = await owner.start(str(tmp_path / "ctl.sock"))
    record = _record(owner, path)
    try:
        first = await control.snapshot(record)
        assert first["id"] == owner.session_id
        assert first["entries"] is not None, "a fresh snapshot must carry the conversation"
        second = await control.snapshot(record, cursor=first["cursor"], stream_cursor=first["stream_cursor"])
        assert second["entries"] is None, "an unchanged cursor must not resend entries"
        assert second["cursor"] == first["cursor"]
    finally:
        owner.stop()


@pytest.mark.asyncio
async def test_input_reaches_the_owner_once(tmp_path):
    owner = FakeOwner()
    path = await owner.start(str(tmp_path / "ctl.sock"))
    try:
        await control.send(_record(owner, path), "agree, start the plan")
        assert owner.texts == ["agree, start the plan"]
    finally:
        owner.stop()


@pytest.mark.asyncio
async def test_pause_and_resume(tmp_path):
    owner = FakeOwner()
    path = await owner.start(str(tmp_path / "ctl.sock"))
    record = _record(owner, path)
    try:
        await control.set_paused(record, True)
        assert owner.paused is True
        await control.set_paused(record, False)
        assert owner.paused is False
        assert owner.pause_calls == ["pause", "resume"]
    finally:
        owner.stop()


@pytest.mark.asyncio
async def test_owner_error_is_reported_as_unconfirmed(tmp_path):
    owner = FakeOwner()
    owner.fail_with = "The original session changed owners or ended."
    path = await owner.start(str(tmp_path / "ctl.sock"))
    try:
        with pytest.raises(control.ControlError) as caught:
            await control.send(_record(owner, path), "hello")
        assert caught.value.code == "unconfirmed"
        assert "changed owners" in str(caught.value)
    finally:
        owner.stop()


@pytest.mark.asyncio
async def test_missing_control_socket_is_its_own_error():
    record = catalog.SessionRecord(
        id="gone", instance=None, control=None, path=None, role="last-order",
        cwd=None, title=None, pid=None, mtime=None,
    )
    with pytest.raises(control.ControlError) as caught:
        await control.snapshot(record)
    assert caught.value.code == "no_control"
