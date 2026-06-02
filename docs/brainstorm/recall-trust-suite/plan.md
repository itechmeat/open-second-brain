# Recall Trust Suite — implementation plan

Implementation order encodes the Variant 3 dependency: the coverage engine
lands inside Task 4 (Feature C) and Task 5 (Feature E) consumes it. Tasks 1-3
are independent of each other. Each task is one atomic conventional commit,
TDD (failing tests first), formatter + linter green before the commit.

## Tasks

### Task 1: Relation-aware recall (Feature A, t_d8571bf0)

- **Files**: new `src/core/search/relation-polarity.ts`,
  new `tests/core/search/relation-polarity.test.ts`;
  modify `src/core/search/store.ts` (`typedRelationEdgesForDocuments`),
  `src/core/search/search.ts` (polarity pass on the assembled pool before the
  final slice; config fingerprint), `src/core/search/types.ts`
  (`SearchOptions.includeSuperseded`, `ResolvedRecallConfig.relationPolarityEnabled`),
  `src/core/search/index.ts` (config key `search_relation_polarity_enabled`),
  `src/cli/search.ts` (`--include-superseded`),
  `src/mcp/search-tools.ts` (`include_superseded`),
  `tests/core/search/search.test.ts` (integration).
- **Acceptance**: a query matching a superseded page surfaces the successor
  above the predecessor; predecessor carries `superseded_by: <target>` reason;
  `--include-superseded` restores undemoted order; `contradicts` adds a
  warning reason without a score change; positive relations add a bounded
  boost between co-retrieved candidates; unresolved targets are inert; a vault
  with no typed relations ranks bit-identically.
- **Depends on**: none.

### Task 2: Retrieval feedback loop (Feature B, t_68e1b774)

- **Files**: new `src/core/search/feedback.ts`,
  new `tests/core/search/feedback.test.ts`;
  modify `src/core/search/search.ts` (learned multipliers into ranking;
  learned-weights hash into cache fingerprint), `src/core/search/types.ts`
  (`ResolvedRecallConfig.learnedWeightsEnabled`), `src/core/search/index.ts`
  (config key `search_learned_weights_enabled`), `src/cli/search.ts`
  (verbs `feedback`, `weights` incl. `--reset`), `src/mcp/search-tools.ts`
  (new tool `brain_recall_feedback`),
  `tests/core/search/search.test.ts`, MCP surface test.
- **Acceptance**: recording feedback creates one event file under
  `Brain/search/feedback/`; the learned-weight fold is deterministic, bounded
  to [0.8, 1.2], and replayable from events; ranking shifts only when the
  config opt-in is on; affected results carry a `learned_weights:` reason;
  `o2b search weights` shows base + learned + counts; `--reset` removes the
  derived weights but keeps events.
- **Depends on**: none.

### Task 3: Time-aware recall (Feature D, t_9dfbaa76)

- **Files**: new `src/core/search/time-range.ts`,
  new `tests/core/search/time-range.test.ts`;
  modify `src/core/search/search.ts` (mtime filter before ranking; cache
  bypass when a range is active), `src/core/search/types.ts`
  (`SearchOptions.since/until`), `src/cli/search.ts` (`--since`, `--until`),
  `src/mcp/search-tools.ts` (`since`, `until`),
  `tests/core/search/search.test.ts`.
- **Acceptance**: ISO dates, `yesterday` / `today` / `last week` /
  `last month`, and `24h` / `7d` / `2w` shorthand all resolve deterministically
  against an injected now; out-of-range candidates never surface; invalid
  input raises `INVALID_INPUT`; time-filtered queries bypass the query cache.
- **Depends on**: none.

### Task 4: Verified multi-record recall (Feature C, t_407a3477)

- **Files**: new `src/core/search/coverage.ts`,
  new `tests/core/search/coverage.test.ts`;
  modify `src/core/search/store.ts` (`documentFrequency`, `documentCount`),
  `src/core/search/evidence-pack.ts` (optional fields
  `idfWeightedCoverage`, `rareTerms`, `uncoveredRareTerms`, `unionRecords`;
  rare-term abstention; delegate term math to `coverage.ts`),
  `src/core/search/search.ts` (union fetch in evidence-pack mode),
  `tests/core/search/evidence-pack.test.ts`.
- **Acceptance**: per-token union gathers bounded extra records for uncovered
  significant terms; coverage is IDF-weighted; an uncovered rare term
  populates `abstention`; legacy pack fields are byte-identical for callers
  that ignore the new optional fields; non-evidence-pack searches are
  untouched.
- **Depends on**: none (lands the coverage engine).

### Task 5: Search-completeness guard (Feature E, t_854b8e5f)

- **Files**: modify `src/core/search/coverage.ts` (verdict + false-absence),
  `src/core/search/evidence-pack.ts` (`completeness` field),
  new `tests/core/search/completeness.test.ts`;
  modify `tests/core/search/evidence-pack.test.ts`.
- **Acceptance**: pack carries `completeness` with verdict
  `complete` / `partial` / `sparse` from IDF-weighted coverage thresholds
  (0.8 / 0.4); every uncovered term present in the corpus is listed as
  `uncovered_but_present_in_corpus` (false-absence guard), including the
  zero-results case.
- **Depends on**: Task 4.

### Task 6: Docs + release prep (phase 5 of the playbook)

- **Files**: `README.md`, `CHANGELOG.md`, `docs/cli-reference.md`,
  `docs/mcp.md`, `package.json` (version bump), version-synced files via
  `bun run sync-version`.
- **Acceptance**: one CHANGELOG version bundling the five features;
  `bun run sync-version:check` passes; `bun run validate` green.
- **Depends on**: Tasks 1-5.
