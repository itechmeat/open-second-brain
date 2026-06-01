"""Hermes Python plugin for Open Second Brain.

Most of Open Second Brain runs as a Bun-based MCP server on stdio. The Hermes
integration loads this package in-process: ``register`` wires the plugin into
the gateway, and the per-turn ``pre_llm_call`` hook appends a short identity
reminder to the user message of every turn (doing it server-side only fires
once per session, not per turn - long sessions drift away from the reminder).

Shared config and reminder helpers live in ``config.py`` so the provider
(``provider.py``) and this module never drift. The native ``MemoryProvider``
implementation and its bridge live in ``provider.py`` / ``bridge.py``.
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from . import config

PLUGIN_NAME = config.PLUGIN_NAME

# Backwards-compatible aliases: callers and tests historically imported these
# names from the package root. They now delegate to the shared helpers.
_load_reminder_template = config.load_reminder_template
_reset_template_cache_for_tests = config._reset_template_cache_for_tests
_config_path = config.config_path
_resolve_agent_name = config.resolve_agent_name


def on_pre_llm_call(**_kwargs: Any) -> dict[str, str] | None:
    """Inject identity context into the current turn's user message.

    Hermes ``pre_llm_call`` contract: callbacks receive turn metadata and may
    return ``{"context": "..."}`` - Hermes appends the value to the user
    message of this turn (system prompt left untouched, so the cache prefix is
    preserved). Returns ``None`` when no identity is configured, to avoid
    leaking the literal ``@agent`` placeholder.
    """
    reminder = config.build_reminder()
    if reminder is None:
        return None
    return {"context": reminder}


def health(repo_root: str | Path | None = None) -> dict[str, Any]:
    """Minimal data-only readiness check.

    Verifies the artifacts Hermes itself depends on (the runner script and the
    OpenClaw bundle that the same repo produces). The TypeScript ``o2b doctor``
    covers everything else; runtimes that want the full suite call it via the
    MCP ``vault_health`` tool.
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

    Unsupported context shapes are ignored without raising so a minimal / test
    ``ctx`` won't break plugin loading.
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


__all__ = [
    "PLUGIN_NAME",
    "on_pre_llm_call",
    "health",
    "check_health",
    "register",
]
