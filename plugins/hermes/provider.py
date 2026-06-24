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

import json
import re
import threading
from pathlib import Path
from typing import Any

from . import config
from ._base import MemoryProvider
from ._schemas import static_tool_schemas
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

# Token budget for the recall slice fetched on each prefetch.
_PREFETCH_MAX_TOKENS = 1024


class OpenSecondBrainMemoryProvider(MemoryProvider):
    """Open Second Brain as a first-class Hermes memory provider."""

    PROVIDER_NAME = "open-second-brain"

    def __init__(self, bridge: BrainBridge | None = None) -> None:
        self._bridge_override = bridge
        self._bridge: BrainBridge | None = None
        self._hermes_home: str | None = None
        self._session_id: str = ""
        self._buffer: list[tuple[str, str]] = []
        self._lock = threading.Lock()
        self._sync_threads: list[threading.Thread] = []
        self._queued_query: str = ""

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
        if self._bridge is not None:
            # Re-initialization (a new session on a reused instance) must not
            # leak the previous bridge's subprocess.
            try:
                self._bridge.stop()
            except Exception:  # noqa: BLE001
                pass
        self._bridge = self._bridge_override or McpBrainBridge(
            vault=config.resolve_vault(),
            repo_root=self._repo_root(),
        )
        try:
            self._bridge.start()
        except Exception:  # noqa: BLE001 - degrade to inert; tool calls surface errors
            pass

    @staticmethod
    def _repo_root() -> str | None:
        """Plugin checkout root that ships ``skills/`` (provider lives at
        ``<root>/plugins/hermes/provider.py``). Passed as ``--repo`` so the TS
        core's ``repoRoot`` resolves and in-repo skills become discoverable;
        without it ``skill_auto_attach`` returns an empty list."""
        root = Path(__file__).resolve().parents[2]
        return str(root) if (root / "skills").is_dir() else None

    def get_tool_schemas(self) -> list[dict[str, Any]]:
        """Return the memory-relevant subset of the server's advertised tools.

        Hermes builds its tool routing table from this method at provider
        registration time, BEFORE ``initialize()`` starts the bridge. The
        vendored static schemas cover that window (and a failed live listing),
        so the provider never registers with zero tools; once the bridge is
        up, live schemas from ``tools/list`` win.
        """
        if self._bridge is None:
            return static_tool_schemas()
        try:
            tools = self._bridge.list_tools()
        except Exception:  # noqa: BLE001 - static fallback rather than a crash
            return static_tool_schemas()
        return [t for t in tools if t.get("name") in MEMORY_TOOLS]

    def handle_tool_call(self, tool_name: str, args: dict[str, Any], **_kwargs: Any) -> str:
        """Forward an agent tool invocation to the TS core over the bridge.

        Hermes feeds the return value back to the model as tool-message
        content, and the chat-completions contract requires that content to
        be a string. The bridge yields the MCP ``tools/call`` result dict, so
        it is serialized here. Lenient providers (Anthropic) tolerate a raw
        dict, which is why this leaked undetected; strict ones (DeepSeek)
        reject it with HTTP 400. Coercing at this boundary - not in the
        caller - is what makes the provider portable across both.
        """
        if self._bridge is None:
            raise BridgeError("memory provider not initialized")
        if tool_name not in MEMORY_TOOLS:
            # Enforce the curated surface at execution time, not just discovery.
            raise BridgeError(f"unsupported memory tool: {tool_name}")
        return self._as_tool_content(self._bridge.call_tool(tool_name, args or {}))

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
            # Serialize as a JSON scalar (valid YAML) so quotes, backslashes
            # (Windows paths), and newlines cannot corrupt the shared config.
            new_line = f"{key}: {json.dumps(str(value), ensure_ascii=False)}"
            key_re = re.compile(rf"^\s*{re.escape(key)}\s*:")
            for i, line in enumerate(lines):
                if key_re.match(line):
                    lines[i] = new_line
                    break
            else:
                lines.append(new_line)
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    # -- lifecycle hooks -----------------------------------------------------

    def system_prompt_block(self) -> str:
        """Static provider context: the current active-preferences body."""
        result = self._safe_call("brain_context", {})
        return str(self._structured(result).get("content", "") or "")

    def prefetch(self, query: str, *, session_id: str = "", **_kwargs: Any) -> str:
        """Recall context before an API call, plus the per-turn identity reminder.

        The recall gate decides whether a retrieval runs; the identity reminder
        (the behaviour the retired ``pre_llm_call`` hook used to provide) is
        always appended when an agent identity is configured.
        """
        parts: list[str] = []
        gate = self._structured(self._safe_call("brain_recall_gate", {"prompt": query}))
        if gate.get("retrieve"):
            pack = self._safe_call("brain_context_pack", {"max_tokens": _PREFETCH_MAX_TOKENS})
            recalled = self._text(pack)
            if recalled:
                parts.append(recalled)
        # Skill auto-attach (Agent Surface Suite): the TS side gates on the
        # skill_auto_attach config key and returns an empty block when off,
        # so the default injection stays byte-identical. Fail-soft like every
        # other lifecycle bridge call.
        attach = self._structured(self._safe_call("skills_attach", {"query": query}))
        skills_block = str(attach.get("block", "") or "")
        if attach.get("enabled") and skills_block:
            parts.append(skills_block)
        reminder = config.build_reminder()
        if reminder:
            parts.append(reminder)
        return "\n\n".join(parts)

    def queue_prefetch(self, query: str, **_kwargs: Any) -> None:
        """Remember the next turn's query so a later prefetch can warm it."""
        self._queued_query = query or ""

    def sync_turn(
        self,
        user: str,
        assistant: str,
        *,
        session_id: str = "",
        messages: list | None = None,
        **_kwargs: Any,
    ) -> None:
        """Buffer the completed turn off the hot path (non-blocking, daemon thread)."""
        sid = session_id or self._session_id

        def _work() -> None:
            try:
                self._append_turn(user, assistant, sid)
            except Exception:  # noqa: BLE001 - a turn must never fail on capture
                pass

        # Drop references to finished capture threads so the list cannot grow
        # unbounded across a long-lived session.
        self._sync_threads = [t for t in self._sync_threads if t.is_alive()]
        thread = threading.Thread(target=_work, daemon=True)
        self._sync_threads.append(thread)
        thread.start()

    def on_pre_compress(self, messages: list, **_kwargs: Any) -> None:
        """Flush buffered turns into deterministic continuity storage before compaction."""
        self._drain_captures()
        self._flush_buffer()

    def on_session_end(self, messages: list, *, interrupted: bool = False, **_kwargs: Any) -> None:
        """Flush any remaining buffered turns at session close.

        Hermes now fires this hook on an interrupted close too
        (SIGHUP/SIGTERM/force-quit/restart-drain, #50004/#50003/#50312),
        passing ``interrupted=True`` alongside the flushed in-flight transcript.
        Surfacing the flag onto the flush payload lets the TS core record an
        interrupted capture honestly; the flush itself already drains the same
        buffered turns whether the close was clean or interrupted, so no turn is
        lost. Python makes no capture decision - it only forwards the flag.
        """
        self._drain_captures()
        self._flush_buffer(interrupted=bool(interrupted))

    def on_memory_write(
        self,
        action: str,
        target: str,
        content: str,
        metadata: dict[str, Any] | None = None,
        **_kwargs: Any,
    ) -> None:
        """Persist a Hermes built-in memory write into the Brain vault.

        Verified host contract (Hermes c253b0738): the manager dispatches one
        call per write with ``action`` in {add, replace} (``remove`` is filtered
        out host-side and never arrives) and ``target`` in {memory, user};
        batches are decomposed host-side, so a provider never receives an array.
        ``metadata`` carries structured provenance (write_origin, session_id,
        tool_name, ...).

        This is a thin adapter: it forwards the payload to the host-bridge tool,
        which is the single authority that validates the contract and persists a
        durable ``host_memory_write`` continuity record via the shared substrate.
        ``_safe_call`` degrades to a no-op (the bridge's own rejection of an
        unsupported payload, or a missing bridge, never breaks a turn) — matching
        Hermes' own fail-soft hook contract.
        """
        args: dict[str, Any] = {"action": action, "target": target, "content": content}
        if isinstance(metadata, dict) and metadata:
            args["metadata"] = metadata
        self._safe_call("brain_memory_bridge", args)

    def shutdown(self) -> None:
        """Drain captures, flush, and stop the bridge. Never raises."""
        self._drain_captures()
        self._flush_buffer()
        if self._bridge is not None:
            try:
                self._bridge.stop()
            except Exception:  # noqa: BLE001 - shutdown is best-effort
                pass

    # -- internals -----------------------------------------------------------

    def _safe_call(self, name: str, args: dict[str, Any]) -> Any:
        """Bridge call that degrades to ``None`` instead of breaking a turn."""
        if self._bridge is None:
            return None
        try:
            return self._bridge.call_tool(name, args)
        except Exception:  # noqa: BLE001 - lifecycle hooks must not raise into Hermes
            return None

    @staticmethod
    def _as_tool_content(result: Any) -> str:
        """Coerce a bridge result into tool-message content (always a string).

        The Hermes memory contract types ``handle_tool_call`` as ``-> str``,
        but the bridge yields an MCP result dict. Serialize losslessly so the
        model still sees both the ``content`` and ``structuredContent``
        envelopes. ``default=str`` keeps non-JSON-native values (datetimes,
        Paths) from raising at the boundary; an already-string result passes
        through untouched.
        """
        if isinstance(result, str):
            return result
        return json.dumps(result, ensure_ascii=False, default=str)

    @staticmethod
    def _structured(result: Any) -> dict[str, Any]:
        if isinstance(result, dict) and isinstance(result.get("structuredContent"), dict):
            return result["structuredContent"]
        return {}

    @staticmethod
    def _text(result: Any) -> str:
        if not isinstance(result, dict):
            return ""
        content = result.get("content")
        if isinstance(content, list) and content:
            first = content[0]
            if isinstance(first, dict) and isinstance(first.get("text"), str):
                return first["text"]
        return ""

    def _append_turn(self, user: str, assistant: str, session_id: str) -> None:
        with self._lock:
            self._buffer.append((user, assistant))
        self._persist_turn(user, assistant, session_id)

    def _persist_turn(self, user: str, assistant: str, session_id: str) -> None:
        """Append the raw turn to a transcript under hermes_home for durability."""
        if not self._hermes_home:
            return
        path = Path(self._hermes_home) / "open-second-brain" / "session-transcript.jsonl"
        record = json.dumps(
            {"session_id": session_id, "user": user, "assistant": assistant},
            ensure_ascii=False,
        )
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(record + "\n")
        except OSError:
            pass

    def _flush_buffer(self, interrupted: bool = False) -> None:
        """Hand buffered turns to deterministic extraction, then clear the buffer.

        ``interrupted`` is forwarded to the extractor only when set, so a clean
        close emits a byte-identical payload (the field is absent by default).
        """
        with self._lock:
            turns = list(self._buffer)
            self._buffer.clear()
        if not turns:
            return
        text = "\n\n".join(f"User: {u}\nAssistant: {a}" for u, a in turns)
        args: dict[str, Any] = {
            "session_id": self._session_id or "hermes",
            "turn_start": 0,
            "turn_end": len(turns),
            "text": text,
        }
        if interrupted:
            args["interrupted"] = True
        self._safe_call("brain_pre_compact_extract", args)

    def _drain_captures(self) -> None:
        """Join outstanding capture threads so a turn buffered just before a
        flush still reaches storage. Safe to call any time; used by the
        lifecycle hooks and by tests for determinism."""
        for thread in list(self._sync_threads):
            thread.join(timeout=5)
        self._sync_threads.clear()
