# Search & Recall Quality - implementation plan

Seven atomic units, implemented one-by-one via TDD on `feat/search-recall-quality`,
each its own conventional commit. Format + lint must pass before every commit.
Tasks are ordered so each builds on the prior; the byte-identical-when-flags-off
guarantee is re-asserted by the existing suite after every commit.

## Tasks

### Task 1: Structured score breakdown + `explain`
- **Files**: `src/core/search/ranker.ts`, `src/core/search/types.ts`,
  `src/core/search/enrich.ts` (new), `src/core/search/search.ts`,
  `src/core/search/feedback.ts`, `src/mcp/search-tools.ts`,
  `tests/core/search/enrich.test.ts` (new), `tests/core/search/ranker*.test.ts`,
  `tests/core/search/feedback.test.ts`, `tests/mcp/*search*`.
- **Acceptance**: ranker emits an always-present `breakdown` object; `enrich.ts`
  projects it into a `score_breakdown`; `brain_search` returns `score_breakdown`
  only when `explain: true`; output is byte-identical when `explain` is absent;
  `feedback.ts` reads the structured field instead of re-parsing reason strings;
  all existing tests stay green.
- **Depends on**: none (foundation).

### Task 2: Hybrid-degrade warning
- **Files**: `src/core/search/search.ts`, `src/core/search/enrich.ts`,
  `tests/core/search/hybrid-degrade.test.ts` (new), `tests/core/search/search.test.ts`.
- **Acceptance**: when the caller's resolved policy wants both lanes but only one
  ran (vec/key unavailable, or keyword-only fallback), a single structural
  warning is appended to `warnings[]`; no warning when hybrid genuinely ran or
  when the caller explicitly asked for one lane; language-agnostic template.
- **Depends on**: Task 1 (shares `enrich.ts`).

### Task 3: Inline trust metadata on hits
- **Files**: `src/core/search/enrich.ts`, `src/core/search/types.ts`,
  `src/core/search/search.ts`, `src/mcp/search-tools.ts`,
  `tests/core/search/enrich.test.ts`, `tests/core/search/search.test.ts`,
  `tests/mcp/*search*`.
- **Acceptance**: with `trust: true`, each hit carries computed-at-read-time
  `age_days`, `superseded`, and `conflict` fields derived from mtime, the
  `superseded_by` links, and `computeTruthStateWithConflicts`; never stored;
  absent signals degrade to a neutral untagged state; off by default and
  byte-identical when absent.
- **Depends on**: Task 1.

### Task 4: Relevance threshold + rerank
- **Files**: `src/core/search/search.ts`, `src/core/search/types.ts`,
  `src/core/search/mmr.ts` (compose), `src/mcp/search-tools.ts`,
  `tests/core/search/threshold.test.ts` (new), `tests/core/search/mmr.test.ts`,
  `tests/mcp/*search*`.
- **Acceptance**: `threshold` (default 0/disabled) filters results whose final
  normalized `score` is below the floor, applied before the MMR diversity pass;
  a query with no qualifying hit returns an empty result set (no weak noise);
  `rerank` runs a deterministic second pass over top candidates using existing
  signals; default path byte-identical.
- **Depends on**: Task 1.

### Task 5: Self-tuning reinforce
- **Files**: `src/core/search/reinforce.ts` (new), `src/core/search/search.ts`,
  `src/core/search/types.ts`, `src/mcp/search-tools.ts`,
  `tests/core/search/reinforce.test.ts` (new), `tests/mcp/*search*`.
- **Acceptance**: `reinforce: [path,...]` lifts the named results before the
  top_k cut via a bounded, resettable ledger under `Brain/search/reinforce/`
  (one-file-per-signal); surfaced-only frequency never boosts; the ledger write
  happens at the MCP surface, the re-rank is pure; off by default and
  byte-identical when absent.
- **Depends on**: Task 1, Task 4 (re-rank ordering interacts with threshold).

### Task 6: Answer-containment@k + reproducible corpus
- **Files**: `src/core/search/benchmark.ts`,
  `tests/core/search/answer-containment.test.ts` (new),
  `tests/core/search/recall-benchmark.test.ts`, benchmark corpus fixture + dataset.
- **Acceptance**: `RecallBenchmarkQuery` gains an optional `answer` field;
  `runRecallBenchmark` reports `answerContainmentAtK` computed only for queries
  that declare an answer; a committed curated corpus + dataset run under the CI
  test with a pinned floor; existing hit@k/MRR behaviour unchanged for datasets
  without `answer`.
- **Depends on**: none (benchmark is independent of the search-options work).

### Task 7: MCP eval suite
- **Files**: `src/mcp/eval-tools.ts` (new) or extend `src/mcp/search-tools.ts`,
  `src/mcp/tools.ts`, `src/core/search/benchmark.ts` (source-utilization +
  citation-depth), `tests/mcp/eval-tools.test.ts` (new),
  `tests/core/search/benchmark.test.ts`.
- **Acceptance**: a read-only `brain_eval` (`run_eval`-style) MCP tool runs the
  benchmark and returns hit@k / MRR / answer-containment@k / source-utilization /
  citation-depth; a `source_warnings_max` gate is asserted by CI; eval
  report/history are exposed read-only; no API key required for the fast path.
- **Depends on**: Task 6 (consumes the extended benchmark).

## Cross-cutting acceptance (after every commit)
- `bun test` green, `bun run typecheck` clean, `bun run lint` clean.
- `bun run scripts/sync-version.ts --check` (version sync) unaffected during
  implementation; the single version bump happens at release (Phase 9).
- No natural-language word lists introduced anywhere.
- `brain_search` output byte-identical to `main` for a call that sets none of the
  new flags.
