"""Hermes plugin package for Open Second Brain.

Open Second Brain integrates with Hermes as a native memory provider. Hermes
loads this package in-process and calls ``register``, which wires two things
into the gateway:

- the ``OpenSecondBrainMemoryProvider`` (``provider.py``), a first-class Hermes
  memory provider backed by an ``o2b mcp`` bridge (``bridge.py``); and
- a small data-only health check.

The provider's ``prefetch`` carries the per-turn identity reminder that the
retired ``pre_llm_call`` hook used to inject, so there is one mechanism, not
two. Shared config and reminder helpers live in ``config.py``.
"""

from __future__ import annotations

import logging
import os
from pathlib import Path
from typing import Any

from . import config
from .bridge import BrainBridge, FakeBrainBridge, McpBrainBridge
from .cli import register_cli
from .provider import OpenSecondBrainMemoryProvider

logger = logging.getLogger(__name__)

PLUGIN_NAME = config.PLUGIN_NAME


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


def _register_health_check(ctx: Any) -> None:
    for method_name in ("register_health_check", "add_health_check", "register_check"):
        method = getattr(ctx, method_name, None)
        if callable(method):
            try:
                method(PLUGIN_NAME, check_health)
            except TypeError:
                method(check_health)
            return
    health_checks = getattr(ctx, "health_checks", None)
    if isinstance(health_checks, dict):
        health_checks[PLUGIN_NAME] = check_health
    elif isinstance(health_checks, list):
        health_checks.append((PLUGIN_NAME, check_health))


def _register_memory_provider(ctx: Any) -> None:
    """Hand the provider to the gateway, or say why there is none.

    Plugin loading still survives a construction failure - one broken plugin
    must not take the gateway down - but it no longer survives it silently.
    Swallowing here produced the worst possible outcome: no provider, no
    registration, and no diagnostic anywhere, so the host had nothing to show
    and nothing to blame.
    """
    method = getattr(ctx, "register_memory_provider", None)
    if not callable(method):
        logger.warning(
            "%s: host context exposes no register_memory_provider(); "
            "the memory provider is not registered",
            PLUGIN_NAME,
        )
        return
    try:
        method(OpenSecondBrainMemoryProvider())
    except Exception:  # noqa: BLE001 - never break plugin loading
        logger.error(
            "%s: memory provider could not be registered; "
            "Open Second Brain memory is unavailable this session",
            PLUGIN_NAME,
            exc_info=True,
        )


def register(ctx: Any) -> None:
    """Register the memory provider and health check.

    Unsupported context shapes are ignored without raising so a minimal / test
    ``ctx`` won't break plugin loading.
    """
    _register_health_check(ctx)
    _register_memory_provider(ctx)


__all__ = [
    "PLUGIN_NAME",
    "health",
    "check_health",
    "register",
    "register_cli",
    "OpenSecondBrainMemoryProvider",
    "BrainBridge",
    "McpBrainBridge",
    "FakeBrainBridge",
]
