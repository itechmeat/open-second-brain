### Variant 1: Unified WriteGate framework

- **Approach**: Build one cross-cutting gate framework (`src/core/gates/`) with a generic `Gate<T>` interface, a composable `GatePipeline`, and a single typed `WriteRejection` error hierarchy. All 11 units are expressed as gate stages plugged into this pipeline: entity quality, durability classification, conflict advisory, approval staging, vector validation, snapshot-before-destructive, quota classification. Every persist path (vault writes, `vecUpsert`, `deleteBySource`) is refactored to run through the pipeline.
- **Trade-offs**:
  - Pro: maximally DRY; one place to reason about "what can reject a write"; uniform rejection logging and doctor visibility for free.
  - Pro: a single error taxonomy makes CLI/MCP surfacing consistent across all units.
  - Con: the units span three genuinely different subsystems (Markdown vault writes, the sqlite-vec store, an HTTP embeddings client) with different payload types and failure semantics; a shared `Gate<T>` interface is speculative generality that mostly holds `unknown`.
  - Con: the framework itself becomes a serialization point - every unit's atomic commit depends on it, so a design flaw discovered at unit 7 forces rework across the whole wave.
  - Con: units t_3beb374c (e5 prefixes), t_66c12a67 (fact retire), and t_29a63073 (perms migration) are not gates at all and get shoehorned in or left inconsistent.
- **Complexity**: large
- **Risk**: high

### Variant 2: Per-unit isolated changes

- **Approach**: Each unit lands independently at its natural existing choke point with no new shared modules: extend `normalizeEntityName` in place, add checks inside `vecUpsert`, add a durability check inside the write path, patch `classifyError` twice (once per embeddings unit), wrap `deleteBySource` with a direct `createSnapshot` call, and so on. Error codes are added ad hoc per subsystem as each unit needs them.
- **Trade-offs**:
  - Pro: trivially atomic commits with no ordering constraints; any unit can be dropped or reverted without touching the others.
  - Pro: smallest possible diff per unit; matches the "improvement, not net-new" scoping of several units.
  - Con: the brain write path ends up with four uncoordinated pre-persist checks (capture-boundary, pinned budget, durability, approval queue, conflict advisory) with inconsistent rejection surfacing - exactly the "scattered per-call-site checks" the project constraints forbid.
  - Con: t_8880a68d and t_144b680a both rework `classifyError`; done independently they conflict or duplicate Retry-After/quota parsing.
  - Con: rejection logging conventions diverge per unit, making doctor/hygiene visibility (required by the no-silent-drop constraint) inconsistent.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Cluster-scoped kernels, per-unit atomic commits

- **Approach**: Group the 11 units into four subsystem clusters and introduce a small shared kernel only where units provably share a choke point, then land each unit as an atomic commit on top of its kernel. Cluster A (brain write path: durability gate, approval queue, conflict advisory, entity reject, fact retire) gets a light `src/core/brain/gates/` chain with one typed `WriteRejection` result and one logged-skip convention that also fronts the existing capture-boundary and pinned budget gates; Cluster B (vec store: NaN/zero validation, e5 prefixes) gets a `validateVector` util at `vecUpsert` plus preset-aware prefix config in `presets.ts`; Cluster C (embeddings client: quota classification, Retry-After/degrade) gets one refactor of `classifyError` into a richer `{category, retriable, retryAfterMs}` classification with new `EMBEDDING_QUOTA_*`/rate-limit SearchError codes, consumed by both units in sequence; Cluster D (store safety: snapshot gate, hardening/prune) gets a `withSnapshot(label, op)` wrapper over the existing `snapshot.ts` engine, reused by `deleteBySource`, the entity prune, and future destructive ops, with the perms migration and symlink guard landing as doctor/maintenance passes.
- **Trade-offs**:
  - Pro: DRY exactly where coupling is real (the two embeddings units, the multiple brain gates, the two-plus snapshot consumers) without inventing a cross-subsystem abstraction.
  - Pro: preserves per-unit atomic commits - each kernel is itself a small commit, and units within a cluster stack on it while clusters remain mutually independent, so partial shipping stays possible.
  - Pro: error-type design stays subsystem-native (SearchError codes for search/embeddings, `WriteRejection` for brain writes), honoring existing conventions instead of unifying them artificially.
  - Con: requires deciding cluster boundaries and kernel interfaces up front, and sequencing within clusters (classifier before handling, gate chain before the gates that plug into it).
  - Con: two error vocabularies coexist; a reviewer must understand which subsystem a rejection belongs to.
- **Complexity**: medium
- **Risk**: low

### Recommended: Variant 3

**Rationale**: The wave's units cluster naturally along OSB's existing module seams (brain vault, search store, embeddings client, snapshot engine), and Variant 3 puts shared abstractions only at choke points that two or more units actually share - satisfying the repo's "shared choke points over scattered checks" and typed-error constraints without Variant 1's speculative cross-subsystem framework or Variant 2's duplicated `classifyError` rework and uncoordinated gate sprawl. It also keeps every unit an independently revertable atomic commit on one branch, which is exactly what an 11-unit single-release wave needs when any one unit could stall in review.
