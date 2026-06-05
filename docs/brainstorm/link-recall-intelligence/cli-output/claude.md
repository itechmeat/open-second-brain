### Variant 1: Index-native (everything in the search SQLite)
- **Approach**: Push all six features into the search index via an additive schema v7 migration. Bridges and communities become pending-proposal rows, alias resolution extends `resolveLinkTargets`, query-expansion output and self-tuning parameters are stored tables, and the uniform metrics layer is a single `metrics(surface, run_at, payload)` table in the same SQLite. Graph algorithms (community detection, orphan ranking) run as recursive CTEs / post-passes in `indexer.ts` directly over the `links` table.
- **Trade-offs**:
  - Pro: one transactional store, no cross-store sync; graph queries are fast and natural over the existing links table; alias fix lands exactly where the gap is.
  - Pro: self-tuning objective function (benchmark scores) is queryable with SQL — trivial closed-loop reads.
  - Con: dashboard plugin must open OSB's SQLite and bind to its schema, violating "readable without importing internals / stable on-disk contract" unless an exporter is also built.
  - Con: proposals-as-rows are less reviewable than markdown; weakens the "reviewable artifact before mutating notes" constraint.
  - Con: couples bridge/community generation to index lifecycle rather than the maintenance lane.
- **Complexity**: large
- **Risk**: high

### Variant 2: Vault-native (Brain/ artifacts + single JSONL metrics layer)
- **Approach**: Express bridge proposals and synthesized cluster notes as reviewable markdown artifacts under `Brain/` (mirroring dream dry-run / staged tier-drift repair), persist self-tuning state alongside `feedback.ts` as bounded replayable JSON, and make the uniform metrics layer a single append-only `Brain/metrics/*.jsonl` log that every feature writes to. Only the alias fix and benchmark touch SQLite/tests; community detection and orphan ranking read the links table into memory and emit markdown.
- **Trade-offs**:
  - Pro: dashboard reads plain JSONL with no OSB internals — cleanest satisfaction of the cross-cutting contract; idiomatic with existing per-event JSON feedback and Brain/log sidecars.
  - Pro: proposals/derived notes are inherently reviewable and participate in recall as real notes; matches deterministic/replayable philosophy.
  - Con: graph algorithms still must pull the graph out of SQLite each run — duplicated read path, weaker for large graphs.
  - Con: self-tuning's objective function (benchmark scores) requires scanning/parsing JSONL rather than querying — replayable but less ergonomic.
  - Con: scattering compute across Brain/ modules risks inconsistent metric emission unless a shared sink is enforced.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Hybrid layered (lane-orchestrated compute, Brain/ artifacts, dual-write metrics)
- **Approach**: Heavy graph passes (bridge discovery, Louvain community detection, orphan/backlink ranking) run as maintenance-lane passes over the SQLite `links` table; their outputs are reviewable `Brain/` proposal and derived-cluster artifacts. The alias fix lands in `resolveLinkTargets`; expansion is a deterministic producer feeding the existing parser; self-tuning mirrors the learned-weights fold. The metrics layer is dual-write: a queryable `metrics` table (source of truth, v7 migration) plus a deterministic `Brain/metrics/*.jsonl` projection that is the dashboard's stable contract. A shared `MetricsSink` interface and a common `Proposal` artifact contract bind all six features.
- **Trade-offs**:
  - Pro: each task uses its right substrate — SQL for graph math, markdown for review, JSONL for the dashboard — while a single sink keeps emission uniform.
  - Pro: fits conventions exactly (maintenance-lane window+lease for periodic work, reviewable proposals, deterministic projection, additive v7).
  - Pro: self-tuning queries the metrics table efficiently yet the dashboard never imports internals.
  - Con: dual-write adds a projection surface that must stay deterministic and consistent (table → JSONL replay).
  - Con: most moving parts; largest of the three within the ~50-70 file PR; shared abstractions add up-front design cost.
- **Complexity**: large
- **Risk**: medium

### Recommended: Variant 3
**Rationale**: It is the only variant that simultaneously honors the two hardest constraints — graph algorithms want SQLite's transactional link table, while the dashboard needs a stable on-disk contract with no internal coupling — by computing in SQL and projecting deterministically to `Brain/metrics/` JSONL. It also slots cleanly into established conventions (maintenance lane for heavy periodic passes, reviewable proposal artifacts, bounded replayable folds, single additive v7 migration), where Variant 1 breaks the dashboard-decoupling and reviewability constraints and Variant 2 weakens graph performance and the self-tuning objective-function read path. The added dual-write surface is a deterministic, replayable projection rather than true sync, keeping it within the project's deterministic-first discipline.
