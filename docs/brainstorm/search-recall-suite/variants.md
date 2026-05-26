# Variant audit trail - Hybrid Search and Recall Quality Suite

Primary consultant: Claude Code (`claude -p`), exit 0, three parseable
variants. Fallback (Codex) not invoked.

Note on environment: the consultant CLI could not be streamed directly through
the orchestrator's shell (a harness-level output fault on sub-CLI spawn). It
was run via a detached wrapper script writing to
`cli-output/claude.md`; the raw output is preserved there unedited.

## Variants produced by the consultant (verbatim)

### Variant 1: Incremental in-place extension
- **Approach**: Keep `rankResults` as the single scoring authority and extend
  it to emit a `reasons: string[]` per result (built from the layer scores it
  already computes). Add MMR and link-traversal as two new *pure* modules
  invoked sequentially in `search.ts` after ranking (rank -> traverse-expand ->
  re-rank merged set -> MMR-diversify -> property-filter). Entity extraction and
  heading breadcrumbs each get their own schema migration with dedicated
  storage (entity table + a breadcrumb-bearing FTS column), feeding the
  existing keyword/semantic phases; each of the five degrades independently.
- **Trade-offs**: matches existing conventions exactly (pure ranker, I/O in
  store/search, self-contained testable units); per-layer reasons fall out of
  existing intermediate values; per-feature graceful degrade is obvious.
  Cons: `search.ts` grows several sequential phases with no shared framework;
  traversal's expand-then-rerank needs a second hydrate/rank pass to keep
  bounded.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Formalized retrieval pipeline
- **Approach**: Introduce a `Stage` abstraction - each stage a declared pure
  transform over a shared candidate record (fts -> semantic -> fuse/rank ->
  entity-boost -> traversal-expand -> mmr-diversify -> property-filter).
  Reasons accumulate automatically. Ranker decomposed into fuse + boost
  stages; order/toggles config-driven.
- **Trade-offs**: maximally introspectable and reorderable; future signals
  slot in without touching `search.ts`; uniform caps at the runner. Cons:
  large refactor of working, tested, determinism-critical code; shared mutated
  candidate record is harder to keep frozen and reason about; over-engineered
  for five fixed layers.
- **Complexity**: large
- **Risk**: medium

### Variant 3: FTS-centric, schema-light
- **Approach**: Push signals into FTS5 - entity tokens and heading breadcrumbs
  become extra indexed columns so entity-boost and header recall emerge from
  BM25 with minimal query-time code; MMR and traversal effects folded into the
  single fused score.
- **Trade-offs**: smallest query-time surface; entity/header recall need
  almost no new ranking logic. Cons: fights F1 (folding signals into one BM25
  column muddies per-layer attribution); determinism risk from injected FTS
  tokens and coarse column weighting; couples two independent features to the
  FTS schema.
- **Complexity**: medium
- **Risk**: medium-high

### Consultant recommendation: Variant 1
Rationale: aligns with the codebase's strongest conventions (pure ranker,
I/O-in-store, explicit tested tie-breaks), so `reasons` is near-free and each
feature lands as an independently graceful-degrading commit. Avoids Variant
2's premature pipeline framework and Variant 3's FTS coupling, which would
undermine the explainability F1 exists to provide and risk the
Syncthing-critical determinism contract.

## Orchestrator decision: Variant 1 (no override)

Agreed with the consultant. The decisive project-context factors:

1. **F1 is the spine of the suite.** Variant 3 actively degrades per-layer
   attribution by folding signals into shared BM25 columns - it trades away
   the feature that makes the other four tunable. Disqualifying.
2. **Determinism is a hard contract** (identical chunk hashes across Syncthing
   peers). Variant 3's injected FTS tokens and Variant 2's mutated shared
   record both add determinism surface; Variant 1's pure modules add none.
3. **Five fixed layers do not justify a pipeline framework.** Variant 2's
   `Stage` abstraction is a large refactor of load-bearing tested code whose
   payoff (dynamic reordering) is not needed. KISS favours Variant 1.

The one Variant-1 con worth managing - `search.ts` accreting sequential phases
- is contained by keeping each phase a pure module with its own tests and a
single documented ordering in `search.ts`.
