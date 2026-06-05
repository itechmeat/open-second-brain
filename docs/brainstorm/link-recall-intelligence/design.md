# Link & Recall Intelligence Suite - the graph self-organizes and recall quality becomes measurable

**Status:** approved
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation
**Epic:** t_06a7cc0e; children t_ab540afe, t_d6660a83, t_e2215d49, t_4ba927ec, t_2fa95db1, t_ae973491

## Problem statement

The link graph only knows edges the operator (or an agent) wrote by hand:
wikilinks to an alias stay unresolved in the search index, embedding-near
notes that never name each other stay unconnected, and no surface discovers
graph-wide structure. Meanwhile recall quality is unmeasured - there is no
fixed-dataset benchmark, so ranking changes land blind - and retrieval
parameters are static even though an explicit-feedback fold already exists.
Every feature also produces numbers a near-future dashboard plugin needs, but
today metrics are scattered across recall-telemetry, gate-telemetry,
IndexStats, and Brain/log sidecars.

## Scope

- **Metrics sink** (cross-cutting): one append-only, schema-versioned JSONL
  layer under `Brain/metrics/` that every feature in this suite writes
  run-level records to; the stable on-disk contract the dashboard plugin
  will read without importing OSB internals.
- **Alias resolution** (t_d6660a83): vault-wide frontmatter `aliases`
  resolution at search-index materialization - new `doc_aliases` table
  (schema v7), indexer extraction, alias pass in `resolveLinkTargets`.
- **Recall benchmark** (t_e2215d49, re-scoped): fixed fixture vault + fixed
  query dataset, hit@k + MRR metrics, thresholds asserted in bun tests so
  ranking regressions fail CI; on-demand CLI/MCP run against any vault.
- **Bridge discovery** (t_ab540afe): orphan-first pass over the vec index
  proposing links between embedding-near, unconnected notes; reviewable
  proposal artifact with accept/dismiss lifecycle.
- **Community detection** (t_4ba927ec): deterministic label propagation over
  the links graph; communities of size >= 4 materialize derived cluster
  notes under `Brain/clusters/`.
- **Query expansion** (t_2fa95db1): deterministic producer of the existing
  structured lex/vec/hyde query document from a bare query (synonyms +
  entity registry + template hyde passage); opt-in `--expand`.
- **Self-tuning recall** (t_ae973491): opt-in, bounded, replayable parameter
  selection (candidate-pool multiplier, traversal depth, learned-weights
  toggle, expansion toggle) by grid evaluation against the recall benchmark;
  persisted to `Brain/search/tuning.json`.
- CLI verbs (`links`, `clusters`, `benchmark`, `tune`, `search --expand`),
  MCP tools, maintenance-lane task registration, docs incl. the dashboard
  metrics contract.

## Out of scope

- LLM-generated prose in cluster notes or bridge reasons (core stays
  deterministic; prose synthesis belongs to calling agents - same rule as
  deep-synthesis).
- Auto-applying bridge proposals to user notes (accept is operator/agent
  initiated, per-pair).
- A metrics SQLite table or any dashboard UI (the dashboard plugin is a
  future cycle; this cycle ships only its data contract).
- Local-model (GGUF) query expansion; embedding-provider changes.
- Tuning the fusion weight constants themselves (the learned-weights fold
  already owns per-layer multipliers; tuning composes with it, never
  rewrites it).

## Chosen approach

Consultant Variant 3 (hybrid layered) with Variant 2's metrics substrate -
override rationale recorded in `variants.md`. Heavy graph passes (bridge
discovery, community detection) compute over the search SQLite `links` +
`chunk_vec` tables and emit reviewable vault artifacts; the alias fix lands
inside link materialization where the gap is; expansion and self-tuning are
deterministic producers/folds beside the existing structured-query parser and
learned-weights fold; all run-level numbers flow through one shared metrics
sink writing `Brain/metrics/<surface>.jsonl`.

## Design decisions

- **Metrics envelope mirrors continuity records.** One JSON object per line:
  `{schema: "o2b.metrics.v1", surface, run_at, payload}`. Additive-optional
  fields do not bump the version; renames/removals do. One file per surface
  (`Brain/metrics/recall_benchmark.jsonl`, `bridge_discovery.jsonl`,
  `communities.jsonl`, `index.jsonl`, `self_tuning.jsonl`) so the dashboard
  reads only what it renders. O_APPEND single-line writes (the maintenance
  journal pattern); fail-soft reader `listMetrics`.
- **Run-level only.** Per-search events stay in recall telemetry (existing
  surface); `Brain/metrics/` records one line per index run / discovery pass
  / benchmark / tuning run. Query-expansion usage rides the benchmark record
  and recall-telemetry metadata instead of its own high-volume file.
- **Aliases live in the index, not a second scan.** `doc_aliases(document_id,
  alias)` populated by the indexer from frontmatter `aliases:` arrays
  (NFC-normalised, lower-cased - the exact `alias-index.ts` normalisation).
  `resolveLinkTargets` gains a second UPDATE pass: unresolved links whose
  `target_path` contains no `/` join `doc_aliases`; collisions resolve
  first-wins by sorted document path (same rule as `alias-index.ts`).
  `IndexStats.aliasResolved` counts links the alias pass resolved.
  The Brain-artifact `alias-index.ts` stays as-is (different consumer).
- **Bridge discovery is orphan-first and read-only.** Candidates ranked by
  inbound-link count ascending (the article's orphan signal); per candidate,
  chunk embeddings KNN against `chunk_vec` (existing `vecSearch`), L2-on-unit
  distance converted to cosine similarity, doc-level max aggregation, pairs
  already linked in either direction excluded, deduped, thresholded, capped.
  Output: regenerated `Brain/proposals/bridges.md` (kind `brain-bridge-
  proposals`) listing pairs with similarity + inbound counts. Accept writes
  `related: "[[target]]"` into the source note's frontmatter (one pair at a
  time, validated); dismiss persists pair keys in
  `Brain/proposals/bridges-dismissed.json` so re-runs stay quiet.
- **Community detection is deterministic label propagation.** Undirected
  doc-level graph from resolved links; labels initialised to sorted doc ids;
  synchronous sweeps in sorted order with lowest-label tie-break; iteration
  cap. No Louvain dependency, no randomness. Communities of size >= minSize
  (default 4) materialize `Brain/clusters/<slug>.md` where slug derives from
  the most-central member (highest internal degree, path tie-break). Cluster
  notes are derived artifacts: regenerated each run, auto-generated header,
  deterministic digest body (members by internal degree, shared entities from
  `chunk_entities`, link density) - no LLM prose. Stale cluster notes (community
  gone) are removed on the next run. `DEFAULT_TIER_MAP` gains a
  `brain-cluster` entry so the tier guard treats regeneration as
  framework-owned.
- **Expansion is a producer for an existing parser.** `expandQuery` builds a
  `StructuredRecallQueryDocument`: lex include = query tokens + bounded
  synonym expansions (`deriveExpansionTerms`); vec = raw query + one
  entity-context line when registry entities match; hyde = one deterministic
  template passage naming the query and matched entities. Opt-in per call
  (`expand: true` / `--expand`); never silently active, so cached queries and
  benchmarks stay comparable.
- **Self-tuning selects from a bounded grid, judged by the benchmark.**
  Parameters: candidate-pool multiplier {3, 4, 5}, traversal depth {1, 2},
  learned-weights {on, off}, expansion {on, off}. `tuneRecall` evaluates the
  grid against a dataset deterministically, picks best MRR (stable
  tie-break: fewer/smaller params first), persists
  `Brain/search/tuning.json` with scores, dataset hash, and `evaluated_at`.
  `search()` consults the tuned parameters only when self-tuning is enabled
  (config `search.self_tuning` / `OSB_SELF_TUNING=1`); values are re-validated
  against the grid bounds on read and fail soft to defaults. Replayable:
  delete tuning.json and re-run, nothing else changes.
- **Benchmark is both CI gate and objective function.** Core
  `runRecallBenchmark(config, dataset, opts)` returns per-query hit/rank and
  aggregate hit@k + MRR. The repo ships a fixture vault + dataset with
  thresholds pinned in a bun test (deterministic local embedding provider).
  The same runner serves `brain benchmark` for operator vaults and
  `tuneRecall` as the scoring callback.
- **Maintenance lane hosts the periodic passes.** `brain maintenance run`
  gains `bridges` and `clusters` tasks after `reindex` (stale-first ordering
  already handles fairness); both also run on demand via their verbs.

## File changes

New core: `src/core/brain/metrics.ts`, `src/core/brain/link-graph/
bridge-discovery.ts`, `src/core/brain/link-graph/communities.ts`,
`src/core/search/query-expansion.ts`, `src/core/search/benchmark.ts`,
`src/core/search/tuning.ts`.
Modified core: `src/core/search/schema.ts` (v7), `store.ts` (doc_aliases
writers/readers, alias resolve pass, inbound-count + pair readers),
`indexer.ts` (alias extraction + metric emission), `search.ts` (expand +
tuned-parameter read path), `types.ts` (IndexStats.aliasResolved, config),
`src/core/config.ts` / search config resolution (self_tuning flag),
`src/core/brain/frontmatter-tiers.ts` (brain-cluster tier entry).
New CLI verbs: `links.ts`, `clusters.ts`, `benchmark.ts`, `tune.ts` (each
registered in the 5 standard places); `search.ts` verb gains `--expand`.
MCP: 4 new tools (brain_links, brain_clusters, brain_benchmark, brain_tune)
in `src/mcp/brain-tools.ts`; tool-count pins 73 -> 77.
Tests: new suites per module + e2e `tests/e2e/link-recall-intelligence.
integration.test.ts`; fixture vault under `tests/fixtures/recall-benchmark/`.
Docs: CHANGELOG 0.45.0, README, docs/cli-reference.md, docs/how-it-works.md,
new `docs/metrics.md` (dashboard data contract).

## Risks and open questions

- **Vec coverage**: vaults indexed with the null provider have no embeddings;
  bridge discovery must report "no vec layer" cleanly (fail-soft, metric
  records zero candidates) rather than proposing nothing silently.
- **Label propagation stability**: synchronous sweeps can oscillate on
  bipartite-ish subgraphs; the iteration cap plus lowest-label tie-break
  guarantees termination and determinism - tests pin a known oscillation
  case.
- **Benchmark threshold brittleness**: thresholds pinned slightly below
  measured values (one failing-direction margin) so legitimate ranking
  improvements do not flap the gate.
- **Cluster-note deletion**: removing stale derived notes must never touch
  non-derived files - deletion is restricted to `Brain/clusters/` files
  whose frontmatter carries the generated marker.
- **Accept write-path**: writing `related:` into user frontmatter must
  respect the tier guard (user-tier field, additive only) and link-type
  constraints from the schema pack when one declares `related`.
