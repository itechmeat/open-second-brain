"""Native Hermes ``MemoryProvider`` for Open Second Brain.

The provider is a thin orchestrator: it owns a ``BrainBridge`` to the
deterministic TypeScript core and maps the Hermes memory contract onto the
existing ``brain_*`` MCP tools. No deterministic memory logic lives here.

Required surface (this module): ``name``, ``is_available``, ``initialize``,
``get_tool_schemas``, ``handle_tool_call``, ``get_config_schema``,
``save_config``. Lifecycle hooks (prefetch, sync_turn, on_pre_compress, ...)
are added alongside.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from . import config
from ._base import MemoryProvider
from .bridge import BrainBridge, BridgeError, McpBrainBridge

# Curated, memory-relevant subset of the full MCP tool surface. Schemas still
# come from the live server's `tools/list`; only this name allowlist is kept
# locally, which keeps the agent's tool context small (the full server
# advertises 60+ tools) without risking schema drift.
MEMORY_TOOLS: tuple[str, ...] = (
    # writers
    "brain_feedback",
    "brain_apply_evidence",
    "brain_note",
    "brain_pinned_context",
    # recall / query / context
    "brain_query",
    "brain_search",
    "brain_recall_gate",
    "brain_context",
    "brain_context_pack",
    # continuity
    "brain_pre_compact_extract",
)

# Config fields this provider owns, in the order the setup wizard shows them.
_CONFIG_KEYS: tuple[str, ...] = ("vault", "agent_name", "timezone")


class OpenSecondBrainMemoryProvider(MemoryProvider):
    """Open Second Brain as a first-class Hermes memory provider."""

    PROVIDER_NAME = "open-second-brain"

    def __init__(self, bridge: BrainBridge | None = None) -> None:
        self._bridge_override = bridge
        self._bridge: BrainBridge | None = None
        self._hermes_home: str | None = None
        self._session_id: str = ""

    # -- required surface ----------------------------------------------------

    @property
    def name(self) -> str:
        return self.PROVIDER_NAME

    def is_available(self) -> bool:
        """Activation eligibility without network calls: a vault is configured."""
        return config.resolve_vault() is not None

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        """Start the bridge to the TS core. Fail-soft: never break gateway boot."""
        self._session_id = session_id or ""
        self._hermes_home = kwargs.get("hermes_home")
        self._bridge = self._bridge_override or McpBrainBridge(vault=config.resolve_vault())
        try:
            self._bridge.start()
        except Exception:  # noqa: BLE001 - degrade to inert; tool calls surface errors
            pass

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        """Return the memory-relevant subset of the server's advertised tools."""
        if self._bridge is None:
            return []
        try:
            tools = self._bridge.list_tools()
        except Exception:  # noqa: BLE001 - no tools rather than a crash
            return []
        return [t for t in tools if t.get("name") in MEMORY_TOOLS]

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **_kwargs: Any) -> Any:
        """Forward an agent tool invocation to the TS core over the bridge."""
        if self._bridge is None:
            raise BridgeError("memory provider not initialized")
        return self._bridge.call_tool(tool_name, args or {})

    def get_config_schema(self) -> list[dict[str, Any]]:
        return [
            {
                "key": "vault",
                "description": "Path to the Obsidian vault whose Brain/ subtree stores memory.",
                "required": True,
            },
            {
                "key": "agent_name",
                "description": "Agent identity recorded on every Brain write.",
            },
            {
                "key": "timezone",
                "description": "IANA timezone for daily and scheduled Brain operations.",
            },
        ]

    def save_config(self, values: dict[str, Any], hermes_home: str) -> None:
        """Persist non-secret config to the canonical Open Second Brain config.

        The bridge spawns ``o2b mcp``, which resolves the vault from this same
        file, so the provider's config must land here rather than under
        ``hermes_home`` (which scopes only provider-local state).
        """
        path = config.config_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        existing = path.read_text(encoding="utf-8") if path.is_file() else ""
        lines = existing.splitlines()
        for key in _CONFIG_KEYS:
            value = values.get(key)
            if not value:
                continue
            new_line = f'{key}: "{value}"'
            key_re = re.compile(rf"^\s*{re.escape(key)}\s*:")
            for i, line in enumerate(lines):
                if key_re.match(line):
                    lines[i] = new_line
                    break
            else:
                lines.append(new_line)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
