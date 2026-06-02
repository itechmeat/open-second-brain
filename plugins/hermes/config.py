"""Shared configuration and identity-reminder helpers for the Hermes plugin.

These helpers read the same plugin config the TypeScript core writes
(``~/.config/open-second-brain/config.yaml``) without a YAML dependency, and
load the per-turn identity-reminder template. They are the single source of
truth for both the native memory provider (``provider.py``) and the legacy
``register``/health surface in ``__init__.py`` so the two never drift.

Resolution order mirrors ``src/core/config.ts`` exactly:
- agent name: ``VAULT_AGENT_NAME`` env -> ``agent_name``/``agentName`` -> ``"agent"``
- vault:      ``VAULT_DIR`` env -> ``vault`` field -> ``None``
- timezone:   ``timezone`` field -> ``None``
"""

from __future__ import annotations

import os
import json
import re
from pathlib import Path

PLUGIN_NAME = "open-second-brain"
DEFAULT_AGENT = "agent"

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TEMPLATES_DIR = _REPO_ROOT / "templates"
_COMMON_TEMPLATE_PATH = _TEMPLATES_DIR / "identity-reminder.txt"
# This package runs inside Hermes, so the reminder target is fixed at the call
# site (mirrors the TypeScript behaviour where each runtime passes its own
# target literal). The Python side collapses to hermes -> common.
_TARGET = "hermes"
_TARGET_TEMPLATE_PATH = _TEMPLATES_DIR / f"identity-reminder.{_TARGET}.txt"

_template_cache: str | None = None


def config_path() -> Path:
    """Resolve the plugin config path (``OPEN_SECOND_BRAIN_CONFIG`` -> XDG -> ~)."""
    override = os.environ.get("OPEN_SECOND_BRAIN_CONFIG")
    if override:
        return Path(override).expanduser()
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg).expanduser() / "open-second-brain" / "config.yaml"
    return Path.home() / ".config" / "open-second-brain" / "config.yaml"


def _config_text() -> str | None:
    path = config_path()
    if not path.is_file():
        return None
    try:
        return path.read_text(encoding="utf-8")
    except OSError:
        return None


def _config_value(*keys: str) -> str | None:
    """Read the first matching ``key: value`` line for any of ``keys``.

    Deliberately tiny: the plugin config is a flat key/value YAML written by
    the TypeScript core, so a per-key line regex avoids a YAML dependency
    (the project ships ``dependencies = []``).
    """
    text = _config_text()
    if text is None:
        return None
    alternation = "|".join(re.escape(k) for k in keys)
    pattern = re.compile(rf"^\s*(?:{alternation})\s*:\s*(.+?)\s*$", re.MULTILINE)
    match = pattern.search(text)
    if not match:
        return None
    raw = match.group(1).strip()
    if not raw:
        return None
    # `save_config` writes a JSON-encoded double-quoted scalar (valid YAML), so
    # decode that form to recover embedded quotes / backslashes; fall back to a
    # bare or single-quoted scalar for hand-written or TypeScript-written config.
    if raw.startswith('"'):
        try:
            return json.loads(raw) or None
        except json.JSONDecodeError:
            return raw.strip('"') or None
    return raw.strip("'") or None


def resolve_agent_name() -> str:
    """Resolve the agent identity, mirroring ``resolveAgentName`` in TypeScript."""
    env_value = os.environ.get("VAULT_AGENT_NAME")
    if env_value:
        return env_value
    return _config_value("agent_name", "agentName") or DEFAULT_AGENT


def resolve_vault() -> str | None:
    """Resolve the vault path, mirroring ``resolveVault`` in TypeScript."""
    env_value = os.environ.get("VAULT_DIR")
    if env_value:
        return env_value
    return _config_value("vault")


def resolve_timezone() -> str | None:
    """Resolve the configured timezone, or ``None`` when unset."""
    return _config_value("timezone")


def load_reminder_template() -> str:
    """Read the Hermes reminder template, falling back to the common file.

    Cached after the first call: the template is an installation-time artifact
    that does not change at runtime, and a gateway restart (every plugin
    update) flushes the cache by starting a fresh process.
    """
    global _template_cache
    if _template_cache is not None:
        return _template_cache
    if _TARGET_TEMPLATE_PATH.is_file():
        _template_cache = _TARGET_TEMPLATE_PATH.read_text(encoding="utf-8").rstrip()
    else:
        _template_cache = _COMMON_TEMPLATE_PATH.read_text(encoding="utf-8").rstrip()
    return _template_cache


def _reset_template_cache_for_tests() -> None:
    """Test-only: drop the cached body so a fixture rewrite is visible."""
    global _template_cache
    _template_cache = None


def render_reminder(agent: str) -> str:
    """Substitute every ``{agent}`` placeholder in the reminder template."""
    return load_reminder_template().replace("{agent}", agent)


def build_reminder() -> str | None:
    """Render the identity reminder for the configured agent.

    Returns ``None`` when no identity is configured, so the literal ``@agent``
    placeholder never leaks into a user-facing turn.
    """
    agent = resolve_agent_name()
    if agent == DEFAULT_AGENT:
        return None
    return render_reminder(agent)
