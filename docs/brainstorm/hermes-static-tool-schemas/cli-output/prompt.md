You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

## Fix: `brain_*` tools register as "Unknown tool" in Hermes (provider advertises 0 tools at registration)

### Root cause (verified against live hermes-agent source)

Hermes builds its memory-tool routing table in `MemoryManager.add_provider()`
(hermes-agent: `agent/memory_manager.py:285-302`, "registered (N tools)" log) and
only afterwards calls `initialize_all()` (`agent/agent_init.py:1101` vs `:1144`). The
table is never rebuilt. Our provider (`plugins/hermes/provider.py`) starts
McpBrainBridge in `initialize()` (fail-soft by design) and `get_tool_schemas()`
returns `[]` while `self._bridge is None` (`provider.py:96-104`). Result: gateway
logs "Memory provider 'open-second-brain' registered (0 tools)", the model
still SEES `brain_*` tools (`agent_init.py:1153+` collects schemas post-init), but
dispatch via `memory_manager.has_tool()` hits the empty routing table and falls
through to "Unknown tool". Lifecycle hooks (prefetch, sync_turn,
system_prompt_block, on_pre_compress, on_session_end) are unaffected.

### Fix direction (our side, plugins/hermes)

1. Provide schemas (name, description, inputSchema) for the curated
   MEMORY_TOOLS set from `get_tool_schemas()` when the bridge is
   not started yet. After bridge start, keep returning the live-filtered list
   as today (or reconcile static vs live by name).
2. Keep the `handle_tool_call()` guard unchanged: bridge None -> BridgeError.
3. Anti-drift: a test that compares the pre-init schemas against the live
   `o2b mcp` tools/list (MEMORY_TOOLS subset) so they cannot silently diverge.
4. Tests: (a) `get_tool_schemas()` BEFORE `initialize()` returns the full curated
   set; (b) after `initialize()` the name set is identical; (c) simulate Hermes
   ordering (schemas requested pre-init, tool call post-init) end-to-end with
   FakeBrainBridge.

### Acceptance

- Fresh gateway start logs "Memory provider 'open-second-brain' registered (N tools)" with N >= 1
- A `brain_*` tool call from the model routes through memory_manager (no "Unknown tool")
- Full Python test suite green

# Project context

Open Second Brain - agent-owned second brain in an Obsidian-compatible Markdown vault.
Core is TypeScript on Bun (`src/`); the Hermes memory provider is a thin Python shim
(`plugins/hermes/`: provider.py, bridge.py, config.py, cli.py, _base.py) that forwards
all work to the TS core over an `o2b mcp` stdio JSON-RPC bridge (McpBrainBridge).
Python >= 3.11, stdlib-only (no runtime dependencies allowed in the shim).
Python tests: `python -m unittest discover -s tests/python -v` (CI runs this; no pytest).
TS side: `bun test`, `oxlint`, `oxfmt`, `tsc --noEmit`.

The live `o2b mcp` server advertises 77 tools; all 10 MEMORY_TOOLS names
(brain_feedback, brain_apply_evidence, brain_note, brain_pinned_context, brain_query,
brain_search, brain_recall_gate, brain_context, brain_context_pack,
brain_pre_compact_extract) are present in `tools/list` with full inputSchema.
Tool schemas are defined in the TS core (`src/mcp/brain-tools.ts` and siblings).

Recent commits:
ff43abd fix(ci): treat an existing release as success in the release workflow (#80)
957a403 feat!: Stability & Trust - 1.0.0 API freeze, deprecation sweep, safeguard, staged dream, timezone, report deltas (#79)
786b0f5 fix(openclaw): rebuild stale plugin bundle so the release verify gate passes (#78)
6d09d3c feat: Link & Recall Intelligence Suite - alias resolution, bridge discovery, communities, recall benchmark, self-tuning (#77)
789e3e3 feat: Write-Time Integrity & Governance Suite - schema ontology, tier guard, secret custody, maintenance lane (#76)
c03d569 fix(hermes): root cli.py shim completes the upstream CLI discovery contract (#75)
0952dfc feat: become a native Hermes memory provider (#62)

Related files:
- plugins/hermes/provider.py (get_tool_schemas, handle_tool_call, MEMORY_TOOLS allowlist)
- plugins/hermes/bridge.py (BrainBridge protocol, McpBrainBridge, FakeBrainBridge)
- tests/python/test_memory_provider.py (unittest, FakeBrainBridge-based)
- src/mcp/brain-tools.ts (TS source of truth for tool schemas)
- install/hermes.md (user-facing install doc)

Conventions:
- Conventional commits; one PR = one CHANGELOG version; 1.0.0 API freeze is in effect (no breaking changes; this must be a patch release).
- The Python shim must never reimplement deterministic memory logic; it forwards to the TS core.
- Provider is fail-soft: gateway boot must never break because of the bridge.
- Tests use unittest + FakeBrainBridge, no network/Bun required for unit tests; an anti-drift test MAY spawn the live `o2b mcp` (Bun available in CI after bun-precheck) but must be skippable when the runtime is unavailable.

Constraints:
- Do not change existing public APIs (1.0.0 freeze): get_tool_schemas/handle_tool_call signatures stay.
- No new external Python dependencies (stdlib only).
- handle_tool_call guard stays: bridge None -> BridgeError.
- The curated MEMORY_TOOLS allowlist stays the single source of the tool subset.
- Upstream hermes-agent changes are out of scope for this PR.

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
