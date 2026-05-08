"""Hermes adapter for Open Second Brain runtime health checks.

The adapter intentionally avoids depending on Hermes internals. It exposes small,
deterministic health helpers that Hermes (or any other runtime) can call directly,
and ``register(ctx)`` makes a best-effort attempt to attach the health check to
common plugin context shapes.
"""

from __future__ import annotations

import json
import os
import re
from pathlib import Path
from typing import Any, Callable


HealthReport = dict[str, Any]


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[2]


def _check_file(path: Path, *, executable: bool = False) -> HealthReport:
    ok = path.is_file()
    message = "present" if ok else "missing"
    if ok and executable and not os.access(path, os.X_OK):
        ok = False
        message = "not executable"
    return {"ok": ok, "path": str(path), "message": message}


def _check_json(path: Path) -> HealthReport:
    base = _check_file(path)
    if not base["ok"]:
        return base
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        return {"ok": False, "path": str(path), "message": f"invalid JSON: {exc}"}
    if isinstance(data, dict):
        return {"ok": True, "path": str(path), "message": "valid JSON object"}
    return {"ok": False, "path": str(path), "message": "JSON is not an object"}


def _check_text_manifest(path: Path) -> HealthReport:
    base = _check_file(path)
    if not base["ok"]:
        return base
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeDecodeError) as exc:
        return {"ok": False, "path": str(path), "message": f"unreadable: {exc}"}
    required = ("name", "version", "description")
    missing = [field for field in required if not re.search(rf"^{field}\s*:", text, re.MULTILINE)]
    if missing:
        return {"ok": False, "path": str(path), "message": "missing fields: " + ", ".join(missing)}
    return {"ok": True, "path": str(path), "message": "readable manifest"}


def health(repo_root: str | Path | None = None) -> HealthReport:
    """Return deterministic Open Second Brain plugin health.

    The report is data-only so it is safe to serialize in runtimes that do not
    know this package. No background processes are started and no files are
    written.
    """

    root = Path(repo_root) if repo_root is not None else _repo_root()
    checks = {
        "hermes_manifest": _check_text_manifest(root / "plugins" / "hermes" / "plugin.yaml"),
        "claude_manifest": _check_json(root / ".claude-plugin" / "plugin.json"),
        "codex_manifest": _check_json(root / ".codex-plugin" / "plugin.json"),
        "openclaw_manifest": _check_json(root / "openclaw.plugin.json"),
        "o2b_script": _check_file(root / "scripts" / "o2b", executable=True),
        "vault_log_script": _check_file(root / "scripts" / "vault-log", executable=True),
    }
    ok = all(bool(check["ok"]) for check in checks.values())
    return {"name": "open-second-brain", "ok": ok, "checks": checks}


def check_health(repo_root: str | Path | None = None) -> HealthReport:
    """Compatibility alias for runtimes expecting a check_health callable."""

    return health(repo_root=repo_root)


def _attach_health(ctx: Any, callback: Callable[[], HealthReport]) -> bool:
    for method_name in ("register_health_check", "add_health_check", "register_check"):
        method = getattr(ctx, method_name, None)
        if callable(method):
            try:
                method("open-second-brain", callback)
            except TypeError:
                method(callback)
            return True

    health_checks = getattr(ctx, "health_checks", None)
    if isinstance(health_checks, dict):
        health_checks["open-second-brain"] = callback
        return True
    if isinstance(health_checks, list):
        health_checks.append(("open-second-brain", callback))
        return True

    try:
        setattr(ctx, "open_second_brain_health", callback)
    except Exception:
        return False
    return True


_PRE_LLM_CALL_TEMPLATE = (
    "[open-second-brain] Identity: @{agent}. After producing a durable "
    "artifact — code shipped, bug fixed, config or deployment change, "
    "instruction-file edit, content artifact created, research finding "
    "or design decision reached, investigation that surfaced a fact "
    "future sessions should know — call the event_log_append tool with "
    "the plain event description as `message`. The server prepends "
    "timestamp and `@{agent}` automatically, do not include them "
    "yourself. Skip pure discussion, exploration, read-only queries, "
    "and planning that hasn't yet produced an artifact."
)


def on_pre_llm_call(**kwargs: Any) -> dict[str, str] | None:
    """Plugin context injected into the current turn's user message.

    The Hermes ``pre_llm_call`` hook contract: callbacks receive the turn
    metadata as keyword arguments and may return ``{"context": "..."}`` —
    Hermes appends the value to the user message of this turn (system prompt
    is left untouched, so the cache prefix is preserved).

    Returns ``None`` (skipping injection) when the agent identity is not
    configured, because the only thing we'd otherwise inject is the literal
    ``@agent`` placeholder, which is worse than silence.
    """
    try:
        from open_second_brain.config import resolve_agent_name
    except ImportError:
        return None
    agent = resolve_agent_name()
    if agent == "agent":
        return None
    return {"context": _PRE_LLM_CALL_TEMPLATE.format(agent=agent)}


def register(ctx: Any) -> None:
    """Register Hermes-side hooks when the context supports them.

    Best-effort: unsupported context shapes are ignored without raising, so a
    minimal/test ``ctx`` won't break plugin loading.
    """

    try:
        _attach_health(ctx, check_health)
    except Exception:
        pass

    register_hook = getattr(ctx, "register_hook", None)
    if callable(register_hook):
        try:
            register_hook("pre_llm_call", on_pre_llm_call)
        except Exception:
            pass
    return None
