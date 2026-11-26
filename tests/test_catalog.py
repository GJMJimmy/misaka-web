"""Session discovery reads MISAKA's catalog index and nothing else."""

from __future__ import annotations

import pytest

from helpers import write_record
from misaka_web.bridge import catalog


def test_reads_records_from_the_catalog_index(temp_home):
    write_record(temp_home["home"], session_id="sess-a", control=None)
    records = catalog.load_records()
    assert [record.id for record in records] == ["sess-a"]
    api = records[0].as_api()
    assert api == {
        "id": "sess-a",
        "role": "last-order",
        "cwd": "/research",
        "state": "saved",
        "title": None,
        "has_control": False,
        "last_activity": api["last_activity"],
    }


def test_control_socket_that_exists_means_live(temp_home, tmp_path):
    socket_file = tmp_path / "live.sock"
    socket_file.write_text("placeholder", encoding="utf-8")
    write_record(temp_home["home"], session_id="sess-live", control=str(socket_file))
    record = catalog.require("sess-live")
    assert record.has_control is True
    assert record.as_api()["state"] == "live"


def test_unknown_session_raises(temp_home):
    with pytest.raises(catalog.UnknownSession):
        catalog.require("nope")


def test_corrupt_record_is_skipped(temp_home):
    directory = temp_home["home"] / "state" / "sessions" / ".catalog"
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "broken.json").write_text("{not json", encoding="utf-8")
    write_record(temp_home["home"], session_id="sess-ok", control=None)
    assert [record.id for record in catalog.load_records()] == ["sess-ok"]
