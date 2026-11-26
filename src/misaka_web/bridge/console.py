"""The settings console: provider/model, API keys, Sisters and project folders.

Everything here writes MISAKA's home on purpose (that is the feature), so each writer goes
through the same upstream API the wizard uses: env.write for keys, SettingsManager and
profiles.persist_* for model choices, roster.create_sister/remove_sister for Sisters,
cards.init_project for a project. Nothing formats those files by hand.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from pathlib import Path
from typing import Any

from .. import config
from . import runs as board

ROLE_LAST_ORDER = "last-order"
SISTER_PREFIX = "sister:"

# Only these may be written through the web UI. Adding one is a deliberate edit here.
KEY_WHITELIST = {
    "DEEPSEEK_API_KEY": "DeepSeek",
    "OPENAI_API_KEY": "OpenAI",
    "ANTHROPIC_API_KEY": "Anthropic",
    "GOOGLE_API_KEY": "Google (Gemini)",
    "GEMINI_API_KEY": "Google (Gemini, legacy name)",
    "XAI_API_KEY": "xAI",
    "OPENROUTER_API_KEY": "OpenRouter",
    "MISTRAL_API_KEY": "Mistral",
    "GROQ_API_KEY": "Groq",
    "MOONSHOT_API_KEY": "Moonshot",
    "DASHSCOPE_API_KEY": "Alibaba DashScope",
    "TAVILY_API_KEY": "Tavily (web search)",
    "EXA_API_KEY": "Exa (web search)",
    "BRAVE_SEARCH_API_KEY": "Brave (web search)",
    "FIRECRAWL_API_KEY": "Firecrawl (web)",
    "PERPLEXITY_API_KEY": "Perplexity (web)",
    "PARALLEL_API_KEY": "Parallel (web)",
}

NAME_RE = re.compile(r"^[A-Za-z0-9][\w.-]{0,39}$")
PROJECT_NAME_RE = re.compile(r"^[\w.\u4e00-\u9fff-]{1,60}$")


class SettingsError(ValueError):
    """A refusal meant for the person: bad name, unknown model, not configured."""


def _modules() -> dict[str, Any]:
    try:
        from misaka.config import env as env_file
        from misaka.config import profiles
        from misaka.core.network import roster
        from misaka.core.platform import cards
        from misaka.core.settings_manager import SettingsManager
    except Exception as error:  # noqa: BLE001
        raise board.BoardUnavailable(
            "The settings console needs MISAKA in this environment (pip install '.[research]'): "
            + (str(error) or error.__class__.__name__)
        ) from error
    return {"env": env_file, "profiles": profiles, "roster": roster, "cards": cards, "SettingsManager": SettingsManager}


def _cfg() -> Any:
    try:
        from misaka.config import current_config
    except Exception as error:  # noqa: BLE001
        raise board.BoardUnavailable(str(error) or "MISAKA is not importable here") from error
    return current_config()


async def _runtime():
    try:
        from misaka.cli.auth_overview import create_auth_runtime
    except Exception as error:  # noqa: BLE001
        raise board.BoardUnavailable(str(error) or "MISAKA is not importable here") from error
    # read_only: the console reads the catalog and credential status; it never refreshes tokens
    auth_runtime = await create_auth_runtime(read_only=True, refresh=False)
    return auth_runtime.runtime


def _role_dir(role: str) -> str:
    cfg = _cfg()
    if role == ROLE_LAST_ORDER:
        return os.path.join(cfg["roles_root"], "last_order")
    if role.startswith(SISTER_PREFIX) and NAME_RE.match(role[len(SISTER_PREFIX):]):
        return os.path.join(cfg["profiles_root"], role[len(SISTER_PREFIX):])
    raise SettingsError(f"Unknown role: {role}")


def _role_settings(role_dir: str) -> dict[str, Any]:
    path = Path(role_dir) / "settings.json"
    if not path.is_file():
        return {}
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return value if isinstance(value, dict) else {}


async def model_state() -> dict[str, Any]:
    runtime = await _runtime()
    cfg = _cfg()
    providers = []
    for provider in sorted(runtime.getProviders(), key=lambda item: item.id):
        status = runtime.getProviderAuthStatus(provider.id)
        providers.append({
            "id": provider.id,
            "name": getattr(provider, "name", None) or provider.id,
            "configured": bool(getattr(status, "configured", False)),
            "source": getattr(status, "source", None),
            "keyless": bool(getattr(provider, "auth", None) and getattr(provider.auth, "apiKey", None) is None
                            and getattr(provider.auth, "oauth", None) is None),
            "model_count": len(runtime.getModels(provider.id)),
        })
    home_settings = Path(cfg["roles_root"]).parent / "settings.json"
    settings: dict[str, Any] = {}
    if home_settings.is_file():
        try:
            settings = json.loads(home_settings.read_text(encoding="utf-8")) or {}
        except (OSError, ValueError):
            settings = {}
    roles = [{"role": ROLE_LAST_ORDER, "settings": _role_settings(_role_dir(ROLE_LAST_ORDER))}]
    for sid in _modules()["roster"].roster_names(root=cfg["profiles_root"]):
        roles.append({"role": SISTER_PREFIX + sid, "settings": _role_settings(_role_dir(SISTER_PREFIX + sid))})
    return {
        "global": {
            "provider": settings.get("defaultProvider"),
            "model": settings.get("defaultModel"),
            "thinking": settings.get("defaultThinkingLevel"),
        },
        "roles": roles,
        "providers": providers,
    }


async def models_of(provider: str) -> dict[str, Any]:
    runtime = await _runtime()
    known = [model for model in runtime.getModels(provider)]
    if not known:
        # A provider this install knows but carries no models is not an error: the UI shows an
        # empty list. Only a name nobody knows is refused.
        if not any(item.id == provider for item in runtime.getProviders()):
            raise SettingsError(f"Unknown provider: {provider}")
    return {
        "provider": provider,
        "models": [{"id": model.id, "name": getattr(model, "name", None) or model.id} for model in known],
    }


async def set_model(provider: str, model: str, *, role: str | None = None) -> dict[str, Any]:
    provider, model = str(provider or "").strip(), str(model or "").strip()
    if not provider or not model:
        # An empty choice for a role means "follow the global default": drop her pin.
        if role:
            target = _role_dir(role)
            settings = _role_settings(target)
            settings.pop("defaultProvider", None)
            settings.pop("defaultModel", None)
            path = Path(target) / "settings.json"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
            return {"ok": True, "role": role, "provider": None, "model": None, "follows_global": True}
        raise SettingsError("Both provider and model are required.")
    runtime = await _runtime()
    known = {item.id for item in runtime.getModels(provider)}
    if model not in known:
        raise SettingsError(f"{provider}/{model} is not in this install's model catalog.")
    modules = _modules()
    reference = f"{provider}/{model}"
    if role:
        target = _role_dir(role)
        os.makedirs(target, exist_ok=True)
        modules["profiles"].persist_role_default_model(target, reference, strict=True)
    else:
        # cwd whose project layer is <home>/.misaka/settings.json, so only the global file is written
        cwd = str(Path(_cfg()["roles_root"]).parent)
        modules["SettingsManager"].create(cwd).setDefaultModelAndProvider(provider, model)
    return {"ok": True, "role": role or "global", "provider": provider, "model": model}


def _env_path() -> Path:
    return Path(_modules()["env"].path())


def _env_values() -> dict[str, str]:
    path = _env_path()
    if not path.is_file():
        return {}
    try:
        return _modules()["env"].parse(path.read_text(encoding="utf-8-sig"), source=str(path))
    except Exception:  # noqa: BLE001 - an unreadable .env simply reports nothing as set
        return {}


def _hint(value: str) -> str:
    value = value.strip()
    if not value:
        return ""
    head = value[:4]
    return f"{head}… ({len(value)} chars)"


def key_state() -> dict[str, Any]:
    _modules()
    values = _env_values()
    entries = []
    for name, label in sorted(KEY_WHITELIST.items()):
        stored = values.get(name, "")
        from_shell = bool(os.environ.get(name))
        entries.append({
            "name": name,
            "label": label,
            "configured": bool(stored or from_shell),
            "source": "env file" if stored else ("shell environment" if from_shell else None),
            "hint": _hint(stored) if stored else "",
        })
    return {"path": str(_env_path()), "keys": entries}


def set_key(name: str, value: str) -> dict[str, Any]:
    modules = _modules()
    if name not in KEY_WHITELIST:
        raise SettingsError(f"{name} is not a key this console manages.")
    text = str(value or "").strip()
    if len(text) < 8:
        raise SettingsError("That does not look like an API key (shorter than 8 characters).")
    modules["env"].write({name: text})
    return {"ok": True, "name": name, "hint": _hint(text)}


def clear_key(name: str) -> dict[str, Any]:
    modules = _modules()
    if name not in KEY_WHITELIST:
        raise SettingsError(f"{name} is not a key this console manages.")
    modules["env"].write({}, remove=(name,))
    return {"ok": True, "name": name}


def _describe_path(sid: str) -> Path:
    return Path(_cfg()["profiles_root"]) / sid / "DESCRIBE.md"


def _write_describe(sid: str, specialty: str) -> None:
    """Rewrite the frontmatter description; keep a body the user edited."""
    from misaka.core.network.roster import DESCRIBE_TEMPLATE

    path = _describe_path(sid)
    quoted = json.dumps(specialty, ensure_ascii=False)
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(DESCRIBE_TEMPLATE.format(sid=sid, specialty=quoted, specialty_line=specialty or "Not specified yet."), encoding="utf-8")
        return
    text = path.read_text(encoding="utf-8")
    lines = text.split("\n")
    if lines and lines[0].strip() == "---":
        for index in range(1, len(lines)):
            if lines[index].strip() == "---":
                break
            if lines[index].startswith("description:"):
                lines[index] = f"description: {quoted}"
                break
        else:
            lines.insert(1, f"description: {quoted}")
    else:
        lines = ["---", f"description: {quoted}", "---", *lines]
    body = "\n".join(lines)
    if "Add concrete routing guidance here." in body:
        body = body.replace("- Not specified yet.", f"- {specialty or 'Not specified yet.'}")
    path.write_text(body, encoding="utf-8")


def sisters() -> list[dict[str, Any]]:
    modules = _modules()
    cfg = _cfg()
    roster = modules["roster"]
    profiles = modules["profiles"]
    out = []
    for sid in roster.roster_names(root=cfg["profiles_root"]):
        role_dir = os.path.join(cfg["profiles_root"], sid)
        description, _body = roster.describe(sid, root=cfg["profiles_root"])
        settings = _role_settings(role_dir)
        out.append({
            "id": sid,
            "specialty": description or "",
            "model": profiles.pinned_model(role_dir) or "",
            "thinking": settings.get("defaultThinkingLevel") or "",
        })
    return out


def create_sister(sid: str, *, specialty: str = "", model: str = "", thinking: str = "") -> dict[str, Any]:
    modules = _modules()
    sid = str(sid or "").strip()
    if not NAME_RE.match(sid):
        raise SettingsError("A Sister id is a short name: letters, digits, dot, dash or underscore.")
    cfg = _cfg()
    ok, message = modules["roster"].create_sister(
        sid,
        root=cfg["profiles_root"],
        specialty=(specialty or "").strip() or None,
        model=(model or "").strip() or None,
        thinking=(thinking or "").strip() or None,
    )
    if not ok:
        raise SettingsError(message)
    return {"ok": True, "id": sid, "message": message}


def update_sister(sid: str, *, specialty: str | None = None, model: str | None = None,
                  thinking: str | None = None) -> dict[str, Any]:
    modules = _modules()
    cfg = _cfg()
    if sid not in modules["roster"].roster_names(root=cfg["profiles_root"]):
        raise SettingsError(f"Sister {sid} is not registered.")
    role_dir = os.path.join(cfg["profiles_root"], sid)
    changed = []
    if specialty is not None:
        _write_describe(sid, str(specialty).strip())
        changed.append("specialty")
    if model is not None:
        reference = str(model).strip()
        if reference:
            modules["profiles"].persist_role_default_model(role_dir, reference, strict=True)
        else:
            # an empty value clears the pin, so she follows the global default again
            settings = _role_settings(role_dir)
            settings.pop("defaultProvider", None)
            settings.pop("defaultModel", None)
            Path(role_dir, "settings.json").write_text(json.dumps(settings, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        changed.append("model")
    if thinking is not None:
        level = str(thinking).strip()
        if level:
            modules["profiles"].persist_role_thinking_level(role_dir, level)
        changed.append("thinking")
    return {"ok": True, "id": sid, "changed": changed}


def remove_sister(sid: str) -> dict[str, Any]:
    modules = _modules()
    cfg = _cfg()
    ok, message = modules["roster"].remove_sister(sid, root=cfg["profiles_root"])
    if not ok:
        raise SettingsError(message)
    return {"ok": True, "id": sid, "message": message}


def projects() -> dict[str, Any]:
    root = Path(str(os.environ.get("MISAKA_WEB_WORKSPACE_ROOT") or (Path(os.path.expanduser("~")) / "Documents")))
    root = root.expanduser().resolve()
    by_workspace: dict[str, int] = {}
    try:
        for run in board.list_runs():
            by_workspace[run["workspace"]] = by_workspace.get(run["workspace"], 0) + 1
    except Exception:  # noqa: BLE001 - no board yet is fine here
        pass
    artifact_dirs = {"nodes", "final", "cards", "downloads", "sources", ".misaka", "shared"}
    entries = []
    if root.is_dir():
        for child in sorted(root.iterdir(), key=lambda item: item.name.lower()):
            if not child.is_dir() or child.name.startswith(".") or child.name in artifact_dirs:
                continue
            looks_like_project = (
                (child / "PROJECT.md").is_file() or (child / ".git").exists() or (child / "sources").is_dir()
            )
            if not looks_like_project:
                continue
            entries.append({
                "name": child.name,
                "path": str(child),
                "has_project_md": (child / "PROJECT.md").is_file(),
                "is_git": (child / ".git").exists(),
                "has_sources": (child / "sources").is_dir(),
                "runs": by_workspace.get(str(child), 0),
            })
    return {"root": str(root), "projects": entries}


def create_project(name: str, *, git: bool = True) -> dict[str, Any]:
    modules = _modules()
    clean = str(name or "").strip()
    if not clean or not PROJECT_NAME_RE.match(clean) or clean in {".", ".."}:
        raise SettingsError("A project name is a folder name: letters, digits, CJK, dot, dash or underscore.")
    root = Path(str(os.environ.get("MISAKA_WEB_WORKSPACE_ROOT") or (Path(os.path.expanduser("~")) / "Documents")))
    root = root.expanduser().resolve()
    root.mkdir(parents=True, exist_ok=True)
    folder = (root / clean).resolve()
    if folder.parent != root:
        raise SettingsError("A project lives directly under the workspace root.")
    if folder.exists() and any(folder.iterdir()):
        raise SettingsError(f"{folder} already exists and is not empty.")
    folder.mkdir(parents=True, exist_ok=True)
    (folder / "sources").mkdir(exist_ok=True)
    actions = modules["cards"].init_project(str(folder), draft_brief=True, git=git)
    return {"ok": True, "name": clean, "path": str(folder), "actions": list(actions)}