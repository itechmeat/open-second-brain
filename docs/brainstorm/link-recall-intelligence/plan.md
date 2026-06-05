# Link & Recall Intelligence Suite - implementation plan

TDD discipline: every task starts with failing tests, ends with a green
suite, formatter + linter run before each commit, one conventional commit
per task.

## Tasks

### Task 1: Metrics sink
- **Files**: `src/core/brain/metrics.ts` (new), `tests/core/brain/metrics.test.ts` (new)
- **Scope**: `appendMetric(vault, {surface, runAt, payload})` writing one
  `{schema: "o2b.metrics.v1", surface, run_at, payload}` line to
  `Brain/metrics/<surface>.jsonl` via O_APPEND; surface name validated
  (`[a-z][a-z0-9_]*`); `listMetrics(vault, {surface?, since?, limit?})`
  fail-soft reader (missing dir/file -> empty, malformed lines skipped);
  newest-first listing.
- **Acceptance**: append + list round-trip; envelope shape pinned; malformed
  line tolerated; surface validation rejects bad names.
- **Depends on**: none

### Task 2: doc_aliases schema v7 + store surface
- **Files**: `src/core/search/schema.ts`, `src/core/search/store.ts`,
  `src/core/search/types.ts`, `tests/core/search/schema.test.ts`,
  `tests/core/search/store-aliases.test.ts` (new)
- **Scope**: migration v7 (`doc_aliases(document_id REFERENCES documents ON
  DELETE CASCADE, alias TEXT, UNIQUE(document_id, alias))` + alias index;
  LATEST_SCHEMA_VERSION = 7); `replaceDocAliases(docId, aliases)`,
  `aliasesForDocument(docId)`; alias pass inside `resolveLinkTargets`
  (unresolved, slash-free targets join `doc_aliases` on the normalised
  alias; first-wins by sorted document path) returning the resolved count.
- **Acceptance**: v6 -> v7 migration test; alias-resolved link gets
  `target_document_id`; collision resolves deterministically; exact-path
  match still wins over alias match.
- **Depends on**: none

### Task 3: Indexer alias extraction + index metric
- **Files**: `src/core/search/indexer.ts`, `src/core/search/types.ts`,
  `tests/core/search/indexer-aliases.test.ts` (new)
- **Scope**: extract frontmatter `aliases` (string array, NFC + lower-case,
  non-string entries skipped) into `replaceDocAliases` during upsert;
  `IndexStats.aliasResolved` populated from the resolve pass; one
  `index` metric record per non-empty index run (files, aliasResolved,
  relationViolations, tierDrift counts) - emission fail-soft.
- **Acceptance**: `[[PA]]` wikilink resolves to note declaring
  `aliases: [PA]` after indexing (links table has target_document_id);
  stats and metric line carry the count; removing the alias un-resolves on
  reindex.
- **Depends on**: Task 1, Task 2

### Task 4: Deterministic query expansion producer
- **Files**: `src/core/search/query-expansion.ts` (new),
  `src/core/search/search.ts`, `src/core/search/types.ts`,
  `tests/core/search/query-expansion.test.ts` (new)
- **Scope**: `expandQuery(query, {store, maxLexTerms?}) ->
  StructuredRecallQueryDocument` - lex include = tokens + bounded synonym
  expansion (`deriveExpansionTerms`); vec = raw query (+ one entity-context
  line when `chunk_entities`/registry names match a token); hyde = one
  deterministic template passage; `search(config, {expand: true})` produces
  the document and routes through the existing structured path; no-op when
  a structured document was already supplied.
- **Acceptance**: same query -> identical expansion (determinism pin);
  expansion improves a fixture recall case lex alone misses; `expand`
  composes with the query cache key (different cache entry).
- **Depends on**: none

### Task 5: Recall benchmark core + CI regression gate
- **Files**: `src/core/search/benchmark.ts` (new),
  `tests/fixtures/recall-benchmark/` (new fixture vault + `dataset.json`),
  `tests/core/search/recall-benchmark.test.ts` (new)
- **Scope**: dataset schema `{queries: [{id, query, expected: [paths],
  k?}]}` with validation; `runRecallBenchmark(config, dataset, {k?,
  expand?, learnedWeights?})` -> per-query `{id, hit, rank,
  reciprocalRank}` + aggregate `{hitAtK, mrr, total}`; fixture vault
  (~15 notes incl. alias + bridge bait) indexed with the deterministic
  local provider; thresholds asserted (hit@5, MRR pinned just below
  measured).
- **Acceptance**: benchmark deterministic across runs; thresholds hold;
  artificially crippling ranking (weight override) fails the gate.
- **Depends on**: Task 4 (expand option)

### Task 6: Bridge discovery core
- **Files**: `src/core/brain/link-graph/bridge-discovery.ts` (new),
  `src/core/search/store.ts` (inbound-count reader, linked-pair check),
  `tests/core/brain/bridge-discovery.test.ts` (new)
- **Scope**: `discoverBridges(store, {maxProposals?, minSimilarity?,
  maxCandidates?})` - inbound-count ascending candidate order; chunk
  embeddings -> `vecSearch` KNN; L2-on-unit -> cosine; doc-level max;
  exclude self/already-linked (either direction)/dismissed; dedupe
  unordered pairs; threshold + cap. `writeBridgeProposals(vault,
  proposals, {now})` regenerates `Brain/proposals/bridges.md` (generated
  marker, similarity + inbound counts per pair);
  `readDismissedBridges`/`dismissBridge` persist pair keys in
  `Brain/proposals/bridges-dismissed.json`; `acceptBridge(vault, source,
  target, {pack?})` appends `related: "[[target]]"` to source frontmatter
  (idempotent, tier-guard-safe, link-constraint-checked when a pack
  declares `related`); no-vec-layer -> empty result with reason.
- **Acceptance**: embedding-near unlinked fixture pair proposed; linked
  pair never proposed; dismiss suppresses across re-runs; accept writes
  frontmatter once; no-vec vault fails soft.
- **Depends on**: none (store readers local to task)

### Task 7: links CLI verb + bridge metrics
- **Files**: `src/cli/brain/verbs/links.ts` (new) + 5-place registration,
  `tests/cli/brain-links.test.ts` (new)
- **Scope**: `brain links discover [--max N] [--min-similarity X] [--json]`
  (runs discovery, writes proposals doc, emits `bridge_discovery` metric),
  `list`, `accept <source> <target>`, `dismiss <source> <target>`;
  unindexed/no-vec vault exits cleanly with message.
- **Acceptance**: CLI round-trip discover -> list -> accept/dismiss on a
  fixture vault; metric line written; JSON shapes pinned.
- **Depends on**: Task 1, Task 6

### Task 8: Community detection core + cluster notes
- **Files**: `src/core/brain/link-graph/communities.ts` (new),
  `src/core/brain/frontmatter-tiers.ts` (brain-cluster entry),
  `tests/core/brain/communities.test.ts` (new)
- **Scope**: `detectCommunities(store, {minSize?, maxIterations?})` -
  deterministic synchronous label propagation (sorted doc ids, lowest-label
  tie-break, iteration cap) over undirected resolved links; members ranked
  by internal degree; `materializeClusterNotes(vault, communities, {store,
  now})` writes `Brain/clusters/<slug>.md` (slug from most-central member;
  kind `brain-cluster`, generated marker, members + shared entities +
  density digest), removes stale generated cluster notes only.
- **Acceptance**: two known fixture communities detected deterministically;
  oscillation case terminates; size < minSize ignored; re-run updates and
  removes correctly; non-generated file in Brain/clusters/ never touched.
- **Depends on**: none

### Task 9: clusters CLI verb + maintenance lane tasks
- **Files**: `src/cli/brain/verbs/clusters.ts` (new) + 5-place
  registration, `src/cli/brain/verbs/maintenance.ts`,
  `tests/cli/brain-clusters.test.ts` (new)
- **Scope**: `brain clusters run [--min-size N] [--json]` (detect +
  materialize + `communities` metric), `brain clusters list [--json]`;
  maintenance verb gains `bridges` and `clusters` tasks after `reindex`.
- **Acceptance**: CLI run materializes fixture clusters + metric; list
  reads back; maintenance run executes new tasks under lease.
- **Depends on**: Task 1, Task 8 (Task 7 for shared discovery helper)

### Task 10: Self-tuning core
- **Files**: `src/core/search/tuning.ts` (new), `src/core/search/search.ts`
  + `types.ts` + config resolution (self_tuning flag, tuned-parameter read
  path), `tests/core/search/tuning.test.ts` (new)
- **Scope**: bounded grid (pool multiplier {3,4,5}, traversal depth {1,2},
  learned-weights {on,off}, expansion {on,off}); `tuneRecall(config,
  dataset, {grid?})` evaluates via `runRecallBenchmark`, best MRR with
  stable tie-break, persists `Brain/search/tuning.json` (schema, chosen,
  evaluated grid scores, dataset hash, evaluated_at);
  `loadTunedParameters(vault)` re-validates against bounds, fail-soft to
  defaults; `search()` consults tuned params only when
  `search.self_tuning` config / `OSB_SELF_TUNING=1`; reset = delete file.
- **Acceptance**: tuning deterministic (same dataset -> same choice);
  out-of-bounds tuning.json ignored; opt-out leaves search byte-identical;
  tuned pool multiplier observably changes candidate pool width.
- **Depends on**: Task 5

### Task 11: benchmark + tune CLI verbs
- **Files**: `src/cli/brain/verbs/benchmark.ts`, `src/cli/brain/verbs/tune.ts`
  (new) + 5-place registrations, `src/cli/brain/verbs/search.ts`
  (`--expand` flag), `tests/cli/brain-benchmark.test.ts`,
  `tests/cli/brain-tune.test.ts` (new)
- **Scope**: `brain benchmark run --dataset <path> [--k N] [--expand]
  [--json]` (emits `recall_benchmark` metric); `brain tune run --dataset
  <path>`, `status`, `reset` (emits `self_tuning` metric on run);
  `brain search --expand`.
- **Acceptance**: CLI benchmark on fixture dataset prints/JSONs scores +
  metric line; tune run -> status -> reset lifecycle; search --expand
  returns results.
- **Depends on**: Task 1, Task 5, Task 10

### Task 12: MCP tools
- **Files**: `src/mcp/brain-tools.ts`, `tests/mcp/mcp.test.ts`,
  `tests/mcp/link-recall-tools.test.ts` (new)
- **Scope**: `brain_links` (discover/list/accept/dismiss), `brain_clusters`
  (run/list), `brain_benchmark` (run), `brain_tune` (run/status/reset);
  previewBudget on each; descriptions <= 300 chars; param validation before
  environment checks; tool count pins 73 -> 77.
- **Acceptance**: tool registry pins updated; happy path + INVALID_PARAMS
  per tool; vault containment via shared resolveNotePath where paths
  appear.
- **Depends on**: Tasks 6, 8, 10

### Task 13: End-to-end integration test
- **Files**: `tests/e2e/link-recall-intelligence.integration.test.ts` (new)
- **Scope**: one vault through the suite: alias note + wikilink resolves at
  materialization; bridge proposed between embedding-near unlinked notes,
  accepted pair lands `related:` and disappears from next discovery;
  communities materialize cluster notes; benchmark scores the vault;
  tuning persists and search honors it under the flag; every surface left
  one metric line in `Brain/metrics/`.
- **Acceptance**: the composed flow passes with the deterministic local
  embedding provider.
- **Depends on**: Tasks 1-12

### Task 14: Docs
- **Files**: `CHANGELOG.md` ([0.45.0]), `README.md`,
  `docs/cli-reference.md`, `docs/how-it-works.md`, `docs/metrics.md` (new -
  dashboard data contract: envelope, surfaces, payload fields, evolution
  rule)
- **Acceptance**: docs match shipped behavior; metrics contract documents
  every surface this release writes.
- **Depends on**: Tasks 1-13

## Implementation deviations

(appended during implementation when reality diverges from this plan)
