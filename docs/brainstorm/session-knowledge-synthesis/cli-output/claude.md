## Part 1 - Scope recommendation

### Candidate clusters

- **Session Knowledge Synthesis** — `t_325a7e4a` (p0, structured session summary), `t_e4ddbe7c` (p3, daily morning brief), `t_635a3ea5` (p2, idea-lineage). Theme: `src/core/brain/temporal/` + `session-lifecycle.ts` — turn session activity into structured, queryable, surface-able temporal knowledge via agent-driven extraction. Usefulness: high (closes the "what happened / what was decided / what's next" loop, the core value of a second brain); risk: low, fully additive.
- **Multi-agent session-import adapters** — `t_aaced180` (p1, Copilot history), `t_f5761ca8` (p1, Pi), `t_7cf20134` (p1, Copilot CLI), `t_7c89c306` (p1, progressive-batch parser). Theme: `src/core/brain/sessions/` adapter registry. Usefulness: moderate; risk: **blocking** — every adapter requires reverse-engineering an external/unstable transcript format (Pi explicitly "needs reverse-engineering"; Copilot format external), which the brief flags as a blocking risk.
- **Graphify/codegraph passthroughs** — `t_b8283326`, `t_bf6933bc`, `t_5d8d6a00`, `t_85252236`, `t_a286135c`, `t_6c9f4434`, `t_a1e76788`. Theme: `src/core/partner/codegraph.ts`. Usefulness: low-moderate; risk: **blocking** — these are thin passthroughs whose logic lives in the external `graphify` binary and would silently no-op when it is absent (`t_bf6933bc` was already de-scoped for exactly this misleading-fallback reason).
- **MCP server distribution / transport** — `t_da6321a9` (p3, console-script entry), `t_31dfae18` (p2, Streamable HTTP transport). Theme: `src/mcp/`. Usefulness: low for a memory store; risk: medium — validator notes the two are "different layers," and HTTP transport + API-key auth leans architectural (multi-client security model).

### Recommended cluster

- **Name**: Session Knowledge Synthesis
- **Task IDs**: `t_325a7e4a`, `t_e4ddbe7c`, `t_635a3ea5`
- **Why this cluster** (usefulness-first): For a second brain, the highest-leverage gap is that sessions are stored but not queryable as decisions/learnings/next-steps — `t_325a7e4a` (the only cleanly-buildable p0) fixes exactly that, producing machine-queryable structured memories instead of opaque transcripts. `t_e4ddbe7c` is the natural read-side consumer: a daily brief that surfaces those structured summaries plus pending items, completing a coherent session→summary→brief loop. `t_635a3ea5` adds the provenance leg, tracing how a decision or learning was reached, which makes the structured summaries auditable and trustworthy. All three live in `src/core/brain/temporal/` and `session-lifecycle.ts`, all rely on agent-driven extraction with the kernel storing already-structured data, and all are byte-identical-when-unused and language-agnostic. This is far more useful to the product than adding one more editor or codegraph passthrough.
- **Why not the others**:
  - Multi-agent session-import adapters: blocked — each depends on reverse-engineering an external/unstable transcript format.
  - Graphify/codegraph passthroughs: blocked — thin passthroughs to an external binary that would silently no-op when absent (forbidden misleading fallback).
  - MCP distribution/transport: loosely related ("different layers"), HTTP transport leans architectural, and it adds little to recall quality.
- **Key risks and how to neutralize them**:
  - *Provider dependency for AI extraction.* Neutralize by keeping all AI-derived fields optional and clearly provenance-marked; absence of a provider degrades to a deterministic structural skeleton, never a fake summary.
  - *Touching shipped `weekly-brief.ts` behavior.* Neutralize by adding the daily variant additively (new cadence/scope), guaranteeing byte-identical output when the daily surface is unused.
  - *Language-agnostic guarantee.* Neutralize by extracting categories (decisions/learnings/next-steps) via the agent/LLM and structural signals only — no hardcoded natural-language keyword lists.
  - *Scope creep into provenance graph.* Neutralize by scoping idea-lineage to recording edges over existing belief-evolution/dream output, not a new graph engine.

## Part 2 - Architectural variants for the recommended cluster

### Variant 1: Agent-extracted structured records + read-side synthesis tools
- **Approach**: Add a `session_summary` memory type with structured metadata (request/decisions/learnings/next-steps), written by an MCP tool the agent calls at session end (or via the existing stop hook prompting the agent). The daily brief and idea-lineage are read-side synthesis tools that aggregate these records; the kernel only stores already-extracted structured data and never calls an LLM.
- **Trade-offs**:
  - Pro: Matches the provider-agnostic kernel guarantee exactly; AI extraction stays fully agent-driven.
  - Pro: Maximally additive — new memory type + new tools, byte-identical when unused; minimal contact with shipped `weekly-brief.ts`.
  - Pro: Language-agnostic by construction (agent does extraction, no word lists).
  - Con: Rich fields only populate when an agent/provider is active; raw-only sessions yield thin summaries.
  - Con: Three loosely-shared tools rather than one unified pipeline (mild duplication).
- **Complexity**: medium
- **Risk**: low

### Variant 2: Deterministic skeleton + optional agent enrichment (sentinel-marked)
- **Approach**: The stop hook deterministically writes a structural skeleton (turn count, files touched, tool calls) for every session with no provider needed; AI fields (decisions/learnings/next-steps) are filled later by an agent pass (e.g., during dream) and marked as derived using a generated/user sentinel pattern. Daily brief and lineage read from these progressively-enriched records.
- **Trade-offs**:
  - Pro: Strongest fail-soft story — useful output even with no provider, with AI fields honestly marked derived (no misleading fallback).
  - Pro: Sentinel marking enables safe re-synthesis without clobbering enriched content.
  - Con: Two-phase lifecycle (skeleton then enrichment) is more moving parts and ordering to reason about.
  - Con: Couples the feature to the dream/synthesis pass timing.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Unified TemporalSynthesisEnvelope (refactor weekly-brief into a general pipeline)
- **Approach**: Generalize the existing `WeeklySynthesisEnvelope` into one `TemporalSynthesisEnvelope` parameterized by scope (session | daily | weekly) and synthesis type, so session summaries, the daily brief, and lineage are all variants of a single schema and pipeline.
- **Trade-offs**:
  - Pro: Most DRY; one synthesis path to maintain and extend later.
  - Pro: Consistent schema across all temporal outputs.
  - Con: Refactors shipped `weekly-brief.ts`, directly threatening the byte-identical-when-unused guarantee for an existing surface.
  - Con: Largest blast radius; couples three new features to a refactor that must preserve v1.x weekly behavior exactly.
- **Complexity**: large
- **Risk**: medium

### Recommended: Variant 1
**Rationale**: Variant 1 aligns cleanest with the project's hard guarantees — the kernel never calls an LLM, extraction is agent-driven, and a new memory type plus read-side tools are byte-identical when unused with almost no contact with shipped `weekly-brief.ts`. It should borrow Variant 2's discipline of marking AI fields as optional/derived so absent-provider cases degrade honestly rather than fabricating summaries. Variant 3's unification is appealing long-term but its refactor of a shipped surface is unjustified risk for an additive low-priority release.
