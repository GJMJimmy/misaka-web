"""The pre-flight checks a deploy gets wrong at least once."""

from __future__ import annotations

from misaka_web import doctor


def test_doctor_reports_a_healthy_install(temp_home):
    (temp_home["static"] / "index.html").write_text("<html></html>", encoding="utf-8")
    checks = {check["name"]: check for check in doctor.run_checks()}
    assert checks["token"]["ok"] is True
    assert checks["ui build"]["ok"] is True
    assert checks["misaka package"]["ok"] is True, checks["misaka package"]["detail"]
    assert checks["workspace root"]["ok"] is True
    assert "control sockets" in checks


def test_doctor_fails_without_a_token(temp_home, monkeypatch):
    from misaka_web import config

    monkeypatch.setenv("MISAKA_WEB_TOKEN_FILE", str(temp_home["home"] / "absent" / "token"))
    config.reset_settings_cache()
    checks = {check["name"]: check for check in doctor.run_checks()}
    assert checks["token"]["ok"] is False
    assert doctor.main() == 1


def test_doctor_flags_a_missing_ui_build(temp_home):
    checks = {check["name"]: check for check in doctor.run_checks()}
    assert checks["ui build"]["ok"] is False
    assert "sync-web" in checks["ui build"]["detail"]
