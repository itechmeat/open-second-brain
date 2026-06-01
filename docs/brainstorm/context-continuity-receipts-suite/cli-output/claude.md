### Variant 1: Shared continuity substrate with feature modules on top

- **Approach**: Extract one small, append-only, rebuildable record substrate (stable source IDs, content/text hashing, redaction + private-flag policy, bounded pagination, stable JSON envelope, purge/invalidate-by-source) and build all four log-shaped features - injection receipts, recall telemetry, pre-compaction decision capture, and session-DAG nodes - as typed record kinds on it. The three context-pipeline features (budget presets diagnostic, cache-stable ordering, repeated-context dedup) attach as opt-in transforms/readers over `context-pack.ts` and `pre-compress-pack.ts` without owning their own persistence. Each feature stays a separate module with its own flag and CLI/MCP surface; only the substrate is shared.
- **Trade-offs**:
  - Pro: maximal DRY - hashing, redaction, pagination, JSON contract, and forget/purge integration are written and tested once, then reused by receipts/telemetry/decisions/DAG.
  - Pro: SOLID - substrate is a single responsibility with a stable interface; features depend on the abstraction, satisfying the "rebuildable/auditable derived index" constraint uniformly.
  - Pro: redaction/private-content safety and `forget`/source-purge are enforced centrally, lowering the risk of a leak slipping through one feature.
  - Con: the substrate must be designed before most vertical value lands, so the first atomic commits produce infrastructure rather than user-visible features.
  - Con: over-generalizing the record schema (forcing DAG lineage and a receipt into one shape) risks a leaky abstraction if kinds diverge more than expected.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Independent vertical slices, minimal sharing

- **Approach**: Implement each of the seven tasks as a fully self-contained module with its own store/files, flag, contract, and tests, sharing only small leaf utilities (hash, ISO time, redaction helper) pulled in ad hoc. No common substrate; receipts, telemetry, decisions, and the DAG each define and persist their own record format. Context-pipeline features patch `context-pack.ts`/`pre-compress-pack.ts` independently behind their own opt-in switches.
- **Trade-offs**:
  - Pro: maximally KISS per feature and ideal for atomic TDD commits - each task ships and is reviewable in isolation with no cross-feature coupling.
  - Pro: lowest blast radius; a bug or rollback in one feature cannot touch the others, and defaults stay untouched per task.
  - Con: DRY violation across the four log-shaped surfaces - pagination, redaction, JSON envelopes, and purge-by-source get re-implemented 3-4 times, inviting drift and inconsistent privacy guarantees.
  - Con: cross-cutting requirements (forget/source-purge finding references, consistent privacy redaction across receipts + telemetry) must be wired feature-by-feature, easy to miss in one.
  - Con: seven slightly different JSON contracts increase doc/test surface and long-term maintenance.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Central injection-boundary pipeline orchestrator

- **Approach**: Model context assembly as one staged pipeline (retrieve -> dedup -> cache-stable order -> budget/preset -> emit receipt -> record telemetry), and a parallel compaction pipeline (ingest turns -> DAG compaction -> pre-compaction decision capture), both wired through a central orchestrator with a stage/emitter bus. The seven features become registered stages or subscribers rather than standalone modules, with shared context flowing through the pipeline.
- **Trade-offs**:
  - Pro: cleanest conceptual flow - ordering, dedup, budgeting, receipts, and telemetry compose naturally as sequential stages over one context object.
  - Pro: adding future context paths (the spec's "future context paths") is a matter of registering a stage, maximizing extensibility.
  - Con: high coupling - every feature now depends on the orchestrator's lifecycle and shared context shape, the opposite of opt-in/isolated; turning one stage off is harder than an independent flag.
  - Con: drifts toward the explicitly prohibited "general LLM orchestration platform," and risks changing default `brain_context_pack`/search behavior by routing them through new central machinery.
  - Con: largest up-front build and the hardest to deliver as small atomic TDD commits, since the pipeline scaffold must exist before any stage is meaningful.
- **Complexity**: large
- **Risk**: high

### Recommended: Variant 1

**Rationale**: Four of the seven tasks are fundamentally the same shape - a bounded, opt-in, rebuildable, redaction-aware local record log with stable source IDs and purge integration - so a single small substrate satisfies DRY and SOLID and lets the privacy/forget guarantees be enforced and tested once instead of four divergent times. It avoids the prohibited orchestrator coupling of Variant 3 and the cross-surface drift of Variant 2, while still allowing each feature its own flag, CLI/MCP surface, and atomic TDD commits on top. The context-pipeline trio remains lightweight opt-in transforms over existing packs, keeping defaults unchanged as the constraints require.
