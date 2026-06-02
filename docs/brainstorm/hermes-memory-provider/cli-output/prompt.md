You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Become a native Hermes memory provider (consolidate Hermes integration).

Goal: Implement Open Second Brain as a first-class Hermes `MemoryProvider` (the canonical, supported integration) and consolidate the current Hermes wiring so there is ONE mechanism for one goal instead of two.

Ref: https://hermes-agent.nousresearch.com/docs/developer-guide/memory-provider-plugin

Hermes contract (MemoryProvider ABC in `agent/memory_provider.py`):
- Required: `name` (property), `is_available()` (no network), `initialize(session_id, **kwargs)` (kwargs always includes `hermes_home`), `get_tool_schemas()`, `handle_tool_call(tool_name, args, **kwargs)`, `get_config_schema()`, `save_config(values, hermes_home)`.
- Optional lifecycle hooks: `system_prompt_block()`, `prefetch(query, *, session_id)`, `queue_prefetch(query)`, `sync_turn(user, assistant, *, session_id, messages)` (MUST be non-blocking), `on_session_end(messages)`, `on_pre_compress(messages)`, `on_memory_write(action, target, content)`, `shutdown()`.
- Registration: `register(ctx)` -> `ctx.register_memory_provider(...)`. Plugin layout `plugins/memory/<provider>/` with `__init__.py`, `plugin.yaml` (lists implemented hooks), optional `cli.py` (`register_cli(subparser)`).
- Built-in Hermes memory is MEMORY.md/USER.md; Hermes mirrors writes to the active provider via `on_memory_write`. Only ONE external provider can be active at a time (`memory.provider` in `~/.hermes/config.yaml`).
- All storage paths must be scoped under `hermes_home` from `initialize()`. `sync_turn` must use a daemon thread so it never blocks the turn.

Current state in this repo (what to consolidate / replace, Hermes only):
1. `plugins/hermes/__init__.py` — a Python shim that provides ONLY a `pre_llm_call` hook (per-turn identity reminder, reads `agent_name` from `~/.config/open-second-brain/config.yaml`, fills `templates/identity-reminder.hermes.txt`) plus a `health()`/`check_health()` data-only readiness check and a best-effort `register(ctx)`.
2. The `o2b mcp` stdio server registered via `plugin.yaml` `mcp_server` block / `~/.hermes/config.yaml` `mcp_servers` — the actual brain_* tool surface.
Neither is the native MemoryProvider. We want to replace both with one native provider.

Hermes memory hooks the provider should map to existing Open Second Brain capabilities:
- get_tool_schemas / handle_tool_call -> the brain_* tools (brain_feedback, brain_apply_evidence, brain_note, brain_query, brain_search, brain_recall_gate, brain_context_pack, brain_pre_compact_extract, etc.)
- prefetch(query) -> brain_recall_gate + brain_query/brain_context_pack
- system_prompt_block() -> Brain/active.md
- on_pre_compress -> brain_pre_compress_pack / brain_pre_compact_extract
- on_session_end -> session flush / dream candidate
- on_memory_write -> mirror Hermes MEMORY.md/USER.md into Brain/
- sync_turn -> append raw turn to a session transcript for the deterministic `dream` pass (no LLM extraction in the loop, per project philosophy)

# Project context

Project: Open Second Brain. An Obsidian-compatible Markdown "second brain" / memory layer for AI agents. Core runtime is TypeScript on Bun (CLI `o2b`, MCP stdio server, OpenClaw plugin). A thin Python package (`plugins/hermes/`, root `__init__.py`, `pyproject.toml`) exists ONLY as the Hermes in-process shim. Memory learning is deterministic: a `dream` pass turns repeat signals into rules — NO LLM inside the algorithm.

Recent commits:
6fbab0b feat: hands-off post-upgrade migration (v0.31.2) (#61)
496dd2d fix: make plugin updates self-healing (v0.31.1) (#60)
09c0592 chore(release): v0.31.0 (#59)
b81335c Feat/procedural attention suite (#58)
1f3a218 Feat/self learning skill proposals (#57)
0162d13 feat(brain): add context continuity and receipts suite (#56)
3b7b3a5 feat(brain): add safety governance foundations (#55)
794ee45 feat(search): ship recall control and trust surfaces (#54)

Related files:
- plugins/hermes/__init__.py (current shim)
- plugins/hermes/plugin.yaml, plugin.yaml (root) — Hermes manifests with mcp_server block + provides_hooks: [pre_llm_call]
- src/mcp/server.ts, src/mcp/stdio.ts, src/mcp/index.ts, src/mcp/tools.ts — JSON-RPC 2.0 stdio MCP server (protocol 2025-06-18; lifecycle initialize / notifications/initialized / tools/list / tools/call; scope `full` | `writer`)
- scripts/o2b — bash entry: `exec bun run src/cli/main.ts "$@"`; `o2b mcp --vault <path> [--scope writer]`
- templates/identity-reminder.hermes.txt — per-turn reminder template
- install/hermes.md — current install doc (manual mcp_servers edit)
- pyproject.toml, __init__.py — Python packaging for the Hermes shim
- tests/ — Bun test suite

Conventions:
- TypeScript core on Bun; Python only for the Hermes in-process plugin (no runtime Python deps today; `dependencies = []`).
- The MCP server is the existing, battle-tested tool surface. Deterministic logic (dream, recall, search) lives in TypeScript and must NOT be reimplemented in Python.
- Plain Markdown vault under `Brain/`; agent identity resolved from `~/.config/open-second-brain/config.yaml` (`agent_name`) or `VAULT_AGENT_NAME`.
- Public artifacts use the full name "Open Second Brain" (no abbreviation), no exclamation marks in docs, no AI-authorship markers.
- `register(ctx)` must be defensive: unknown ctx shapes are ignored without raising so minimal/test contexts do not break plugin loading.

Constraints:
- Provider MUST be Python (Hermes loads it in-process).
- Do NOT break Claude Code or Codex integrations — those use `.mcp.json` / `.claude-plugin` / `.codex-plugin` + hooks and have NO formal memory-provider interface; their files must stay untouched. Shared assets (`scripts/o2b`, `templates/`) are reused, not changed destructively.
- Do NOT reimplement the deterministic dream/recall/search logic in Python.
- Avoid adding heavy external Python dependencies; prefer stdlib (the project ships `dependencies = []`).
- `sync_turn` must be non-blocking (daemon thread).
- All provider storage must be scoped under `hermes_home`.
- Must remain testable without a live Bun runtime in CI (the bridge to the TS core must be mockable).

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
