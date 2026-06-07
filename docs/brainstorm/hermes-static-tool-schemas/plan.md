# Static tool schemas for the Hermes memory provider - implementation plan

## Tasks

### Task 1: Vendored static schemas module
- **Files**: `plugins/hermes/_schemas.py` (new), `tests/python/test_static_schemas.py` (new)
- **Acceptance**: failing-first unit tests pass: every `MEMORY_TOOLS` name has exactly one
  static schema (bijection, no extras), each entry carries non-empty `name`,
  `description`, and an object-typed `inputSchema`; `static_tool_schemas()` returns
  deep copies (mutating a returned dict does not affect a second call).
- **Depends on**: none

### Task 2: `get_tool_schemas()` static fallback
- **Files**: `plugins/hermes/provider.py`, `tests/python/test_memory_provider.py`
- **Acceptance**: failing-first tests pass: (a) `get_tool_schemas()` BEFORE
  `initialize()` returns the full curated set; (b) after `initialize()` the name set is
  identical (live schemas win); (c) when the bridge raises on `list_tools()` the static
  set is returned instead of `[]`; (d) Hermes-ordering end-to-end with
  `FakeBrainBridge`: routing table built from pre-init schemas contains the tool, the
  post-init `handle_tool_call()` through that table succeeds; (e) the pre-init
  `handle_tool_call()` guard still raises `BridgeError`.
- **Depends on**: Task 1

### Task 3: Anti-drift test against the live server
- **Files**: `tests/python/test_static_schemas.py`
- **Acceptance**: a test spawns `o2b mcp`, performs the MCP handshake, fetches
  `tools/list`, and asserts that for every `MEMORY_TOOLS` name the live
  (name, description, inputSchema) projection equals the static copy. Skips with a
  visible reason when the `o2b` CLI / Bun runtime is unavailable or the handshake
  times out. Runs green locally against the live server.
- **Depends on**: Task 1

### Task 4: Docs and changelog
- **Files**: `CHANGELOG.md`, `install/hermes.md`
- **Acceptance**: CHANGELOG gains the next patch version entry describing the fix;
  `install/hermes.md` no longer implies tools appear only after initialization and
  mentions that the provider registers its curated tool set at gateway start.
- **Depends on**: Task 2, Task 3
