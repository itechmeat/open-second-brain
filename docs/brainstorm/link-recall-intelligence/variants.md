# Link & Recall Intelligence Suite - consultant variants (audit trail)

Consultant: Claude CLI (`claude -p`), prompt in `cli-output/prompt.md`, raw
output in `cli-output/claude.md`. Fallback (Codex) not needed - primary
returned 3 parseable variants.

## Variant 1: Index-native (everything in the search SQLite)

- **Approach**: Push all six features into the search index via an additive
  schema v7 migration. Bridges and communities become pending-proposal rows,
  alias resolution extends `resolveLinkTargets`, query-expansion output and
  self-tuning parameters are stored tables, and the uniform metrics layer is a
  single `metrics(surface, run_at, payload)` table in the same SQLite. Graph
  algorithms run as recursive CTEs / post-passes in `indexer.ts` directly over
  the `links` table.
- **Trade-offs**:
  - Pro: one transactional store, no cross-store sync; graph queries fast and
    natural; alias fix lands exactly where the gap is.
  - Pro: self-tuning objective function queryable with SQL.
  - Con: dashboard plugin must open OSB's SQLite and bind to its schema,
    violating "readable without importing internals".
  - Con: proposals-as-rows are less reviewable than markdown; weakens the
    "reviewable artifact before mutating notes" constraint.
  - Con: couples bridge/community generation to index lifecycle rather than
    the maintenance lane.
- **Complexity**: large
- **Risk**: high

## Variant 2: Vault-native (Brain/ artifacts + single JSONL metrics layer)

- **Approach**: Express bridge proposals and synthesized cluster notes as
  reviewable markdown artifacts under `Brain/`, persist self-tuning state
  alongside `feedback.ts` as bounded replayable JSON, and make the uniform
  metrics layer a single append-only `Brain/metrics/*.jsonl` log. Only the
  alias fix and benchmark touch SQLite/tests; community detection and orphan
  ranking read the links table into memory and emit markdown.
- **Trade-offs**:
  - Pro: dashboard reads plain JSONL with no OSB internals - cleanest
    satisfaction of the cross-cutting contract; idiomatic with existing
    per-event JSON feedback and Brain/log sidecars.
  - Pro: proposals/derived notes inherently reviewable and participate in
    recall as real notes; matches deterministic/replayable philosophy.
  - Con: graph algorithms still must pull the graph out of SQLite each run.
  - Con: self-tuning objective reads require scanning/parsing JSONL.
  - Con: scattering compute risks inconsistent metric emission unless a
    shared sink is enforced.
- **Complexity**: medium
- **Risk**: low

## Variant 3: Hybrid layered (lane-orchestrated compute, Brain/ artifacts, dual-write metrics)

- **Approach**: Heavy graph passes (bridge discovery, community detection,
  orphan/backlink ranking) run as maintenance-lane passes over the SQLite
  `links` table; their outputs are reviewable `Brain/` proposal and
  derived-cluster artifacts. The alias fix lands in `resolveLinkTargets`;
  expansion is a deterministic producer feeding the existing parser;
  self-tuning mirrors the learned-weights fold. The metrics layer is
  dual-write: a queryable `metrics` table (source of truth, v7 migration)
  plus a deterministic `Brain/metrics/*.jsonl` projection as the dashboard's
  stable contract. A shared `MetricsSink` interface and a common proposal
  artifact contract bind all six features.
- **Trade-offs**:
  - Pro: each task uses its right substrate - SQL for graph math, markdown
    for review, JSONL for the dashboard - single sink keeps emission uniform.
  - Pro: fits conventions exactly (maintenance lane, reviewable proposals,
    deterministic projection, additive v7).
  - Pro: self-tuning queries the metrics table efficiently yet the dashboard
    never imports internals.
  - Con: dual-write adds a projection surface that must stay deterministic
    and consistent (table -> JSONL replay).
  - Con: most moving parts; largest of the three; shared abstractions add
    up-front design cost.
- **Complexity**: large
- **Risk**: medium

## Consultant recommendation: Variant 3

> It is the only variant that simultaneously honors the two hardest
> constraints - graph algorithms want SQLite's transactional link table,
> while the dashboard needs a stable on-disk contract with no internal
> coupling - by computing in SQL and projecting deterministically to
> `Brain/metrics/` JSONL. It also slots cleanly into established conventions
> (maintenance lane for heavy periodic passes, reviewable proposal artifacts,
> bounded replayable folds, single additive v7 migration), where Variant 1
> breaks the dashboard-decoupling and reviewability constraints and Variant 2
> weakens graph performance and the self-tuning objective-function read path.

## Orchestrator decision: Variant 3 with Variant 2's metrics substrate

Accepted Variant 3's compute and artifact architecture (graph passes over the
SQLite `links` table, reviewable `Brain/` proposal and cluster artifacts,
alias fix in `resolveLinkTargets`, deterministic expansion producer,
self-tuning as a bounded replayable fold) but overrode the dual-write metrics
layer in favor of Variant 2's single-write `Brain/metrics/*.jsonl` through one
shared sink module.

Rationale: the metrics in this suite are run-level (one record per index run,
bridge pass, benchmark run, tuning run), not per-query - tens of records per
day, not thousands - so the SQL queryability the table buys is negligible
while the projection surface it costs (table + replay + consistency tests)
is real. OSB precedent already settles this pattern: continuity records
(`o2b.continuity.v1`) are schema-versioned append-only JSONL with fail-soft
readers, and the self-tuning objective function reads benchmark output
directly from the in-process benchmark run, not from persisted metrics.
