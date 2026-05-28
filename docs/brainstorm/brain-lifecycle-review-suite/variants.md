# Brain Lifecycle Review Suite - variants

## Consultant output

### Variant 1: Composable read-only review suite (dream untouched)
- **Approach**: Ship all five tasks as additive read-mostly surfaces layered around an unchanged dream. New `brain_retention` and `brain_monthly_review` tools, a `complexity_score` field added to discipline reports, JSON Schemas emitted (not enforced) into `Brain/schemas/` from existing TypeScript types, and a `brain_intent_review` advisory tool that scores signals likely to pass dream but does not actually filter them. Dream's single-pass behavior, signal flow, and outputs stay byte-for-byte identical.
- **Trade-offs**:
  - Pro: lowest blast radius; no risk of breaking deterministic dream or existing tests.
  - Pro: each task ships as an independent additive tool, easy to TDD and revert.
  - Pro: matches "recommendation-only" constraint trivially for retention.
  - Con: two-stage gate becomes advisory-only, which weakens the upstream pattern's actual filtering benefit (t_ef94345e).
  - Con: schemas-as-emission don't catch malformed input at the MCP boundary, so brain_doctor still carries that burden.
  - Con: surface area grows by 2-3 new tools/verbs without consolidating them under a unifying frame.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Staged lifecycle pipeline (port the buildroom)
- **Approach**: Restructure dream into an explicit pipeline of `intent_review -> main_review -> retention_review` stages with JSON Schema contracts between each, mirroring the upstream buildroom. Monthly review consumes the schema-validated stage artifacts as its primary input source, and the complexity-vs-thinking ratio is embedded into the intent_review stage as a filtering signal. Schemas live in `Brain/schemas/` and are enforced at every inter-stage boundary plus the MCP input layer.
- **Trade-offs**:
  - Pro: maximally coherent with the source articles' pipeline pattern; one design covers all five tasks.
  - Pro: schemas give brain_doctor much less to do; clear audit artifacts per stage.
  - Pro: two-stage gate becomes real filtering, not advisory.
  - Con: directly violates the constraint against rewriting dream into a multi-phase engine without strong justification.
  - Con: high risk to the deterministic core; planTopics, transition planning, and quarantine paths all need re-threading.
  - Con: schema enforcement either pulls in an Ajv-class dependency (constraint hesitation) or requires a non-trivial local validator.
  - Con: long migration path; intermediate states may break existing workruns and review-candidates dry-run.
- **Complexity**: large
- **Risk**: high

### Variant 3: Thin pre-filter + independent review pillars
- **Approach**: Add a real intent-review pre-pass that runs before dream and actually filters/marks signals (so dream's `planTopics` consumes a smaller, gated set), while leaving dream's internal main-review logic unchanged. Ship retention as a standalone recommendation-only `brain_retention` tool over `Brain/retired/` and `inbox/processed/`, ship `brain_monthly_review` as a new temporal aggregator built on `daily-brief`/`weekly-brief` and `vaultDelta`, extend `decideStatus`/`ActivitySummary` with a `complexity_score`, and emit JSON Schemas from existing TypeScript types into `Brain/schemas/` with optional lightweight enforcement only at the MCP input boundary (no Ajv dependency).
- **Trade-offs**:
  - Pro: hits all five task scopes without restructuring dream's main pass.
  - Pro: two-stage gate is genuinely two-stage (real filtering), not advisory like Variant 1.
  - Pro: retention is naturally recommendation-only because it's a separate read-only tool, satisfying t_6fa649b9's safety constraint exactly.
  - Pro: monthly review reuses the existing temporal index and brief helpers; complexity ratio is a small additive field in discipline.
  - Pro: schemas-as-emitted-contracts with optional boundary validation avoids heavy deps but still tightens MCP input safety.
  - Con: introduces a new pre-dream stage that must stay in sync with dream's signal expectations; needs careful contract testing.
  - Con: two write-surface tools (retention, monthly) plus a discipline field plus an intent-review pre-pass plus schemas is still five distinct moving pieces - release coordination matters.
  - Con: complexity-vs-thinking metric is heuristic; tuning the threshold for discipline status may need iteration.
- **Complexity**: medium
- **Risk**: low-to-medium

### Recommended: Variant 3
**Rationale**: It delivers a coherent Brain lifecycle review release by sequencing the five tasks around their natural seams - pre-dream gating, dream untouched, post-dream retention, period-level monthly review, discipline-level complexity ratio, and schemas as additive contracts - which matches the project's deterministic, dependency-light, recommendation-only constraints far better than Variant 2's dream refactor. Versus Variant 1 it gives the two-stage gate real teeth and keeps retention safely isolated, without paying Variant 2's risk and dependency cost. The five pieces are independently TDD-able (pure core helpers first, CLI/MCP wrappers second) and can ship as additive verbs and tools with no breakage to existing public APIs.

## Orchestrator decision

Agree with Variant 3, with one safety refinement: the intent-review stage must be a pure deterministic pre-stage whose default decisions preserve current dream outcomes unless a cluster is already below threshold, conflicted, or suppressed by an existing user-rejected retired preference. The goal is an explicit two-stage audit trail and structured gating boundary without turning this release into the larger multi-phase dream rewrite deferred by `t_1e4f70f5`.

Schema contracts should ship as local package artifacts and structured MCP/CLI envelopes first. Runtime validation should reuse a small local validator only for the new envelopes and selected MCP input boundaries; this avoids adding a heavy JSON Schema dependency while still making the contract visible and testable.
