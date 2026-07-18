# Memory write-path integrity and store safety - variant audit trail

Consultant: Claude Code (`claude -p`), prompt in `cli-output/prompt.md`, raw
output in `cli-output/claude.md`. Three variants were requested for the wave
architecture as a whole (shared abstractions vs isolated changes), not for
the worth of individual units. The fallback consultant (Codex) was not
invoked because the primary run succeeded with three parseable variants.

## Variant 1: Unified WriteGate framework

- **Approach**: one cross-cutting gate framework (`src/core/gates/`) with a generic `Gate<T>` interface, a composable `GatePipeline`, and a single typed `WriteRejection` error hierarchy. All eleven units are expressed as gate stages plugged into this pipeline; every persist path (vault writes, `vecUpsert`, `deleteBySource`) is refactored to run through it.
- **Trade-offs**:
  - Pro: maximally DRY; one place to reason about "what can reject a write"; uniform rejection logging and doctor visibility for free.
  - Pro: a single error taxonomy makes CLI/MCP surfacing consistent across all units.
  - Con: the units span three genuinely different subsystems (Markdown vault writes, the sqlite-vec store, an HTTP embeddings client) with different payload types and failure semantics; a shared `Gate<T>` interface is speculative generality that mostly holds `unknown`.
  - Con: the framework becomes a serialization point - every unit's atomic commit depends on it, so a design flaw discovered late forces rework across the whole wave.
  - Con: units t_3beb374c (e5 prefixes), t_66c12a67 (fact retire), and t_29a63073 (permission migration) are not gates at all and get shoehorned in or left inconsistent.
- **Complexity**: large
- **Risk**: high

## Variant 2: Per-unit isolated changes

- **Approach**: each unit lands independently at its natural existing choke point with no new shared modules: extend `normalizeEntityName` in place, add checks inside `vecUpsert`, patch `classifyError` twice (once per embeddings unit), wrap `deleteBySource` with a direct `createSnapshot` call, and so on. Error codes are added ad hoc per subsystem as each unit needs them.
- **Trade-offs**:
  - Pro: trivially atomic commits with no ordering constraints; any unit can be dropped or reverted without touching the others.
  - Pro: smallest possible diff per unit; matches the "improvement, not net-new" scoping of several units.
  - Con: the brain write path ends up with five uncoordinated pre-persist checks with inconsistent rejection surfacing - exactly the "scattered per-call-site checks" the project constraints forbid.
  - Con: t_8880a68d and t_144b680a both rework `classifyError`; done independently they conflict or duplicate Retry-After/quota parsing.
  - Con: rejection logging conventions diverge per unit, making doctor/hygiene visibility (required by the no-silent-drop constraint) inconsistent.
- **Complexity**: medium
- **Risk**: medium

## Variant 3: Cluster-scoped kernels, per-unit atomic commits

- **Approach**: group the eleven units into four subsystem clusters and introduce a small shared kernel only where units provably share a choke point, then land each unit as an atomic commit on top of its kernel. Brain write path gets a light gate chain with one logged-skip convention; the vec store gets a `validateVector` kernel plus preset-aware prefix config; the embeddings client gets one `classifyError` rework into `{category, retriable, retryAfterMs}` consumed by both resilience units in sequence; store safety gets a `withSnapshot`-style wrapper over the existing engine, reused by `deleteBySource` and the entity prune, with the permission migration landing as a remediation pass.
- **Trade-offs**:
  - Pro: DRY exactly where coupling is real (the two embeddings units, the multiple brain gates, the multiple snapshot consumers) without inventing a cross-subsystem abstraction.
  - Pro: preserves per-unit atomic commits - each kernel is itself a small commit, units within a cluster stack on it, clusters remain mutually independent, so partial shipping stays possible.
  - Pro: error-type design stays subsystem-native (`SearchError` codes for search/embeddings, typed brain-side rejections for vault writes), honoring existing conventions instead of unifying them artificially.
  - Con: requires deciding cluster boundaries and kernel interfaces up front, and sequencing within clusters (classifier before handling, gate chain before the gates that plug into it).
  - Con: two error vocabularies coexist; a reviewer must understand which subsystem a rejection belongs to.
- **Complexity**: medium
- **Risk**: low

## Consultant recommendation

Variant 3. "The wave's units cluster naturally along OSB's existing module
seams (brain vault, search store, embeddings client, snapshot engine), and
Variant 3 puts shared abstractions only at choke points that two or more
units actually share - satisfying the repo's 'shared choke points over
scattered checks' and typed-error constraints without Variant 1's
speculative cross-subsystem framework or Variant 2's duplicated
`classifyError` rework and uncoordinated gate sprawl. It also keeps every
unit an independently revertable atomic commit on one branch, which is
exactly what an 11-unit single-release wave needs when any one unit could
stall in review." (quoted verbatim from the consultant output)

## Orchestrator decision

Variant 3 is adopted without override. Project context reinforces the
recommendation: v1.30.1 explicitly removed all import cycles and decomposed
oversized modules, so a new cross-subsystem framework (Variant 1) would cut
against the freshly-established one-directional layering, while Variant 2's
double rework of `classifyError` and scattered brain-write checks would
recreate the DRY violations the operator's brief forbids. The dependency
edges accepted with Variant 3 (classifier before handling, snapshot gate
before prune) are recorded in `plan.md`.
