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

import atexit
import json
import logging
import os
import shutil
import threading
from pathlib import Path
from collections.abc import Callable
from typing import TYPE_CHECKING, Any, NamedTuple

if TYPE_CHECKING:
    from collections.abc import Iterable

from . import config
from ._base import MemoryProvider
from ._schemas import static_tool_schemas
from .bridge import BrainBridge, BridgeError, McpBrainBridge

logger = logging.getLogger(__name__)

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

class _ConfigField(NamedTuple):
    """One config field the setup wizard collects and this provider persists."""

    #: Key as it appears in the Open Second Brain config file.
    key: str
    #: Wizard-facing explanation of what the field controls.
    description: str
    #: Whether the provider is unusable without it.
    required: bool
    #: How the value is resolved once written, used to verify the write took.
    resolve: Callable[[], str | None]
    #: Written value -> the effective value it should resolve to.
    normalize: Callable[[str], str]


# The config surface, once. `get_config_schema()` and the write loop used to be
# the same three keys written out twice, so a fourth field could half-land: the
# wizard would collect it and the writer would drop it (or the reverse) with
# nothing failing. Both are derived from this tuple, in the order the wizard
# shows them.
_CONFIG_FIELDS: tuple[_ConfigField, ...] = (
    _ConfigField(
        key="vault",
        description="Path to the Obsidian vault whose Brain/ subtree stores memory.",
        required=True,
        resolve=config.resolve_vault,
        normalize=config.expand_tilde,
    ),
    _ConfigField(
        key="agent_name",
        description="Agent identity recorded on every Brain write.",
        required=False,
        resolve=config.resolve_agent_name,
        normalize=lambda value: value,
    ),
    _ConfigField(
        key="timezone",
        description="IANA timezone for daily and scheduled Brain operations.",
        required=False,
        resolve=config.resolve_timezone,
        normalize=lambda value: value,
    ),
)

_CONFIG_KEYS: tuple[str, ...] = tuple(field.key for field in _CONFIG_FIELDS)

# Durable per-session transcript written under ``hermes_home``.
SESSION_TRANSCRIPT_FILENAME = "session-transcript.jsonl"

# Token budget for the recall slice fetched on each prefetch.
_PREFETCH_MAX_TOKENS = 1024

# A provider instance is created per AIAgent, but the MCP server is a gateway
# resource rather than a session resource. Keep one bridge per effective server
# configuration in this Python process. Cache eviction deliberately calls
# AIAgent.release_clients() without shutting down memory providers, so
# constructing one Bun child per provider leaks a child for every new session.
_SHARED_BRIDGES: dict[tuple[str | None, str | None, tuple[str, ...]], BrainBridge] = {}
_SHARED_BRIDGES_LOCK = threading.RLock()


def _shared_bridge_key(
    vault: str | None,
    repo_root: str | None,
    command: tuple[str, ...],
) -> tuple[str | None, str | None, tuple[str, ...]]:
    return (vault, repo_root, tuple(command))


def _get_shared_bridge(
    *,
    vault: str | None,
    repo_root: str | None,
    command: tuple[str, ...],
) -> BrainBridge:
    """Return the one bridge for this gateway/configuration key."""
    key = _shared_bridge_key(vault, repo_root, command)
    with _SHARED_BRIDGES_LOCK:
        bridge = _SHARED_BRIDGES.get(key)
        if bridge is None:
            bridge = McpBrainBridge(
                vault=vault,
                repo_root=repo_root,
                command=command,
            )
            _SHARED_BRIDGES[key] = bridge
        return bridge


def _shutdown_shared_bridges() -> None:
    """Stop all gateway-owned bridges during normal interpreter shutdown."""
    with _SHARED_BRIDGES_LOCK:
        bridges = list(_SHARED_BRIDGES.values())
        _SHARED_BRIDGES.clear()
    for bridge in bridges:
        try:
            bridge.stop()
        except Exception:  # noqa: BLE001 - shutdown is best-effort
            pass


def _reset_shared_bridges_for_tests() -> None:
    """Clear the process registry without exposing it as provider API."""
    _shutdown_shared_bridges()


atexit.register(_shutdown_shared_bridges)


def _fallback_exe_dirs() -> tuple[Path, ...]:
    """Directories scanned for an executable when a tiny inherited ``PATH``
    hides it from ``shutil.which``. Computed per call so it tracks the current
    ``$HOME`` (and stays patchable in tests)."""
    home = Path.home()
    return (
        home / ".local" / "bin",
        home / ".bun" / "bin",
        home / ".hermes" / "node" / "bin",
        Path("/opt/homebrew/bin"),
        Path("/usr/local/bin"),
        Path("/usr/bin"),
        Path("/bin"),
    )


def _find_executable(name: str, search_dirs: Iterable[Path] | None = None) -> str | None:
    """Resolve ``name`` to an absolute executable path.

    ``shutil.which`` (which honours ``PATH``) wins when it can see the binary.
    Hermes can start the provider from a process with a minimal inherited
    ``PATH``; then ``which`` returns nothing even though the executable exists
    in a user-local bin, so fall back to scanning a curated directory set.

    On Windows the scan appends ``PATHEXT`` suffixes (``.EXE``/``.CMD``/...) to
    a bare name and does not gate on the POSIX execute bit, which has no meaning
    there; on POSIX it matches the exact name and requires ``X_OK``.
    """
    found = shutil.which(name)
    if found:
        return found
    dirs = tuple(search_dirs) if search_dirs is not None else _fallback_exe_dirs()
    if os.name == "nt" and not os.path.splitext(name)[1]:
        exts = [e for e in os.environ.get("PATHEXT", ".COM;.EXE;.BAT;.CMD").split(os.pathsep) if e]
        candidate_names = [name + ext for ext in exts]
    else:
        candidate_names = [name]
    for directory in dirs:
        for candidate_name in candidate_names:
            candidate = directory / candidate_name
            if not candidate.is_file():
                continue
            if os.name == "nt" or os.access(candidate, os.X_OK):
                return str(candidate)
    return None


class OpenSecondBrainMemoryProvider(MemoryProvider):
    """Open Second Brain as a first-class Hermes memory provider."""

    PROVIDER_NAME = config.PLUGIN_NAME

    def __init__(self, bridge: BrainBridge | None = None) -> None:
        self._bridge_override = bridge
        self._bridge: BrainBridge | None = None
        self._bridge_shared = False
        self._bridge_start_error: Exception | None = None
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
        """Activation eligibility without network calls: a vault is configured.

        A present-but-unreadable config is NOT answered here. The host renders
        this boolean as a setup badge, and ``False`` on that badge means "you
        have not configured this yet" - which is the exact false statement
        GitHub #130 reported, and the reason a permissions fault on the config
        file was indistinguishable from a plugin nobody had set up. There is no
        third value in the host contract, so the only honest response to "I
        cannot tell" is to refuse: :class:`config.ConfigReadError` is logged
        with the file it names and re-raised, which reaches the gateway log
        carrying its own remedy instead of vanishing into a wrong badge.
        """
        try:
            return config.resolve_vault() is not None
        except config.ConfigReadError as exc:
            logger.error("%s: cannot determine availability: %s", self.PROVIDER_NAME, exc)
            raise

    def initialize(self, session_id: str, **kwargs: Any) -> None:
        """Start the bridge to the TS core.

        Fail-soft about the BRIDGE - a gateway boot must survive an ``o2b mcp``
        that will not start - but not silent about it: the failure is logged
        with a traceback and remembered, so a later tool call names it instead
        of returning ``None`` forever with nothing anywhere saying why.

        A configuration the resolver cannot read is a different matter and
        propagates, for the reason :meth:`is_available` gives.
        """
        self._session_id = session_id or ""
        self._hermes_home = kwargs.get("hermes_home")
        self._bridge_start_error = None
        old_bridge = self._bridge
        old_bridge_shared = self._bridge_shared
        self._bridge = None
        self._bridge_shared = False
        if old_bridge is not None and not old_bridge_shared:
            # Re-initialization (a new session on a reused instance) must not
            # leak an injected/test bridge's subprocess. Gateway bridges are
            # shared and intentionally remain alive for the gateway lifetime.
            try:
                old_bridge.stop()
            except Exception:  # noqa: BLE001 - a stale child must not block re-init
                logger.warning(
                    "%s: could not stop the previous bridge", self.PROVIDER_NAME, exc_info=True
                )
        if self._bridge_override is not None:
            self._bridge = self._bridge_override
        else:
            vault = config.resolve_vault()
            repo_root = self._repo_root()
            command = self._resolve_command()
            self._bridge = _get_shared_bridge(
                vault=vault,
                repo_root=repo_root,
                command=command,
            )
            self._bridge_shared = True
        try:
            assert self._bridge is not None
            self._bridge.start()
        except Exception as exc:  # noqa: BLE001 - boot survives; the failure is recorded
            self._bridge_start_error = exc
            logger.error(
                "%s: bridge to the Open Second Brain core failed to start; "
                "memory tool calls will be refused until it does",
                self.PROVIDER_NAME,
                exc_info=True,
            )

    @staticmethod
    def _repo_root() -> str | None:
        """Plugin checkout root that ships ``skills/`` (provider lives at
        ``<root>/plugins/hermes/provider.py``). Passed as ``--repo`` so the TS
        core's ``repoRoot`` resolves and in-repo skills become discoverable;
        without it ``skill_auto_attach`` returns an empty list."""
        root = Path(__file__).resolve().parents[2]
        return str(root) if (root / "skills").is_dir() else None

    @classmethod
    def _resolve_command(cls) -> tuple[str, ...]:
        """Determine the right argv prefix for the ``o2b mcp`` subprocess.

        Hermes memory providers can run with a tiny inherited ``PATH``, so
        resolve absolute executable paths via :func:`_find_executable` (which
        scans user-local and system bins when ``PATH`` hides the binary) before
        falling back to a bare command name.

        On Windows the ``scripts/o2b`` bash wrapper is not directly executable
        by ``subprocess.Popen``, so the o2b branch is POSIX-only; the
        cross-platform path is the repo-local TypeScript entry point via
        ``bun run``.
        """
        # On non-Windows, a globally installed or user-local o2b works directly.
        if os.name != "nt":
            o2b = _find_executable("o2b")
            if o2b:
                return (o2b, "mcp")

        # Resolve via repo-local TypeScript entry point + bun.
        root = cls._repo_root()
        if root:
            entry = Path(root) / "src" / "cli" / "main.ts"
            if entry.is_file():
                bun = _find_executable("bun")
                if bun:
                    return (bun, "run", str(entry), "mcp")

        # Last resort: hope o2b is reachable (e.g. npm global install on
        # Windows created an o2b.cmd shim, or the user's shell can run it).
        return ("o2b", "mcp")

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
            # The fallback is right (Hermes needs a tool table now, and the
            # vendored schemas are generated from the live ones), but it looks
            # identical to a healthy listing. Say so, or a dead bridge hides
            # behind a plausible tool list for the life of the gateway.
            logger.warning(
                "%s: live tools/list failed; serving vendored static schemas instead",
                self.PROVIDER_NAME,
                exc_info=True,
            )
            return static_tool_schemas()
        filtered = []
        for t in tools:
            if t.get("name") not in MEMORY_TOOLS:
                continue
            # MCP uses "inputSchema"; Hermes adapters expect "parameters"
            if "inputSchema" in t and "parameters" not in t:
                t = dict(t)
                t["parameters"] = t.pop("inputSchema")
            filtered.append(t)
        return filtered

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
        if self._bridge_start_error is not None:
            raise BridgeError(
                "memory bridge failed to start: "
                f"{type(self._bridge_start_error).__name__}: {self._bridge_start_error}"
            )
        if tool_name not in MEMORY_TOOLS:
            # Enforce the curated surface at execution time, not just discovery.
            raise BridgeError(f"unsupported memory tool: {tool_name}")
        return self._as_tool_content(self._bridge.call_tool(tool_name, args or {}))

    def get_config_schema(self) -> list[dict[str, Any]]:
        """The wizard's field list, derived from :data:`_CONFIG_FIELDS`."""
        return [
            {"key": field.key, "description": field.description, "required": field.required}
            for field in _CONFIG_FIELDS
        ]

    def save_config(self, values: dict[str, Any], hermes_home: str) -> None:
        """Persist non-secret config to the canonical Open Second Brain config.

        The bridge spawns ``o2b mcp``, which resolves the vault from this same
        file, so the provider's config must land here rather than under
        ``hermes_home`` (which scopes only provider-local state).

        Three rules, each replacing a way this used to lie about what it did:

        - A key the wizard did not send is left alone; a key it sent EMPTY is
          unset. Skipping every falsy value meant a field the operator cleared
          kept its old value and the wizard reported success.
        - The write is verified by re-resolving. Writing ``vault`` into a file
          that ``VAULT_DIR`` (or a project pointer, or an active profile)
          shadows leaves the operator with a config they can read and a vault
          they are not using; :class:`config.ConfigEffectError` names the
          shadowing source instead.
        - Values that cannot survive the read-back are refused, not encoded.
          This used to JSON-encode them, which made a Windows path round-trip
          through the plugin and read back as a DIFFERENT path in ``o2b``.

        :raises config.ConfigReadError: the existing config cannot be read, so
            a write would clobber content nothing has seen.
        :raises config.ConfigValueError: a value cannot survive the read-back.
        :raises config.ConfigEffectError: the write landed but does not take.
        """
        pending: dict[str, str | None] = {}
        for field in _CONFIG_FIELDS:
            if field.key not in values:
                continue
            raw = values[field.key]
            pending[field.key] = str(raw) if raw else None
        if not pending:
            return
        path = config.set_config_values(pending)
        self._verify_saved(pending, path)

    @staticmethod
    def _verify_saved(pending: dict[str, str | None], path: Path) -> None:
        """Refuse loudly when a written key does not resolve to what was written."""
        stored = config.parse_simple_yaml(path.read_text(encoding="utf-8"))
        for field in _CONFIG_FIELDS:
            if field.key not in pending:
                continue
            written = pending[field.key]
            if not written:
                if stored.get(field.key):
                    raise config.ConfigEffectError(
                        field.key, "", stored[field.key], "the key survived the unset"
                    )
                continue
            effective = field.resolve()
            expected = field.normalize(written)
            if effective != expected:
                raise config.ConfigEffectError(
                    field.key,
                    written,
                    effective,
                    config.shadowing_source(field.key)
                    or "something ahead of the config file in the resolution chain wins",
                )

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
                logger.warning(
                    "%s: capturing a turn failed; it is lost", self.PROVIDER_NAME, exc_info=True
                )

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
        """Drain captures, flush, and stop owned test bridges. Never raises."""
        self._drain_captures()
        self._flush_buffer()
        bridge = self._bridge
        bridge_shared = self._bridge_shared
        self._bridge = None
        self._bridge_shared = False
        # Shared production bridges belong to the gateway, not an evictable
        # session. The process registry/atexit hook owns their final stop.
        if bridge is not None and not bridge_shared:
            try:
                bridge.stop()
            except Exception:  # noqa: BLE001 - shutdown is best-effort
                pass

    # -- internals -----------------------------------------------------------

    def _safe_call(self, name: str, args: dict[str, Any]) -> Any:
        """Bridge call that degrades to ``None`` instead of breaking a turn."""
        if self._bridge is None:
            logger.debug("%s: %s skipped, no bridge", self.PROVIDER_NAME, name)
            return None
        try:
            return self._bridge.call_tool(name, args)
        except Exception:  # noqa: BLE001 - lifecycle hooks must not raise into Hermes
            logger.warning("%s: %s failed; degrading to no recall", self.PROVIDER_NAME, name)
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
        path = Path(self._hermes_home) / config.PLUGIN_NAME / SESSION_TRANSCRIPT_FILENAME
        record = json.dumps(
            {"session_id": session_id, "user": user, "assistant": assistant},
            ensure_ascii=False,
        )
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as handle:
                handle.write(record + "\n")
        except OSError:
            logger.warning(
                "%s: could not append the session transcript at %s",
                self.PROVIDER_NAME,
                path,
                exc_info=True,
            )

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
        # Turn bounds are turn *ids* on the server contract, so they go over as
        # strings — the tool reads them with `requiredStringArg`, which does not
        # coerce, and `_safe_call` swallows the `-32602` it raises. Sending ints
        # here loses the whole flushed segment with nothing on either side
        # saying so. Matches the sibling Aider bracket, which also sends "0".
        args: dict[str, Any] = {
            "session_id": self._session_id or "hermes",
            "turn_start": "0",
            "turn_end": str(len(turns)),
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
