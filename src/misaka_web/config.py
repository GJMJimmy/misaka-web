"""Runtime settings: env first, package defaults second."""

from __future__ import annotations

import os
import secrets
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

PACKAGE_ROOT = Path(__file__).resolve().parent


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    return value if value not in (None, "") else default


def misaka_home() -> Path:
    """The MISAKA home whose state directory this bridge reads (overridable for tests)."""
    override = _env("MISAKA_WEB_MISAKA_HOME")
    if override:
        return Path(override).expanduser()
    try:
        from misaka.config import home as misaka_home_module  # type: ignore[import-not-found]

        return Path(str(misaka_home_module.path("db"))).parent.parent
    except Exception:
        return Path(os.path.expanduser("~")) / ".misaka"


def sessions_root() -> Path:
    return misaka_home() / "state" / "sessions"


def _default_token_file() -> Path:
    base = _env("XDG_CONFIG_HOME") or str(Path(os.path.expanduser("~")) / ".config")
    return Path(base) / "misaka-web" / "token"


@dataclass(frozen=True)
class Settings:
    host: str
    port: int
    token_file: Path
    static_dir: Path
    dev_origin: str | None
    home: Path


@lru_cache(maxsize=1)
def settings() -> Settings:
    return Settings(
        host=str(_env("MISAKA_WEB_HOST", "127.0.0.1")),
        port=int(str(_env("MISAKA_WEB_PORT", "8787"))),
        token_file=Path(str(_env("MISAKA_WEB_TOKEN_FILE", str(_default_token_file())))).expanduser(),
        static_dir=Path(str(_env("MISAKA_WEB_STATIC", str(PACKAGE_ROOT / "static")))).expanduser(),
        dev_origin=_env("MISAKA_WEB_DEV_ORIGIN"),
        home=misaka_home(),
    )


def reset_settings_cache() -> None:
    settings.cache_clear()


def read_token() -> str | None:
    path = settings().token_file
    try:
        text = path.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    return text or None


def generate_token() -> str:
    return secrets.token_urlsafe(32)


def write_token(token: str | None = None) -> tuple[Path, bool]:
    """Write the token with owner-only permissions; returns (path, created)."""
    path = settings().token_file
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if token is not None:
            path.write_text(token + "\n", encoding="utf-8")
            _chmod_600(path)
            return path, False
        return path, False
    path.write_text((token or generate_token()) + "\n", encoding="utf-8")
    _chmod_600(path)
    return path, True


def _chmod_600(path: Path) -> None:
    try:
        os.chmod(path, 0o600)
    except OSError:
        pass
