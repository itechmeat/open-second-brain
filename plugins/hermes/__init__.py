"""Hermes Python shim for Open Second Brain.

Most of Open Second Brain runs as a Bun-based MCP server on stdio (registered
via ``hermes mcp_servers`` in ``~/.hermes/config.yaml``). MCP carries every
agent-facing tool surface (``second_brain_status``, ``second_brain_query``,
``vault_health``, plus the Brain writer surface: ``brain_feedback``,
``brain_apply_evidence``, ``brain_note``); §32 (v0.10.8) retires the legacy
``event_log_append`` tool from every runtime, including this one.

This file exists for one Hermes-specific feature that MCP cannot replicate:
the per-turn ``pre_llm_call`` hook, which appends a short identity reminder
to the user message of every turn. Doing it server-side (in MCP
``initialize.instructions``) only fires once per session, not per turn — long
sessions drift away from the reminder.

The shim has no dependency on the TypeScript core. It reads ``agent_name``
from the same plugin config the TS code writes (``~/.config/open-second-brain/config.yaml``).
"""

from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any

PLUGIN_NAME = "open-second-brain"

_REPO_ROOT = Path(__file__).resolve().parents[2]
_TEMPLATES_DIR = _REPO_ROOT / "templates"
_COMMON_TEMPLATE_PATH = _TEMPLATES_DIR / "identity-reminder.txt"
# This shim runs inside Hermes, so the target is fixed at the call site
# rather than threaded through an env var — mirrors the TypeScript
# behaviour where the OpenClaw plugin passes its own target literal.
_TARGET = "hermes"
_TARGET_TEMPLATE_PATH = _TEMPLATES_DIR / f"identity-reminder.{_TARGET}.txt"

_AGENT_LINE_RE = re.compile(r"^\s*(agent_name|agentName)\s*:\s*['\"]?([^'\"\n]+?)['\"]?\s*$", re.MULTILINE)

_template_cache: str | None = None


def _load_reminder_template() -> str:
    """Read the Hermes reminder template, falling back to the common file.

    This shim is hermes-only — it does not honour ``O2B_TARGET``. The
    TypeScript ``buildReminder`` has a three-step resolver (explicit
    target -> env -> common); the Python equivalent collapses to
    ``hermes`` -> common because Hermes always runs the Hermes target.
    Both languages read the same templates on disk and a fixture-pinned
    test catches text drift.

    The body is cached after the first call. Hermes' ``pre_llm_call``
    hook fires every turn; templates are installation-time artifacts
    that do not change at runtime, so a single read per process is
    enough. A gateway restart (every plugin update) flushes the cache.
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


def _config_path() -> Path:
    override = os.environ.get("OPEN_SECOND_BRAIN_CONFIG")
    if override:
        return Path(override).expanduser()
    xdg = os.environ.get("XDG_CONFIG_HOME")
    if xdg:
        return Path(xdg).expanduser() / "open-second-brain" / "config.yaml"
    return Path.home() / ".config" / "open-second-brain" / "config.yaml"


def _resolve_agent_name() -> str:
    """Resolve the agent identity used by ``pre_llm_call``.

    Order: ``VAULT_AGENT_NAME`` env, ``agent_name``/``agentName`` in plugin
    config, then the literal placeholder ``"agent"``. Mirrors
    ``resolveAgentName`` in ``src/core/config.ts``.
    """
    env_value = os.environ.get("VAULT_AGENT_NAME")
    if env_value:
        return env_value
    path = _config_path()
    if not path.is_file():
        return "agent"
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return "agent"
    match = _AGENT_LINE_RE.search(text)
    if match:
        value = match.group(2).strip()
        if value:
            return value
    return "agent"


def on_pre_llm_call(**_kwargs: Any) -> dict[str, str] | None:
    """Inject identity context into the current turn's user message.

    Hermes ``pre_llm_call`` contract: callbacks receive turn metadata and may
    return ``{"context": "..."}`` — Hermes appends the value to the user
    message of this turn (system prompt left untouched, so the cache prefix
    is preserved). Returns ``None`` when no identity is configured, to avoid
    leaking the literal ``@agent`` placeholder into Daily.
    """
    agent = _resolve_agent_name()
    if agent == "agent":
        return None
    template = _load_reminder_template()
    return {"context": template.replace("{agent}", agent)}


def health(repo_root: str | Path | None = None) -> dict[str, Any]:
    """Minimal data-only readiness check.

    Verifies the artifacts Hermes itself depends on (the runner script and
    the OpenClaw bundle that the same repo produces). The TypeScript ``o2b
    doctor`` covers everything else; runtimes that want the full suite
    should call it via the MCP ``vault_health`` tool.
    """
    root = Path(repo_root) if repo_root is not None else Path(__file__).resolve().parents[2]
    checks = {
        "o2b_script": _check_file(root / "scripts" / "o2b", executable=True),
        "openclaw_bundle": _check_file(root / "openclaw" / "index.js"),
        "package_json": _check_file(root / "package.json"),
    }
    ok = all(c["ok"] for c in checks.values())
    return {"name": PLUGIN_NAME, "ok": ok, "checks": checks}


def check_health(repo_root: str | Path | None = None) -> dict[str, Any]:
    """Compatibility alias for runtimes expecting ``check_health``."""
    return health(repo_root=repo_root)


def _check_file(path: Path, *, executable: bool = False) -> dict[str, Any]:
    ok = path.is_file()
    message = "present" if ok else "missing"
    if ok and executable and not os.access(path, os.X_OK):
        ok = False
        message = "not executable"
    return {"ok": ok, "path": str(path), "message": message}


def register(ctx: Any) -> None:
    """Best-effort registration of the health check and the pre_llm_call hook.

    Unsupported context shapes are ignored without raising so a minimal /
    test ``ctx`` won't break plugin loading.
    """
    for method_name in ("register_health_check", "add_health_check", "register_check"):
        method = getattr(ctx, method_name, None)
        if callable(method):
            try:
                method(PLUGIN_NAME, check_health)
            except TypeError:
                method(check_health)
            break
    else:
        health_checks = getattr(ctx, "health_checks", None)
        if isinstance(health_checks, dict):
            health_checks[PLUGIN_NAME] = check_health
        elif isinstance(health_checks, list):
            health_checks.append((PLUGIN_NAME, check_health))

    register_hook = getattr(ctx, "register_hook", None)
    if callable(register_hook):
        try:
            register_hook("pre_llm_call", on_pre_llm_call)
        except Exception:
            pass
