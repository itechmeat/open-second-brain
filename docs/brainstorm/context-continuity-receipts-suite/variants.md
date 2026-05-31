# Context Continuity & Receipts Suite - brainstorm variants

## Consultant output

Source: `cli-output/claude.md`

### Variant 1: Shared continuity substrate with feature modules on top

- **Approach**: Extract one small, append-only, rebuildable record substrate (stable source IDs, content/text hashing, redaction + private-flag policy, bounded pagination, stable JSON envelope, purge/invalidate-by-source) and build all four log-shaped features - injection receipts, recall telemetry, pre-compaction decision capture, and session-DAG nodes - as typed record kinds on it. The three context-pipeline features (budget presets diagnostic, cache-stable ordering, repeated-context dedup) attach as opt-in transforms/readers over `context-pack.ts` and `pre-compress-pack.ts` without owning their own persistence. Each feature stays a separate module with its own flag and CLI/MCP surface; only the substrate is shared.
- **Trade-offs**:
  - Pro: maximal DRY - hashing, redaction, pagination, JSON contract, and forget/purge integration are written and tested once, then reused by receipts/telemetry/decisions/DAG.
  - Pro: SOLID - substrate is a single responsibility with a stable interface; features depend on the abstraction, satisfying the rebuildable/auditable derived index constraint uniformly.
  - Pro: redaction/private-content safety and forget/source-purge are enforced centrally, lowering leak risk.
  - Con: the substrate must be designed before most vertical value lands.
  - Con: over-generalizing the record schema risks a leaky abstraction if kinds diverge.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Independent vertical slices, minimal sharing

- **Approach**: Implement each of the seven tasks as a fully self-contained module with its own store/files, flag, contract, and tests, sharing only small leaf utilities ad hoc.
- **Trade-offs**:
  - Pro: KISS per feature and straightforward atomic TDD commits.
  - Pro: lowest rollback blast radius.
  - Con: repeated redaction, pagination, JSON envelopes, and purge-by-source logic across log-shaped surfaces.
  - Con: privacy and source-purge behavior can drift between features.
  - Con: seven different JSON contracts increase maintenance.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Central injection-boundary pipeline orchestrator

- **Approach**: Model context assembly as one staged pipeline and compaction as a second pipeline, with the seven features registered as stages/subscribers.
- **Trade-offs**:
  - Pro: conceptually clean context flow.
  - Pro: extensible stage registration.
  - Con: high coupling and difficult opt-out behavior.
  - Con: drifts toward a general LLM orchestration platform.
  - Con: hardest to deliver as atomic TDD commits.
- **Complexity**: large
- **Risk**: high

## Orchestrator decision

Chosen: **Variant 1 - Shared continuity substrate with feature modules on top**.

Rationale: four selected tasks are record-log-shaped and need the same guarantees: stable IDs, bounded pagination, redaction-safe serialization, source linkage, and future invalidation. A small substrate keeps those guarantees centralized without forcing context pack/search/session features through a central orchestration pipeline. Context ordering, deduplication, and budget presets remain opt-in transforms/readers over existing surfaces so default behavior stays stable.
