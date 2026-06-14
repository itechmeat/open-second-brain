# Session Knowledge Synthesis - variant audit trail

## How scope was chosen

This cycle the operator asked for a large scope of related, low-priority
triage tasks, explicitly excluding "adding new agents" (neither install
adapters like cline nor session-import adapters like copilot-cli / pi), and
asked to move already-implemented-but-open tasks to done.

Phase 0 ran the CLI consultant (`claude -p`) over the entire triage column
(`cli-output/prompt.md`, `cli-output/claude.md`). The consultant recommended
the **Session Knowledge Synthesis** cluster (`t_325a7e4a`, `t_e4ddbe7c`,
`t_635a3ea5`) with **Variant 1** (agent-extracted structured records + read-side
synthesis tools, kernel stays provider-agnostic). Full output is preserved
verbatim in `cli-output/claude.md`.

## Orchestrator gap analysis (override of the consultant cluster)

The consultant worked from the triage text and a context summary; it did not
know the codebase had moved ahead of two of the three tasks. Direct inspection
of `main` found:

- **`t_e4ddbe7c` (daily / morning brief) is already shipped.** `brain_brief`
  exposes `view=morning` (`src/core/brain/morning-brief.ts:buildMorningBrief`)
  and `view=daily` (`src/core/brain/temporal/daily-brief.ts:buildDailyBrief`),
  plus weekly / monthly, from the temporal-synthesis suite. The only novel
  upstream element - injecting the brief into a task tracker's description
  field - is host-specific and not an Open Second Brain kernel concern.
  -> Closed as already-present (moved to done), no code.
- **`t_325a7e4a` (structured session summary) is only partially covered.**
  `pre_compact_extract` already does agent-supplied structured extraction
  (decision / commitment / outcome / rule / open_question), and
  `session_summary_node` is a hierarchical recall rollup. Neither is a
  session-scoped digest over the four canonical categories (request / decisions
  / learnings / next_steps). -> Real but narrow gap; build it as a thin
  session-scoped envelope reusing the existing extraction + storage primitives.
- **`t_635a3ea5` (idea lineage) is a real gap.** The edges exist (`sourceRefs`,
  belief-evolution, dream output) but no read-side tracer reconstructs the
  observation -> synthesis -> conclusion chain. -> Build as a read-only tracer.

To keep a meaningful scope after removing the already-done task, the operator
agreed to add a third in-repo, non-agent task:

- **`t_6a201155` (episodic note-history decomposition).** Substrate confirmed:
  `src/core/brain/git/reader.ts` (Project History Suite) is a sanitized
  read-only git reader, shipped and tested but with no current callers. A note's
  version chain = the git commits touching its path; phases are a deterministic
  structural split. -> Build as its first consumer.

Final build scope: **A** structured session summary, **B** idea lineage, **C**
episodic note history. `t_e4ddbe7c` closed as already-present.

## Architectural variants considered (from the consultant, applied to the final scope)

### Variant 1: Agent-extracted structured records + read-side synthesis tools
- **Approach**: new structured record(s) written by an MCP tool the agent calls;
  read-side tools aggregate. Kernel stores already-extracted data, never calls
  an LLM.
- **Trade-offs**: matches the provider-agnostic guarantee exactly; maximally
  additive and byte-identical when unused; language-agnostic by construction.
  Con: rich fields only populate when an agent is active.
- **Complexity**: medium. **Risk**: low.

### Variant 2: Deterministic skeleton + optional agent enrichment (sentinel-marked)
- **Approach**: kernel writes a deterministic structural skeleton with no
  provider; AI fields fill later and are marked derived.
- **Trade-offs**: strongest fail-soft story. Con: two-phase lifecycle, more
  ordering to reason about; couples to the dream pass timing.
- **Complexity**: medium. **Risk**: low.

### Variant 3: Unified TemporalSynthesisEnvelope (refactor weekly-brief)
- **Approach**: generalize `WeeklySynthesisEnvelope` into one envelope
  parameterized by scope.
- **Trade-offs**: most DRY long-term. Con: refactors a shipped surface,
  threatening byte-identical-when-unused; largest blast radius.
- **Complexity**: large. **Risk**: medium.

## Final decision

**Variant 1**, borrowing Variant 2's discipline: every AI-derived field is
optional and marked derived (`enriched` flag / absent digest), so no-provider
cases degrade to a deterministic skeleton or honest absence, never a fabricated
summary. Variant 3's unification is rejected - refactoring the shipped
weekly-brief surface is unjustified risk for an additive release. This applies
uniformly to all three features: the kernel validates and stores agent-supplied
structure (A), reads existing edges (B), and reads git history with a
deterministic split plus optional enrichment (C).
