### Variant 1: Incremental in-place extension
- **Approach**: Keep `rankResults` as the single scoring authority and extend it to emit a `reasons: string[]` per result (built from the layer scores it already computes). Add MMR and link-traversal as two new *pure* modules invoked sequentially in `search.ts` after ranking (rank → traverse-expand → re-rank merged set → MMR-diversify → property-filter). Entity extraction and heading breadcrumbs each get their own schema migration with dedicated storage (entity table + a breadcrumb-bearing FTS column), feeding the existing keyword/semantic phases; each of the five degrades independently.
- **Trade-offs**:
  - Pro: matches existing conventions exactly — pure ranker, I/O confined to `store.ts`/`search.ts`, each feature is a self-contained testable unit fitting "one PR, separate commits".
  - Pro: per-layer `reasons` fall directly out of the ranker's existing intermediate values; no contortion to expose them.
  - Pro: graceful-degrade is per-feature and obvious (empty entity table → zero boost; pre-migration breadcrumb column → today's BM25; no embeddings → no MMR).
  - Con: `search.ts` orchestrator grows several sequential phases and more wiring; no shared framework to enforce uniform shape across stages.
  - Con: traversal's "expand then re-rank merged set" requires a second hydrate/rank pass, adding a moderate code path to keep bounded.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Formalized retrieval pipeline
- **Approach**: Introduce a `Stage` abstraction — each stage is a declared pure transform over a shared mutable-but-frozen-at-end candidate record (fts → semantic → fuse/rank → entity-boost → traversal-expand → mmr-diversify → property-filter). Reasons accumulate automatically because every stage appends its contribution to each candidate's annotation list. The existing ranker logic is decomposed into fuse + boost stages, and the pipeline order/toggles become config-driven.
- **Trade-offs**:
  - Pro: maximally introspectable — `reasons` is a first-class byproduct of the stage contract, and stages can be reordered, toggled, or unit-tested in isolation.
  - Pro: future scoring layers (a sixth signal) slot in without touching `search.ts`.
  - Pro: uniform bounding/caps can be enforced at the stage-runner level.
  - Con: large refactor of working, tested code (`ranker.ts` + `search.ts`) — high churn against a load-bearing determinism contract for features that don't yet need dynamic reordering.
  - Con: a shared candidate record mutated across stages is harder to keep `Object.freeze`-clean and to reason about than the current single pure function.
  - Con: over-engineered for five known, fixed layers; the abstraction earns its keep only if many more layers arrive.
- **Complexity**: large
- **Risk**: medium

### Variant 3: FTS-centric, schema-light
- **Approach**: Push as many signals as possible into the existing external-content FTS5 so they fall out of BM25 with minimal query-time code: entity tokens and heading breadcrumbs become extra indexed FTS columns, so entity-boost and header-anchored recall need no new query-time store — they emerge from keyword scoring over enriched columns. MMR and traversal remain query-time but their effects are folded into the single fused score rather than carried as separate layers.
- **Trade-offs**:
  - Pro: smallest query-time surface; entity/header recall require almost no new ranking logic, just enriched indexing.
  - Pro: fewer moving parts at search time, naturally bounded by FTS.
  - Con: directly fights feature #1 — folding signals into one BM25 column muddies per-layer `reasons` (you can't cleanly attribute "entity vs keyword" once both live in FTS).
  - Con: determinism risk — entity tokens injected into FTS must be extracted machine-identically and synced via triggers; column-level FTS weighting (bm25 weights) is coarser than an explicit additive boost and harder to keep bit-identical for un-reindexed vaults.
  - Con: couples two independent features to the FTS schema, so tuning one (entity weight) perturbs the shared BM25 space affecting the other.
- **Complexity**: medium
- **Risk**: medium-high

### Recommended: Variant 1
**Rationale**: It aligns with the codebase's strongest conventions — a pure ranker that already computes every layer, I/O isolated to the store, and explicit tested tie-breaks — so `reasons` is a near-free byproduct and each of the five lands as an independently graceful-degrading commit. It avoids Variant 2's premature pipeline framework (a large refactor of load-bearing deterministic code for layers that aren't yet dynamic) and Variant 3's FTS coupling, which would undermine the very explainability feature #1 exists to provide and put the Syncthing-critical determinism contract at risk.
