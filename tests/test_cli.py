"""The command line: token minting and the serve entry point."""

from __future__ import annotations

import os
import stat

from misaka_web import __main__ as cli
from misaka_web import config


def test_token_is_created_once_and_not_rotated_by_accident(tmp_path, monkeypatch, capsys):
    target = tmp_path / "cfg" / "token"
    monkeypatch.setenv("MISAKA_WEB_TOKEN_FILE", str(target))
    config.reset_settings_cache()

    assert cli.main(["token"]) == 0
    first = target.read_text(encoding="utf-8").strip()
    assert first
    assert capsys.readouterr().out.startswith("Wrote a new token")

    assert cli.main(["token"]) == 0
    assert target.read_text(encoding="utf-8").strip() == first, "a plain token call must not rotate"
    assert "already present" in capsys.readouterr().out

    assert cli.main(["token", "--rotate"]) == 0
    assert target.read_text(encoding="utf-8").strip() != first


def test_token_file_is_owner_only(tmp_path, monkeypatch):
    target = tmp_path / "cfg" / "token"
    monkeypatch.setenv("MISAKA_WEB_TOKEN_FILE", str(target))
    config.reset_settings_cache()
    cli.main(["token"])
    if os.name == "posix":
        assert stat.S_IMODE(target.stat().st_mode) == 0o600


def test_version_flag_exits_cleanly(capsys):
    try:
        cli.main(["--version"])
    except SystemExit as exit_code:
        assert exit_code.code == 0
    assert "misaka-web" in capsys.readouterr().out
