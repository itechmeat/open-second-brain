# Time-Aware Recall & Activation Suite - variant audit trail

Consultant: Claude Code (`claude -p`), prompt in `cli-output/prompt.md`, raw output in `cli-output/claude.md`. Fallback (Codex) not needed: the primary returned three parseable variants plus a recommendation.

## Variant 1: In-place layer extension

- **Approach**: Six surgical edits to the files the tasks already name - `ranker.ts` gains an activation term computed from `usedCount` plus an access-time log; `belief-evolution.ts` emits a freshness-trend field; `time-range.ts`/`search.ts` swap `mtimeInRange` for a validity-window check; `traversal.ts` accepts temporal seeds; `evidence-pack.ts`'s abstention drives a re-query wrapper in `search.ts`. Co-access edges become a derived fold over the existing `Brain/search/feedback/` per-event JSON pattern, reusing the link-boost machinery. No new module; each scoring layer adds its own `reasons` entry behind a neutral default.
- **Trade-offs**:
  - Pro: smallest per-file diff, lowest blast radius, each task ships and tests independently within its own file.
  - Pro: trivially honors the neutral-default / bit-identical-when-absent rule layer by layer.
  - Pro: zero or one new MCP tool; mostly new CLI verbs + optional result fields.
  - Con: shared temporal concepts (decay curve, half-life table, days-since-access, validity resolution) get duplicated or re-derived across `ranker`, `belief-evolution`, `time-range`, and `traversal`.
  - Con: no single source of truth for "memory activation"; future tuning means touching many files; Task 1<->4 and Task 3<->5 parent/child coupling is implicit rather than expressed.
- **Complexity**: medium
- **Risk**: low

## Variant 2: Unified temporal-recall engine (centralized logic, conventional storage)

- **Approach**: One core module (e.g. `src/core/search/activation/`) owns the shared primitives: the content-type half-life table, ACT-R reactivation decay, the validity-window resolver, the freshness-trend classifier, and the co-access edge graph. State storage stays on the established patterns - access and co-access events are one-JSON-per-event files under `Brain/search/` with a replayable derived-cache fold (mirroring `feedback.ts`); freshness trend is computed from existing evidence events. The ranker calls a single composed `temporalScore(candidate, ctx)` hook (emitting `reasons`); `search.ts` gets a two-pass controller and routes time-range filtering and causal traversal through the module's window resolver so graph + temporal finally compose.
- **Trade-offs**:
  - Pro: single home for decay/half-life/validity/co-access - no duplication, consistent semantics, one place to tune and test the bi-temporal logic.
  - Pro: keeps the conflict-free per-event-file + replayable-fold convention; no SQLite hot-path writes; determinism and O(candidates) preserved via in-memory edge/activation maps over the candidate set.
  - Pro: expresses the Task 1<->4 and Task 3<->5 relationships as shared primitives rather than implicit cross-file contracts.
  - Con: larger new surface and more upfront design than Variant 1; the six tasks become somewhat coupled through one module.
  - Con: a bug in the shared engine has wider reach than an isolated layer edit; needs careful neutral-default gating so the composed hook is inert when no data exists.
- **Complexity**: large
- **Risk**: medium

## Variant 3: SQLite event-sourced activation projection

- **Approach**: Push temporal state into the store. An additive migration (schema v6) adds append-only `access_events` and `coaccess_edges` tables plus a validity-window column and a materialized freshness-trend column on preference chunks. Activation, co-access, and trend become indexed SQL aggregates joined at the `hydrateChunks` stage; the ranker reads precomputed values off hydrated rows. Recall accesses and co-activation pairs are written to SQLite at recall time.
- **Trade-offs**:
  - Pro: strongest O(candidates) guarantee - activation/co-access are indexed lookups, not folds; telemetry and inspection come for free via SQL.
  - Pro: fits the "additive migration, inert until reindex" convention cleanly for the read path.
  - Con: writing access/co-access rows on the recall hot path adds write amplification and a determinism hazard, and diverges from the documented conflict-free per-vault-file storage pattern (the vault, not SQLite, is the source of truth).
  - Con: state lives in a derived DB rather than replayable vault files; rebuilding or auditing requires a reindex, and concurrent CLI/MCP readers complicate hot-path writes.
  - Con: heaviest migration and SQL surface of the three; freshness trend must be recomputed on reindex rather than read live.
- **Complexity**: large
- **Risk**: high

## Consultant recommendation: Variant 2

**Rationale (verbatim)**: The six tasks all manipulate the same handful of temporal primitives (decay, half-life, validity windows, access reinforcement), so a single core module eliminates the duplication and semantic drift that Variant 1 would scatter across `ranker`, `belief-evolution`, `time-range`, and `traversal`, while still letting each task land as a thin, neutral-default-gated layer. Unlike Variant 3 it keeps state in the conventional per-event-file + replayable-fold form and avoids hot-path SQLite writes, preserving the deterministic-core and conflict-free-write constraints and the O(candidates) budget via in-memory maps. It is the only variant that naturally lets graph traversal and temporal seeding compose (Task 5) and gives the two-pass controller (Task 6) a clean place to re-rank against shared activation logic.

## Orchestrator decision: Variant 2, with two containment refinements

Accepted the recommendation. Refinements (rationale in `design.md`):

1. **Recording at the orchestrator edge.** The consultant's engine would let `search()` itself persist access events; that makes a read path write and breaks test hermeticity. Instead the pure core records only when the surface passes `recordAccess: true`, cache hits never record, and the current query's own ranking is never affected by its own recording.
2. **Freshness-trend classifier placed in `src/core/brain/temporal/`,** not inside the search module. It is a preference-evidence concept consumed by belief-evolution and the dream refresh; search consumes only the stamped `freshness_trend` frontmatter field through the existing injected-reader pattern. This keeps the brain temporal surfaces from importing search code and keeps the classifier testable against `TimelineIndex` fixtures.
