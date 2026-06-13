# Search & Recall Quality - retrieval transparency, trust, and evaluation

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain's retrieval core ranks well but is opaque and untunable at the
edges: callers get human-readable `reasons[]` strings but no structured score
components; a query with no genuinely relevant memory still returns weak noise;
hybrid search degrades to a single lane silently; recall hits carry no validity
signal (age, superseded, conflict) even though those signals exist in separate
passes; there is no per-call way to reinforce memories an agent just proved
useful; and retrieval quality is measured only by an internal hit@k/MRR test
with no MCP-accessible eval or answer-containment metric. This suite closes those
gaps as seven additive, opt-in, language-agnostic enhancements that ship in one
release.

## Scope

Seven atomic units, all in `src/core/search/` and `src/mcp/search-tools.ts`:

1. **score_breakdown (`explain`)** - structured per-result score components in
   `brain_search` output, gated behind an `explain` flag.
2. **relevance threshold + rerank** - opt-in score floor and second-pass rerank
   so an irrelevant query returns no match instead of weak noise.
3. **hybrid-degrade warning** - a warning when expected hybrid search silently
   falls back to a single lane.
4. **inline trust metadata** - computed-at-read-time age / superseded / conflict
   fields stamped on each recall hit.
5. **self-tuning reinforce** - opt-in `reinforce=[id,...]` that lifts proven
   memories via a plugin-side ledger before the top_k cut.
6. **answer-containment@k + reproducible corpus** - a new benchmark metric and a
   committed curated corpus with a CI guard.
7. **MCP eval suite** - the recall benchmark exposed over MCP with
   source-utilization / citation-depth dimensions and a `source_warnings_max`
   CI gate, plus read-only eval report/history resources.

## Out of scope

- Cross-encoder / neural reranking models (the `rerank` flag uses the existing
  deterministic signals; a model-backed reranker is a separate future task).
- Any stored ranking column or new SQLite migration for trust/score data - all
  enrichment stays read-time and never-stored.
- Owner/agent-scoped fact isolation, typed-edge relational retrieval, and the
  indexer-durability family (separate triage clusters).
- New natural-language word lists of any kind.

## Chosen approach

Adopt the consultant's **Variant 2 - unified read-time enrichment module in
core** (see `variants.md` for the full audit trail and the three variants
considered).

A single pure module `src/core/search/enrich.ts` is added as a sibling to the
proven `recall-hint.ts`. It owns the read-time, never-stored projections:
`score_breakdown`, inline trust metadata, and hybrid-degrade detection - each a
pure function over a ranker output that now carries every numeric component
first-class. Ranking-behaviour changes (threshold filter, reinforce re-rank)
extend the pure ranker / post-rank path behind explicit options and
`ResolvedRecallConfig` kill switches. The MCP surface only serializes the
enrichment and owns the two side-effecting pieces: the reinforce ledger
(`Brain/search/reinforce/`, the conflict-free one-file-per-signal pattern) and
the `run_eval` exposure. The benchmark gains the answer-containment metric in
place.

The byte-identical-when-flags-off guarantee holds because every new output field
is gated behind its opt-in flag (`explain`, `threshold`, `reinforce`,
`trust`) and the MCP serializer picks fields explicitly; a vault that opts into
nothing produces byte-identical results and ranks bit-identically.

## Design decisions

- **Ranker emits a structured per-layer breakdown** (refinement over the bare
  consultant recommendation): `BrainSearchResult` gains an always-present
  `breakdown` object carrying `keyword`, `semantic`, `entity`, `recency`, `link`,
  `activation`, `coAccess`, `sessionFocus`, and (when rrf) `rrf`. This removes the
  existing string-parse crutch in `feedback.ts` (`contributionsFromResult` parses
  `entity_match:` back out of a reason string) - it reads the structured field
  instead. `score_breakdown` is then a pure projection, not a re-parse. The field
  is core-internal; MCP only emits `score_breakdown` when `explain` is set.
- **Threshold composes before MMR diversity.** The relevance floor filters
  candidates after scoring but before the MMR rerank, so diversity is computed
  over the already-qualified set. `threshold` defaults to disabled (0); the
  default path is byte-identical. `rerank` triggers a deterministic second pass
  over the top candidates using the existing signals - no new model dependency.
- **Trust metadata is read-time, never stored**, mirroring `recall-hint.ts`. Age
  derives from document mtime; `superseded` from the bi-temporal `superseded_by`
  frontmatter already materialized into the links table; `conflict` from the
  existing `computeTruthStateWithConflicts` pass. Absent signals degrade to a
  neutral (untagged) state - no per-locale phrasing, just structural fields plus
  numbers.
- **Reinforce is an explicit per-call boost list, distinct from the feedback
  loop.** The feedback loop folds up/down verdicts into bounded learned per-layer
  weights; reinforce lifts caller-named ids (chunk/document/path) before the
  top_k cut via a small ledger that records which ids were marked useful.
  Surfaced-only frequency is never a positive signal (only an explicit reinforce
  mark is). Bounded, opt-in, resettable - same discipline as `feedback.ts`.
- **Hybrid-degrade detection is structural.** A degrade is "caller wanted both
  lanes but only one ran" - derived from `resolveSemanticPolicy` intent vs the
  actual `semanticAttempted` / lane-availability state already tracked in
  `search.ts`. The warning string is a single English template plus identifiers,
  consistent with the language-agnostic stance.
- **Eval dimensions reuse the benchmark runner.** `source-utilization` (fraction
  of expected sources surfaced) and `citation-depth` (rank depth of expected
  hits) are computed from the same `runRecallBenchmark` outputs;
  `answer-containment@k` checks whether an expected answer substring appears in
  the retrieved content, not just whether the path matched. The MCP `run_eval`
  tool wraps the runner read-only; the `source_warnings_max` gate is a threshold
  the CI test asserts.

## File changes

New files:
- `src/core/search/enrich.ts` - read-time enrichment: score_breakdown projection,
  trust metadata deriver, hybrid-degrade detector. Pure, no I/O.
- `src/core/search/reinforce.ts` - reinforce ledger (one-file-per-signal under
  `Brain/search/reinforce/`) + the bounded re-rank applied before top_k.
- `tests/core/search/enrich.test.ts`, `tests/core/search/reinforce.test.ts`,
  `tests/core/search/threshold.test.ts`, `tests/core/search/answer-containment.test.ts`,
  `tests/core/search/hybrid-degrade.test.ts`, `tests/mcp/eval-tools.test.ts` (and
  extensions to existing ranker/search/search-tools/benchmark test files).
- `docs/brainstorm/search-recall-quality/*` (this phase).

Modified files (expected):
- `src/core/search/ranker.ts` - emit the structured `breakdown` object.
- `src/core/search/types.ts` - `BrainSearchResult.breakdown`; `SearchOptions`
  (`explain`, `threshold`, `rerank`, `reinforce`, `trust`); `SearchOutcome`
  (degrade warnings already flow through `warnings[]`).
- `src/core/search/search.ts` - threshold filter before MMR, reinforce re-rank,
  hybrid-degrade detection wiring, trust/score_breakdown enrichment on results.
- `src/core/search/feedback.ts` - read the structured breakdown instead of
  re-parsing reason strings.
- `src/core/search/benchmark.ts` - answer-containment@k + source-utilization +
  citation-depth metrics.
- `src/mcp/search-tools.ts` - `explain` / `threshold` / `rerank` / `reinforce` /
  `trust` input schema; `score_breakdown` + `trust` output schema; reinforce
  ledger write at the surface.
- New MCP eval tool registration (`src/mcp/eval-tools.ts` or extend
  `search-tools.ts`) + `tools.ts` wiring + eval report/history resources.
- `README.md`, `CHANGELOG.md`, `docs/` search-design notes, version manifests.
- A committed benchmark corpus fixture + dataset under `tests/fixtures/` (or the
  existing recall-benchmark fixture location) for the CI guard.

## Risks and open questions

- **Public shape additivity.** Adding `breakdown` to `BrainSearchResult` is a
  core-internal change; verify no existing test asserts exact `BrainSearchResult`
  key sets that would break. Mitigation: the field is always present in core but
  never surfaced by MCP unless `explain` is set; assert byte-identical MCP output
  with flags off.
- **Reinforce id namespace.** Decide the id form callers pass (path vs
  documentId:chunkId). Resolve in implementation against how agents already
  reference results (`recall_feedback` uses `result_path`); prefer path for
  consistency.
- **answer-containment corpus.** The metric needs an `answer` field per query in
  the dataset; keep it optional so existing datasets stay valid (containment is
  computed only for queries that declare an answer).
- **Threshold semantics with rrf fusion.** RRF scores are not comparable to
  linear scores; the threshold must be applied against the final normalized
  `score` (already clamped to [0,1]) so it is meaningful in both fusion modes.
