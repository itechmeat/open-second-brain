# Native Hermes memory provider - implementation plan

Each task is one atomic conventional commit on `feat/hermes-memory-provider`.
TDD: write the failing test first, then implement. Run `bun run fmt` then
`bun run lint` before every commit. Python tests run with
`python -m unittest discover -s tests/python -v`.

## Tasks

### Task 1: Soft ABC base + shared config helpers
- **Files**: `plugins/hermes/_base.py` (new), `plugins/hermes/config.py` (new), `tests/python/test_memory_provider.py` (new, partial)
- **Detail**: `_base.py` imports `agent.memory_provider.MemoryProvider` when available, else defines a minimal fallback base (lifecycle methods as no-ops accepting `**kwargs`). `config.py` holds `config_path()`, `resolve_agent_name()`, `load_reminder_template()`, `render_reminder(agent)` extracted from the current `__init__.py` (DRY - one source for both the provider and any legacy caller).
- **Acceptance**: tests assert the fallback base is subclassable, `resolve_agent_name()` honors `VAULT_AGENT_NAME` / config file / `"agent"` fallback, and `render_reminder` substitutes every `{agent}` placeholder.
- **Depends on**: none

### Task 2: BrainBridge abstraction + fake
- **Files**: `plugins/hermes/bridge.py` (new), `tests/python/test_memory_provider.py` (extend)
- **Detail**: `BrainBridge` Protocol with `start()`, `list_tools()`, `call_tool(name, args)`, `stop()`. `McpBrainBridge` spawns `o2b mcp --vault <vault>` and implements the JSON-RPC handshake (initialize -> notifications/initialized -> tools/list) with timeouts and a single restart-on-crash. `FakeBrainBridge` returns canned tool lists/results for tests.
- **Acceptance**: tests drive `FakeBrainBridge` through list/call; `McpBrainBridge` JSON-RPC framing is unit-tested against an in-memory pipe stub (no real Bun).
- **Depends on**: none

### Task 3: Provider required surface
- **Files**: `plugins/hermes/provider.py` (new), `tests/python/test_memory_provider.py` (extend)
- **Detail**: `OpenSecondBrainMemoryProvider` constructor takes an optional `bridge` (default `McpBrainBridge`). Implement `name`, `is_available()` (config/vault present, no network), `initialize(session_id, **kwargs)` (capture `hermes_home`, resolve the vault from Open Second Brain config, start bridge), `get_tool_schemas()` (filter `list_tools()` by the memory allowlist constant), `handle_tool_call(name, args, **kwargs)` (forward to `call_tool`), `get_config_schema()` (fields `vault`, `agent_name`, `timezone`), `save_config(values, hermes_home)` (persist non-secret fields to the canonical Open Second Brain config the bridge and identity reminder both read).
- **Acceptance**: tests assert tool-schema filtering against the allowlist, tool-call forwarding, config schema field shape, and `save_config` writes `vault`/`agent_name` to the Open Second Brain config path (provider-local state, not the vault, is what lives under `hermes_home`).
- **Depends on**: Task 1, Task 2

### Task 4: Provider lifecycle hooks
- **Files**: `plugins/hermes/provider.py` (extend), `tests/python/test_memory_provider.py` (extend)
- **Detail**: `system_prompt_block()` -> `brain_context` (fail-soft to ""). `prefetch(query, *, session_id)` -> `brain_recall_gate` then `brain_context_pack`, append identity reminder. `queue_prefetch()` (cache last query). `sync_turn(...)` -> daemon thread, buffer turn under `hermes_home`. `on_pre_compress(messages)` / `on_session_end(messages)` -> flush buffer through `brain_pre_compact_extract`. `on_memory_write(action, target, content)` -> mirror to Brain via `brain_note`/`brain_pinned_context`. `shutdown()` -> stop bridge, join threads.
- **Acceptance**: tests assert prefetch returns reminder + recalled context, recall-gate "no" path returns reminder only, sync_turn never blocks and buffers, flush calls the extract tool, every hook is exception-safe.
- **Depends on**: Task 3

### Task 5: register() + retire pre_llm_call
- **Files**: `plugins/hermes/__init__.py`, `tests/python/test_hermes_plugin.py`
- **Detail**: `register(ctx)` registers the provider via `register_memory_provider` (best-effort across ctx shapes), keeps the health check, drops the `pre_llm_call` hook registration. Re-export provider/bridge/health. Retarget the shim tests: drop `pre_llm_call` assertions, add `register_memory_provider` assertions, keep template parity + health tests.
- **Acceptance**: `register` attaches the provider on a ctx exposing `register_memory_provider`; health check still attaches; no `pre_llm_call` registration.
- **Depends on**: Task 4

### Task 6: Manifests - drop mcp_server, declare memory hooks
- **Files**: `plugins/hermes/plugin.yaml`, `plugin.yaml` (root)
- **Detail**: remove the `mcp_server` block, replace `provides_hooks: [pre_llm_call]` with the implemented memory-hook list, bump description to "native memory provider".
- **Acceptance**: YAML parses; `hooks` list matches the implemented hooks; no `mcp_server` key.
- **Depends on**: Task 5

### Task 7: Optional CLI
- **Files**: `plugins/hermes/cli.py` (new), `tests/python/test_memory_provider.py` (extend)
- **Detail**: `register_cli(subparser)` building `status` (provider availability + bridge ping) and `config` (effective config) subcommands; dispatch handler.
- **Acceptance**: test invokes the argparse tree and asserts `status`/`config` dispatch.
- **Depends on**: Task 3

### Task 8: CI compile + packaging
- **Files**: `.github/workflows/ci.yml`, `.github/workflows/release.yml`, `pyproject.toml` (verify only)
- **Detail**: change the `py_compile plugins/hermes/__init__.py` step to `compileall plugins/hermes` so new submodules are compiled. Confirm setuptools still packages `plugins.hermes` (submodules auto-included).
- **Acceptance**: workflow YAML parses; `python -m compileall plugins/hermes` is green locally.
- **Depends on**: Task 5

### Task 9: Docs (install, README, CHANGELOG)
- **Files**: `install/hermes.md`, `README.md`, `CHANGELOG.md`
- **Detail**: rewrite `install/hermes.md` around `memory.provider: open-second-brain` / `hermes memory setup` instead of the manual `mcp_servers` edit; add a README note that Hermes uses the native memory provider; add one CHANGELOG entry under the next version (version bumped in Phase 6).
- **Acceptance**: docs describe the native provider flow; no stale `mcp_servers` manual-edit instruction remains for Hermes; no abbreviations, no AI-authorship markers, no exclamation marks.
- **Depends on**: Task 6
