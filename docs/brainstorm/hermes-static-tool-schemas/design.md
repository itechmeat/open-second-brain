# Static tool schemas for the Hermes memory provider - fix "Unknown tool" registration

**Status:** approved
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Hermes builds its memory-tool routing table in `MemoryManager.add_provider()` from
`provider.get_tool_schemas()` and only afterwards calls `initialize_all()`; the table
is never rebuilt. Our provider starts the `o2b mcp` bridge in `initialize()` and
`get_tool_schemas()` returns `[]` while the bridge is absent, so the gateway registers
the provider with 0 tools. The model still sees `brain_*` tools (schemas are collected
post-init), but dispatch hits the empty routing table and fails with "Unknown tool".

## Scope

- New module `plugins/hermes/_schemas.py` embedding static schemas (name, description,
  inputSchema) for every name in the curated `MEMORY_TOOLS` set, copied verbatim from
  the live `o2b mcp` `tools/list`.
- `get_tool_schemas()` returns the static set when the bridge is not available
  (`self._bridge is None`) and also when the live listing fails, instead of `[]`.
  After a successful bridge start it keeps returning the live-filtered list as today.
- Anti-drift test that spawns the live `o2b mcp`, fetches `tools/list`, and asserts the
  embedded copies match the live MEMORY_TOOLS subset field-by-field (name, description,
  inputSchema). Skipped cleanly when the Bun runtime / `o2b` CLI is unavailable.
- Unit tests: pre-init schema availability, pre/post-init name-set identity, fallback
  on listing failure, and an end-to-end simulation of the Hermes ordering
  (schemas requested pre-init, tool call post-init) with `FakeBrainBridge`.
- CHANGELOG entry and `install/hermes.md` adjustment.

## Out of scope

- Upstream hermes-agent change (rebuilding `_tool_to_provider` after `initialize_all()`
  or lazy dispatch lookup) - proposed separately.
- Any change to `handle_tool_call()`: the `bridge is None -> BridgeError` guard stays.
- Changes to the MEMORY_TOOLS allowlist itself.

## Chosen approach

Variant 1 from the consultant round: hand-vendored static schema literals in a
dedicated stdlib-only module, guarded against drift by a live-server comparison test.
The static copies are mechanically transcribed from the current `tools/list` output
(all 10 MEMORY_TOOLS are present on the live server, verified 2026-06-07), so the
initial copies are exact. The provider treats the static set strictly as a fallback:
once the bridge is up, live schemas win.

## Design decisions

- **Separate `_schemas.py` module, not inline in `provider.py`**: the literals are
  ~200 lines of data; keeping them out of the orchestrator preserves single
  responsibility (SRP) and keeps `provider.py` reviewable.
- **Static fallback also covers a failed live listing** (bridge present but
  `list_tools()` raises): Hermes built its routing table from the static names at
  registration; returning `[]` later would hide the tools from the model while the
  routing still exists. Returning the static set keeps both surfaces consistent and
  is strictly more useful than an empty list. The post-init schema collection then
  matches the registration-time name set in every failure mode.
- **Accessor returns deep copies** (`static_tool_schemas()`): Hermes and tests may
  mutate the returned dicts; the module-level literals must stay pristine.
- **Anti-drift compares only the embedded fields** (name, description, inputSchema):
  the live server may add sibling keys (annotations, outputSchema) without breaking
  the provider contract; comparing the embedded projection keeps the test signal
  precise.
- **Anti-drift test is environment-gated, not mocked**: its whole value is catching
  real divergence between `_schemas.py` and the TS core; it skips (with a visible
  reason) when `o2b`/Bun is unavailable, and CI has Bun so it runs there.
- **`handle_tool_call()` unchanged**: by the time the model can call a tool,
  `initialize()` has already run; a pre-init call is a programming error and keeps
  raising `BridgeError`.

## File changes

- New: `plugins/hermes/_schemas.py` (static literals + `static_tool_schemas()` accessor).
- Modified: `plugins/hermes/provider.py` (`get_tool_schemas()` fallback path only).
- Modified: `tests/python/test_memory_provider.py` (unit tests for fallback + ordering).
- New: `tests/python/test_static_schemas.py` (integrity + anti-drift against live `o2b mcp`).
- Modified: `CHANGELOG.md`, `install/hermes.md`.

## Risks and open questions

- The anti-drift test spawns a real subprocess; it needs a hard timeout so a hung
  server cannot stall the suite. Mitigation: bounded reader with `timeout` and
  `skipTest` on spawn failure.
- If the TS core later renames or removes a MEMORY_TOOLS tool, the anti-drift test
  fails loudly in CI - that is the intended behavior, not a flake.
- Schema size: 10 embedded schemas add a few KB to the shim; no runtime cost beyond
  one import.
