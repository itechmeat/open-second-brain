### Variant 1: Embedded MCP client behind the provider
- **Approach**: The Python `MemoryProvider` spawns a single long-lived `o2b mcp --vault <hermes_home>/Brain` stdio process during `initialize()` and holds an in-process JSON-RPC client to it. `get_tool_schemas()` returns the server's `tools/list`, `handle_tool_call()` forwards to `tools/call`, and every lifecycle hook (`prefetch`, `on_pre_compress`, `on_session_end`) is just another `tools/call` over the same channel. The `mcp_server` block leaves `~/.hermes/config.yaml`; the server becomes an internal implementation detail owned by the provider, so there is exactly one registration.
- **Trade-offs**:
  - Pro: Zero reimplementation — the battle-tested protocol and tool surface are reused verbatim; deterministic logic stays in TS.
  - Pro: Tool-schema parity is automatic (schemas come from `tools/list`), so no drift between a static manifest and the real server.
  - Pro: True consolidation — Hermes sees one provider, not an mcp_server plus a shim.
  - Pro: Mockable in CI by swapping the JSON-RPC transport for a fake client; no live Bun needed.
  - Con: Provider must manage subprocess lifecycle (boot, health, `shutdown()`, hang/timeout handling, restart on crash).
  - Con: `sync_turn` still needs its own daemon thread to write the transcript without waiting on the RPC round-trip.
- **Complexity**: medium
- **Risk**: medium

### Variant 2: Stateless per-call CLI bridge
- **Approach**: The provider holds no persistent process; each tool call and lifecycle hook shells out to a one-shot `o2b` subcommand (or a single-shot JSON-RPC invocation) and parses stdout. `get_tool_schemas()` returns a schema set generated once and cached, and `sync_turn` appends the raw turn to the transcript directly from Python (stdlib), invoking nothing.
- **Trade-offs**:
  - Pro: Simplest lifecycle — no long-lived process, no crash/restart logic, nothing to leak on `shutdown()`.
  - Pro: Trivial to mock (replace the subprocess runner); robust in headless CI.
  - Pro: Each call is isolated, so one failure cannot corrupt shared process state.
  - Con: Process spawn + Bun startup cost on every call adds latency to hot paths like `prefetch`.
  - Con: Schemas must be cached/snapshotted, reintroducing a drift risk between the snapshot and the real tool surface.
  - Con: Needs stable one-shot CLI entrypoints, which may require adding `o2b` subcommands beyond `o2b mcp`.
- **Complexity**: small
- **Risk**: low

### Variant 3: Hybrid — Python-native light hooks + bridged tool surface
- **Approach**: Cheap, non-deterministic-free hooks (`sync_turn`, `on_memory_write`, `system_prompt_block` reading `Brain/active.md`) are implemented directly in Python with stdlib file I/O scoped under `hermes_home`, while everything requiring deterministic logic (`get_tool_schemas`/`handle_tool_call`, `prefetch`, `on_pre_compress`) goes through a mockable `BrainBridge` abstraction whose default backend is the TS core (persistent or per-call). This keeps the non-blocking, high-frequency paths off Bun entirely and reserves the bridge for genuine deterministic work.
- **Trade-offs**:
  - Pro: Hot paths (`sync_turn`, prompt block, mirror writes) have no subprocess cost and no Bun dependency at all.
  - Pro: Clean `BrainBridge` seam makes the heavy paths independently mockable and lets the transport choice (Variant 1 vs 2) be swapped later.
  - Pro: Best worst-case latency and resilience for the non-blocking turn loop.
  - Con: Two code paths and a partial Python file-format surface — real risk of subtly duplicating logic the constraints forbid reimplementing.
  - Con: Most code to write, document, and keep in sync with the TS vault format as it evolves.
  - Con: Harder to reason about "one mechanism" since some behavior lives in Python and some in TS.
- **Complexity**: large
- **Risk**: medium

### Recommended: Variant 1
**Rationale**: It satisfies the core consolidation goal most directly — the MCP server becomes an internal detail owned by one native provider, collapsing the shim plus `mcp_server` block into a single registration — while reusing the exact, battle-tested tool surface so no deterministic logic is reimplemented in Python. Automatic schema parity via `tools/list` avoids the manifest-drift weakness of Variant 2, and abstracting the JSON-RPC transport keeps it fully mockable in CI without a live Bun runtime; the only real cost, subprocess lifecycle management, is a bounded, well-understood concern that Variant 3's dual-path duplication risk does not justify.
