# Native Hermes memory provider - consolidate Hermes integration

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain integrates with Hermes today through two overlapping mechanisms: a Python `pre_llm_call` shim (`plugins/hermes/__init__.py`) that injects a per-turn identity reminder, and the `o2b mcp` stdio server registered as a Hermes `mcp_server`. Neither is the native `MemoryProvider` interface Hermes exposes for memory layers. The result is two registrations for one goal and no access to Hermes memory lifecycle hooks (prefetch, pre-compress, memory mirroring). This task makes Open Second Brain a first-class Hermes memory provider and collapses the two mechanisms into one.

## Scope

- A native Hermes memory provider implemented in the existing `plugins/hermes` Python package, subclassing the `MemoryProvider` ABC.
- Required surface: `name`, `is_available()`, `initialize()`, `get_tool_schemas()`, `handle_tool_call()`, `get_config_schema()`, `save_config()`.
- Lifecycle hooks: `system_prompt_block()`, `prefetch()` (absorbs the retired per-turn identity reminder), `queue_prefetch()`, `sync_turn()` (non-blocking), `on_pre_compress()`, `on_session_end()`, `on_memory_write()`, `shutdown()`.
- A `BrainBridge` abstraction whose default backend spawns one long-lived `o2b mcp` process and speaks MCP JSON-RPC (initialize / tools/list / tools/call) over stdio. The bridge is the only seam that touches the TypeScript core.
- `register(ctx)` calls `ctx.register_memory_provider(...)` and keeps the existing health check; the `pre_llm_call` hook registration is retired.
- `plugin.yaml` (root + `plugins/hermes`): drop the `mcp_server` block and the `pre_llm_call` hook; declare the implemented memory hooks.
- Optional `cli.py` exposing `hermes open-second-brain status|config`.
- Migrate the Python test suite from the shim contract to the provider + bridge contract, keeping the identity-reminder template parity tests.
- Update `install/hermes.md`, `README.md`, `CHANGELOG.md`, and the CI `py_compile` step.

## Out of scope

- Any change to Claude Code or Codex integration. Those runtimes have no formal memory-provider interface; their canonical path (`.mcp.json`, `.claude-plugin`, `.codex-plugin`, `hooks/hooks.json`) is already correct and stays untouched. Shared assets (`scripts/o2b`, `templates/`) are reused, not modified destructively.
- Reimplementing any deterministic logic (dream, recall, search, extraction) in Python. All of it stays in the TypeScript core, reached through the bridge.
- The optional Codex `~/.codex/memories` mirroring enhancement (separate future task).

## Chosen approach

Variant 1 - Embedded MCP client behind the provider. The provider owns a single long-lived `o2b mcp --vault <vault>` subprocess started in `initialize()`. `get_tool_schemas()` returns a memory-relevant subset of the server's `tools/list`; `handle_tool_call()` forwards to `tools/call`; and the deterministic lifecycle hooks (`prefetch`, `on_pre_compress`, `on_session_end`, `system_prompt_block`) are each a `tools/call` over the same channel. The Hermes `mcp_server` registration goes away because the server becomes an internal implementation detail of the one provider, satisfying the consolidation goal. The JSON-RPC transport sits behind a `BrainBridge` Protocol so tests inject a fake and never need a live Bun runtime.

## Design decisions

- **Bridge as an abstraction (Dependency Inversion).** The provider depends on a `BrainBridge` Protocol, not on subprocess details. Default `McpBrainBridge` spawns `o2b mcp`; tests pass a `FakeBrainBridge`. This keeps the provider unit-testable without Bun and isolates subprocess lifecycle handling in one class.
- **Soft import of the ABC.** `agent.memory_provider.MemoryProvider` is only importable inside a Hermes install. A `_base.py` module imports it when present and otherwise defines a minimal local fallback base, so the package imports and tests run in this repo's CI. This mirrors the existing defensive `register(ctx)` pattern.
- **Identity reminder moves into `prefetch`.** The retired `pre_llm_call` returned `{"context": reminder}` every turn. `prefetch()` is the provider-native per-turn injection point; it returns the recall context (when `brain_recall_gate` says retrieve) with the identity reminder appended. The reminder template loading is reused verbatim from the current shim (no text drift, parity tests preserved).
- **`sync_turn` stays cheap; extraction happens at boundaries.** There is no dedicated "ingest one raw turn" MCP tool, and per-turn deterministic extraction would be wasteful. `sync_turn` (daemon thread, non-blocking) buffers the turn in memory; `on_pre_compress` and `on_session_end` flush the buffer through `brain_pre_compact_extract` (deterministic, no LLM). This honors the project's "no LLM inside the algorithm" rule and the non-blocking contract.
- **Curated tool subset.** `get_tool_schemas()` filters `tools/list` to a single explicit allowlist of memory-relevant tools (writer set plus recall/query/context tools). Schemas come from the real server (no schema drift); only the name allowlist is maintained locally. This respects the documented MCP token-economy concern without exposing all 60+ tools.
- **Vault vs `hermes_home` are distinct paths.** The Open Second Brain vault (an Obsidian vault whose `Brain/` subtree the server reads and writes) is resolved from Open Second Brain config (`~/.config/open-second-brain/config.yaml` or the `vault` field of `save_config`) and passed to `o2b mcp --vault <vault>`. `hermes_home` from `initialize()` scopes only provider-local state - the `sync_turn` transcript buffer and any cache - never the vault, and never a hardcoded path, per the profile-isolation requirement.
- **Fail-soft everywhere the agent turn depends on us.** `prefetch`, `system_prompt_block`, `sync_turn`, and `on_memory_write` never raise into the turn loop; a bridge error degrades to empty context, matching the current shim's "never leak, never block" behavior.
- **Single Hermes plugin package.** Rather than create a parallel hyphenated `plugins/memory/open-second-brain/` directory (not a valid Python import path), evolve the existing `plugins/hermes` package. The repo already loads its `register` via the root `__init__.py`, and the existing tests already import `plugins.hermes` - keeping one package is the DRY/KISS choice.

## File changes

New files:
- `plugins/hermes/_base.py` - soft MemoryProvider import + fallback base.
- `plugins/hermes/config.py` - agent-name / config-path / reminder-template helpers (extracted from `__init__.py`, shared).
- `plugins/hermes/bridge.py` - `BrainBridge` Protocol, `McpBrainBridge` (subprocess JSON-RPC), `FakeBrainBridge` (tests).
- `plugins/hermes/provider.py` - `OpenSecondBrainMemoryProvider(MemoryProvider)`.
- `plugins/hermes/cli.py` - `register_cli(subparser)` for `status` / `config`.
- `tests/python/test_memory_provider.py` - provider + bridge unit tests with the fake bridge.

Modified files:
- `plugins/hermes/__init__.py` - `register(ctx)` registers the provider + health check; retire `pre_llm_call`; re-export provider/bridge.
- `plugins/hermes/plugin.yaml`, `plugin.yaml` (root) - drop `mcp_server`, declare memory hooks.
- `tests/python/test_hermes_plugin.py` - retarget to the new contract; keep template parity tests.
- `install/hermes.md` - rewrite around `memory.provider: open-second-brain`.
- `README.md`, `CHANGELOG.md` - document the native provider.
- `.github/workflows/ci.yml`, `.github/workflows/release.yml` - compile the whole `plugins/hermes` package, not just `__init__.py`.

## Risks and open questions

- **MemoryProvider ABC signature drift.** The exact method signatures come from the published Hermes docs. The fallback base and provider must match the real ABC; if Hermes changes the contract the fallback hides it. Mitigation: keep the fallback minimal and rely on `**kwargs` for forward compatibility on lifecycle hooks.
- **`hermes memory setup` config keys.** `get_config_schema()` field names (`vault`, `agent_name`, `timezone`) drive the setup wizard. They reuse the existing `~/.config/open-second-brain/config.yaml` keys; verify against a real wizard run during QA where possible.
- **Subprocess startup cost.** The first `prefetch` after `initialize` pays Bun startup. Mitigation: spawn in `initialize()` (not lazily) and warm `tools/list` once.
- **Single-provider rule.** Enabling Open Second Brain as `memory.provider` excludes other external providers by Hermes design. This is expected and documented for the operator.
