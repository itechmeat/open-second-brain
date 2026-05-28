# Agent Boundary Control Surfaces - variants audit trail

## Consultant

Primary consultant: Claude Code (`claude -p docs/brainstorm/agent-boundary-control-surfaces/cli-output/prompt.md`)

Fallback consultant: not run because the primary consultant returned exactly three parseable variants and one recommendation.

## Variants

### Variant 1: Independent additive slices

- **Approach**: Land each task as its own thin, isolated slice with no shared abstraction. `Brain/pinned.md` gets a small `src/core/brain/pinned.ts` and a `brain_pinned_context` tool (read/write/clear ops), with `brain_context` appending pinned content beside active prefs. Link output adds a `link_output_format` key to `src/core/config.ts` plus a renderer branch in `src/core/brain/wikilink.ts`/`src/core/search/links.ts`. Contract enforcement adds an optional JSON-Schema field to `ToolDefinition` in `src/mcp/tools.ts` and a validation step in `MCPServer.handleToolsCall` against `structuredContent`. The cavemem helper is a `stripPrivateRegions` pass added to `src/core/redactor.ts`, invoked from the existing Brain/Pay Memory write boundary that already calls `redactRawOutput`.
- **Trade-offs**:
  - Pro: aligns with the "small additive surfaces" constraint; each slice ships behind its own tests, fits TDD feature-by-feature, and reviews independently.
  - Pro: no new cross-cutting abstraction to design, document, or migrate later if priorities change.
  - Pro: the conditional cavemem task collapses to one regex + helper export reused by existing redactor callers — exactly the "small shared redaction helper" the gating clause requires.
  - Con: four logically related boundary surfaces ship without a common shape; future similar features re-invent registration/wiring patterns.
  - Con: contract validation lives ad-hoc in the MCP server rather than as a reusable layer; subsequent tools must remember to wire it.
- **Complexity**: small
- **Risk**: low

### Variant 2: Unified boundary-stage pipeline

- **Approach**: Introduce a generalized "boundary pipeline" abstraction (e.g., `src/mcp/boundary.ts`) with explicit inbound (context-assembly) and outbound (response-shaping) stages, each registered by name. Pinned-content load becomes an inbound stage on `brain_context`; link rendering, contract validation, and private-region stripping become outbound stages applied to `structuredContent` and text payloads. `MCPServer.handleToolsCall` becomes a thin driver over this pipeline; `src/core/redactor.ts` plugs in as one outbound stage.
- **Trade-offs**:
  - Pro: principled, extensible seam that anticipates further boundary control surfaces.
  - Pro: contract validation, redaction, and link formatting are uniformly applied without per-tool wiring.
  - Con: introduces a cross-cutting abstraction for only 3-4 concrete features — exactly the broad refactor the constraints warn against.
  - Con: harder to land TDD feature-by-feature; each slice now depends on the pipeline scaffold being merged first.
  - Con: backward-compat risk on `MCPServer.handleToolsCall` envelope semantics (`content` + `structuredContent`), and on Brain context composition tested by `tests/mcp/brain.test.ts`.
  - Con: the cavemem gating clause explicitly forbids "real-time session lifecycle hooks"; a generic stage pipeline edges toward that shape.
- **Complexity**: large
- **Risk**: medium

### Variant 3: Direction-split surfaces (inbound context vs outbound envelope)

- **Approach**: Group the work into two cohesive but small surfaces. An inbound "session context" surface adds `Brain/pinned.md` plus the `brain_pinned_context` tool and extends `brain_context` to compose active prefs + pinned snippet. An outbound "envelope" surface adds a single `renderEnvelope` helper that the MCP server calls before returning tool results: it applies the `link_output_format` config to any rendered wikilinks, validates `structuredContent` against per-tool JSON Schemas declared on `ToolDefinition`, and runs the new `stripPrivateRegions` pass (also exported from `src/core/redactor.ts` so Brain writers can call it on the write path).
- **Trade-offs**:
  - Pro: organizes the four tasks by data direction, which matches how the existing code is already split (`brain-tools.ts` for inbound context vs `redactor.ts`/`tools.ts` for outbound shaping).
  - Pro: still avoids a generic pipeline; each surface is one new file plus targeted edits.
  - Pro: makes contract enforcement a property of the envelope rather than per-tool code, while staying smaller than Variant 2.
  - Con: bundles three logically distinct outbound concerns (link formatting, schema validation, private-region stripping) into one helper whose responsibilities will drift.
  - Con: introduces an envelope abstraction that current tests (`tests/mcp/mcp.test.ts`) do not yet exercise — moderate test churn.
  - Con: harder to ship piecewise because the envelope is a shared seam; first task lands the seam, later tasks must conform.
- **Complexity**: medium
- **Risk**: medium

### Recommended: Variant 1

**Rationale**: The project's stated constraints — additive surfaces over broad refactors, TDD feature-by-feature, backward-compatible public APIs, and the conditional cavemem clause requiring a _small_ shared redaction helper — all favor independent slices. The four tasks happen to touch the agent boundary but do not share enough mechanism to justify a pipeline (Variant 2) or even a shared envelope (Variant 3); each slice is a few dozen lines against well-isolated files (`brain-tools.ts`, `wikilink.ts`/`links.ts`, `tools.ts`/`server.ts`, `redactor.ts`) with existing test homes. If a real cross-cutting need emerges later (e.g., a second tool needing the same JSON-Schema check), extracting from the concrete implementations will be straightforward and lower-risk than designing the abstraction up front.

## Orchestrator decision

I agree with Variant 1. The selected kanban scope intentionally combines several boundary-control tasks, but they do not yet justify a generic pipeline: pinned context is an inbound Brain context concern, link rendering is a presentation concern, MCP output contracts are a server-envelope concern, and private-region stripping belongs in the existing redactor. Keeping the first implementation concrete makes TDD simpler, limits migration risk, and leaves a cleaner extraction path if repeated patterns appear in later releases.

The conditional privacy task is included only in its small helper form. Path-glob capture exclusions and real-time lifecycle hooks remain out of scope because they belong to the larger cavemem session-capture cluster and would turn this PR into an architecture shift.
