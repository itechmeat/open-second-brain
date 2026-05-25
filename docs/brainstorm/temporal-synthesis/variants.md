# Temporal + synthesis - brainstorm audit trail

Consultant (claude -p) returned three variants and recommended Variant 1.
Orchestrator accepted the recommendation without override.

## Variants (verbatim from `cli-output/claude.md`)

### Variant 1: `temporal/` with materialized TimelineIndex
- **Approach**: A single read pass over `Brain/log/*.jsonl` + `Brain/retired/` + frontmatter bi-temporal atoms (added as additive optionals on signals and preferences) produces a typed `TimelineIndex` keyed by event time and grouped by kind. The five consuming helpers - `timeline-reader`, `stale-watch`, `belief-evolution`, `daily-brief`, `weekly-brief` - are pure projections over the same index. The subsystem lives at `src/core/brain/temporal/` with atoms in `types.ts`, the index builder in `index.ts`, and projection helpers in sibling files.
- **Trade-offs**:
  - Pro: One canonical interpretation of "events in a window" - no semantic drift across helpers.
  - Pro: One disk scan per CLI invocation regardless of how many helpers are called downstream (briefs naturally compose).
  - Pro: Three-layer DAG is structurally explicit (atoms - index - projections), matching the v0.10.17 `link-graph/` precedent where a graph object fed multiple readers.
  - Pro: Briefs structurally *require* the temporal layer - they receive `TimelineIndex`, not raw log paths - satisfying the "must use new temporal layer" constraint by construction.
  - Con: `TimelineIndex` becomes a wide contract that all helpers couple to; widening it later is a cross-cutting edit.
  - Con: Forces an upfront decision on what the index materializes vs. lazily computes.
- **Complexity**: medium
- **Risk**: low

### Variant 2: `temporal/` with per-feature independent helpers
- **Approach**: Each of the five features is its own helper file under `src/core/brain/temporal/` (e.g. `timeline-reader.ts`, `stale-watch.ts`, `belief-evolution.ts`, `daily-brief.ts`, `weekly-brief.ts`), each reading `log-jsonl.ts` and `retired/` directly with a narrow projection scoped to its needs. Only the atom types in `temporal/types.ts` are shared. Briefs internally call `timeline-reader` to source events but no other runtime state is shared.
- **Trade-offs**:
  - Pro: Each helper is independently reviewable and trivially testable in isolation.
  - Pro: Matches the precedent of small, single-purpose helper modules; minimum new abstraction.
  - Pro: Lowest blast radius if one feature is dropped or postponed mid-release.
  - Con: Each helper rescans logs/retired, so a single brief call traverses the vault several times.
  - Con: Window inclusivity, retired-event treatment, and source-pointer resolution must be re-decided in each helper - semantic drift is the realistic failure mode over the next 2-3 releases.
  - Con: "Briefs use the temporal layer" becomes a convention rather than a structural guarantee.
- **Complexity**: small
- **Risk**: low

### Variant 3: `temporal/` with small projection primitives composed into features
- **Approach**: Define ~5 pure typed projection primitives (`eventsInWindow`, `statusTransitionsFor`, `lastEventByKind`, `validityAt`, `retirementsInWindow`) as the helper layer. Each user-facing feature (briefs, stale-watch, belief-evolution, temporal-query-router) is a thin composition of 1-3 primitives in `temporal/features/`. The subsystem's testable core is the primitives; the feature files are mostly wiring.
- **Trade-offs**:
  - Pro: Primitives are tiny and exhaustively testable on synthetic JSONL fixtures.
  - Pro: Future releases extend the temporal layer by adding a primitive, not a parallel helper.
  - Pro: Primitives can be exposed individually through MCP later without exposing whole feature handlers.
  - Con: The abstraction lives at the function-call layer rather than the data layer, so each feature still re-traverses logs through whatever primitives it composes.
  - Con: Picking the right primitive granularity upfront is the dominant design risk; leaky primitives force features back into ad-hoc scans.
  - Con: More files and more naming surface than V1 or V2.
- **Complexity**: medium-large
- **Risk**: medium

## Consultant's recommendation

### Recommended: Variant 1
**Rationale**: All five features genuinely consume the same input - a windowed, typed view of log events plus retired records plus frontmatter validity atoms - so sharing *data* (Variant 1) is more honest than sharing *operations* (Variant 3) or duplicating reads (Variant 2). A materialized `TimelineIndex` makes the "synthesis briefs must use the temporal layer" constraint structural rather than conventional, gives one canonical window semantics across all six features (eliminating the drift risk V2 carries), and matches the v0.10.17 `link-graph/` precedent where a single graph object fed multiple read surfaces with low coordination cost.

## Orchestrator decision

Accepted Variant 1 without override. The consultant's structural argument matches Open Second Brain conventions:

- v0.10.17 (`link-graph/`) already established the pattern: one named subsystem with a small set of pure-data atoms feeding multiple read surfaces. `TimelineIndex` is the temporal-axis analogue of `BacklinkRef` + `ConceptClusterEnvelope`.
- The combo constraint ("synthesis briefs MUST use the new temporal layer") is satisfied by construction: brief helpers receive `TimelineIndex`, not a path.
- One scan per invocation matters even at low vault sizes - daily-brief + stale-watch share the same scan when invoked together by a cron job.
- The "wide contract" concern noted in V1's cons is mitigated by the project's existing convention: atoms are additive optionals; the TimelineIndex frontmatter atom slots are also additive.

Codex fallback was not invoked - primary consultant returned three parseable variants and a clean recommendation.
