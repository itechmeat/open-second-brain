### Variant 1: Additive In-Place Extension
- **Approach**: Extend each existing module directly — `procedural-memory.ts` gains a sibling edge/entity index alongside its flat JSON, `recurrence.ts`/`context-pack.ts` emit prospective recall hints at write time, and a new `attention-recipes.ts` module plus new CLI verbs and MCP tools expose ingest scoping, filtered write, export, and introspection. Each capability is a discrete cohesive function wired through the surfaces that already exist, with no new cross-cutting abstraction.
- **Trade-offs**:
  - Pro: Smallest diff, each task maps to a self-contained change set ideal for atomic TDD commits.
  - Pro: Lowest risk to existing public CLI/MCP APIs — everything is purely additive.
  - Pro: Stays closest to current conventions; reviewers compare narrow, local deltas against main.
  - Con: Provider-readiness is implicit — the Hermes adapter PR must later extract a port from scattered functions, i.e. some rework.
  - Con: Graph/entity logic risks duplication across procedural-memory, recall hints, and recipes (DRY pressure).
  - Con: Introspection/export surfaces read several ad-hoc shapes rather than one model.
- **Complexity**: medium
- **Risk**: low

### Variant 2: Memory-Graph Kernel Behind a Provider Port
- **Approach**: Introduce a single unified memory-graph core (nodes, edges, entities) with a formal provider interface (port), and re-express procedural memory, recall hints, and attention recipes as operations on that graph; OpenSecondBrain becomes the local-first adapter implementing the port. The Hermes-compatible provider later slots in behind the identical interface with no consumer changes.
- **Trade-offs**:
  - Pro: Maximally provider-ready — the next PR is a new adapter, zero consumer rework.
  - Pro: One canonical model satisfies DRY; export/introspection are first-class graph reads.
  - Pro: Strong SOLID dependency-inversion alignment.
  - Con: Largest refactor; touches modules behind existing public APIs, raising regression and API-compat risk.
  - Con: Builds an abstraction for a provider that does not yet exist (YAGNI / KISS tension) within a single release.
  - Con: Harder to keep atomic — the port and its first adapter must land together to stay green.
- **Complexity**: large
- **Risk**: high

### Variant 3: Derived Graph Projection + Declarative Recipe Engine
- **Approach**: Leave the flat markdown/frontmatter as the canonical source of truth and add a deterministically-derived graph projection sidecar (entity links and edges computed from existing files), plus a declarative recipe engine that renders open-loop/learning attention flows and write-time recall hints as derived, auditable artifacts. Export and introspection read the projection through one stable, documented read/write contract that a future provider maps onto.
- **Trade-offs**:
  - Pro: Append-only derivation preserves determinism, local-first behavior, and full auditability (rebuildable from source).
  - Pro: The projection contract is a clean seam a provider adapter can implement without rewriting core modules — provider-ready without a full kernel rewrite.
  - Pro: Recipes are declarative data, keeping logic DRY and feeding context surfaces uniformly; existing APIs stay untouched.
  - Con: Two-layer (source + projection) model adds a rebuild/reconcile step to reason about.
  - Con: Projection staleness must be handled explicitly (deterministic regeneration on write).
  - Con: More moving parts than Variant 1, though far less invasive than Variant 2.
- **Complexity**: medium
- **Risk**: medium

### Recommended: Variant 3
**Rationale**: It satisfies provider-readiness through an explicit, documented projection contract — the exact seam a Hermes adapter needs — without the large, high-risk kernel rewrite of Variant 2 or the implicit "extract it later" rework debt of Variant 1. The derived-projection model is the strongest fit for the project's deterministic, local-first, auditable conventions, and its declarative recipes plus additive surfaces let each task land as atomic, backwards-compatible, TDD-friendly commits.
