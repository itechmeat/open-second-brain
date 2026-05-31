### Variant 1: Unified recall pipeline orchestrator

- **Approach**: Introduce an explicit, ordered `RecallPipeline` in the search core that threads a single mutable `RecallContext` (raw input, parsed query document, gate decision, heal status, per-lane candidates, verification verdicts, polarity lanes) through typed stages: parse -> surfacing-gate -> FTS-self-heal -> lane-route -> fuse -> multi-record-verify -> polarity-lane. Each of the six tasks becomes one stage with a declared input/output contract, and `search.ts` is refactored to drive the pipeline instead of calling keyword/semantic/rank/MMR directly.
- **Trade-offs**:
  - Pro: one coherent mental model; every feature has an obvious home and ordering is explicit and testable end-to-end.
  - Pro: `why_retrieved` provenance flows naturally as accumulated context across stages.
  - Con: forces a large refactor of the central, backward-compatible `search.ts`, putting the plain-string path at risk.
  - Con: couples six otherwise-independent features into one abstraction - a bug or churn in the pipeline contract touches all of them.
  - Con: over-engineered for features like session-focus and the retrieval gate that don't naturally belong on the same path.
- **Complexity**: large
- **Risk**: high

### Variant 2: Surgical pure helpers around existing search

- **Approach**: Keep `search.ts`, `ranker.ts`, and `fts.ts` structurally intact and add each task as a focused, deterministic helper module (query-document parser, FTS-heal wrapper, surfacing gate, session-focus store, polarity classifier, multi-record verifier), each with its own focused test suite. Wire each helper in at the minimal existing call site - the parser in front of `brain_search`/`o2b search` argument handling, the heal wrapper inside `keywordTopK`, the polarity/verify layers at result-assembly - gated behind new explicit options so the plain-string path is untouched by default.
- **Trade-offs**:
  - Pro: directly honors the conventions (pure helpers, focused tests) and the backward-compat / bounded-self-heal constraints.
  - Pro: features ship and are reviewable independently; one feature's risk is contained to its call site.
  - Pro: lowest blast radius on the hot read path.
  - Con: no single place describes the overall recall flow; cross-feature ordering (gate before heal before fuse before lanes) lives implicitly in call-site sequencing.
  - Con: `why_retrieved` provenance must be plumbed through several seams rather than accumulated in one context object.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Two-tier request / trust split

- **Approach**: Organize the six tasks into two cohesive subsystems sharing one extended `SearchOptions`/`SearchOutcome` contract: a **request tier** (structured query document, retrieval gate, session focus - "what to ask and whether to ask") and a **trust tier** (FTS self-heal, multi-record verification, polarity lanes - "make results reliable and well-presented"). The request tier produces a normalized intent/lane spec consumed by the existing search, and the trust tier wraps and post-processes its output; `search.ts` gains two thin seams rather than a full rewrite.
- **Trade-offs**:
  - Pro: meaningful conceptual grouping that aids review and documentation without a monolithic pipeline.
  - Pro: contained changes to `search.ts` (two seams) while still giving provenance a shared contract to ride on.
  - Pro: request-tier features can short-circuit (gate skips, focus-only) before touching retrieval.
  - Con: the two-tier boundary is somewhat artificial - session-focus spans both asking and ranking, blurring the split.
  - Con: more upfront contract design than Variant 2 for marginal organizational gain on an already-large PR.
- **Complexity**: medium
- **Risk**: medium

### Recommended: Variant 2

**Rationale**: The project conventions explicitly call for pure parser/ranker helpers with focused tests, backward-compatible read paths gated behind explicit options, and bounded self-healing - all of which Variant 2 satisfies directly while keeping the hot `search.ts` path stable across a six-feature PR. The unified pipeline (Variant 1) buys coherence at the cost of a high-risk rewrite of the backward-compatible search core, and the two-tier split (Variant 3) imposes a contract boundary that session-focus and the gate don't cleanly respect; surgical helpers let each feature ship, test, and fail in isolation while provenance is plumbed through the existing `reasons[]` seam.
