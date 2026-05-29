# Recall & Ranking Suite - implementation plan

Seven atomic units (eight features), one feature branch (`feat/recall-ranking-suite`),
separate conventional commits, TDD throughout. Order respects dependencies: pure
isolated change first, then the shared `QueryPlan` seam, then features that build on it,
then the budget primitive and its consumers.

## Tasks

### Task 1: Weibull recency decay (F1)
- **Files**: `src/core/search/recency.ts` (new, pure `weibullDecay`), `tests/core/search/recency.test.ts` (new), `src/core/search/ranker.ts` (swap `recencyBoost`), `src/core/search/types.ts` + `index.ts` (config: `recencyShape`, `recencyScale`, `recencyAmplitude` + DEFAULTS + validation), affected ranker test fixtures.
- **Acceptance**: `weibullDecay` unit tests cover the curve shape and bounds; default params keep ranker output within tolerance of the prior step function on fixtures; injectable `nowMs` keeps it deterministic. `bun test tests/core/search/recency.test.ts` green.
- **Depends on**: none.

### Task 2: QueryPlan + query-intent classification (F2)
- **Files**: `src/core/search/query-plan.ts` (new: `buildQueryPlan` -> `{ intent, weightProfile, expandedTerms: [], planHash }`), `tests/core/search/query-plan.test.ts` (new), `src/core/search/ranker.ts` (accept optional `weightProfile` multipliers; neutral default = bit-identical), `src/core/search/search.ts` (build plan, thread weightProfile), `types.ts`/`index.ts` (intent enable flag).
- **Acceptance**: structural inputs (quoted phrase, entity share, wildcard, wikilink, digits, length) map to documented intents/profiles with zero language tables; neutral profile asserts bit-identical ranking vs pre-change fixtures; plan is pure (no I/O). Tests green.
- **Depends on**: Task 1 (ranker already touched; keep changes additive).

### Task 3: Synonym / query expansion (F3)
- **Files**: `src/core/search/synonyms.ts` (new, pure expansion given a term-source), `tests/core/search/synonyms.test.ts` (new), `src/core/search/store.ts` (co-occurrence accessor; optional embedding-neighbour terms), `src/core/search/query-plan.ts` (populate `expandedTerms`), `src/core/search/search.ts` (augment FTS candidates with expanded terms).
- **Acceptance**: expansion is language-agnostic (vault co-occurrence / embedding neighbours only); empty source -> identical candidate set (no-op test); quoted exact-phrase query suppresses expansion; expansion-term count capped. Tests green.
- **Depends on**: Task 2 (QueryPlan).

### Task 4: Shared recall-budget primitive + per-memory char cap (F4)
- **Files**: `src/core/brain/recall-budget.ts` (new, pure `applyBudget`), `tests/core/brain/recall-budget.test.ts` (new), `src/core/brain/context-pack.ts` (consume primitive; `maxCharsPerEntry`), `src/mcp/brain-tools.ts` (`brain_context_pack` arg `max_chars_per_memory`).
- **Acceptance**: per-entry trimming is score-ordered; zero/unset cap = today's output (no-op test); oversized entry trimmed without dropping lower-scored entries below budget. Tests green.
- **Depends on**: none (can run after Task 1; independent of the QueryPlan chain).

### Task 5: Total recall char cap (F5)
- **Files**: `src/core/brain/recall-budget.ts` (extend with `maxTotalChars`), `tests/core/brain/recall-budget.test.ts` (extend), `src/core/brain/context-pack.ts` (wire total cap), `src/mcp/brain-tools.ts` (`brain_context_pack` arg `max_total_chars`).
- **Acceptance**: total cap discards lowest-scored overflow after per-entry trim; interaction of both caps + existing `max_tokens` covered; unset = no-op. Tests green.
- **Depends on**: Task 4.

### Task 6: Persistent query cache + corpus-generation invalidation (F6)
- **Files**: `src/core/search/corpus-generation.ts` (new, pure fingerprint), `tests/core/search/corpus-generation.test.ts` (new), `src/core/search/query-cache.ts` (new: get/put/sweep via Store), `tests/core/search/query-cache.test.ts` (new), `src/core/search/schema.ts` (migration v4 `query_cache`; bump `LATEST_SCHEMA_VERSION` to 4), `tests/core/search/schema-migration.test.ts` (v3->v4), `src/core/search/store.ts` (cache table I/O + generation accessor), `src/core/search/search.ts` (wrap with cache), `types.ts`/`index.ts` (cache enable + TTL config).
- **Acceptance**: cache hit deep-equals fresh compute; embedding model/dimension change AND a content reindex (bumped `index_revision`) both produce a generation mismatch that is never served and is swept; TTL expiry covered; migration test opens a v3 fixture, migrates, asserts `query_cache` present and prior data intact; newer-than-latest DB still raises `SCHEMA_MISMATCH`; cache disabled = uncached path identical. Tests green.
- **Note**: `index_revision` is a monotonic counter bumped by the indexer on real mutations (added+updated+deleted > 0); folded into the corpus-generation fingerprint so content reindex invalidates the cache.
- **Depends on**: Task 2 (planHash is part of the cache key).

### Task 7: brain_pre_compress_pack MCP tool (F7)
- **Files**: `src/core/brain/pre-compress-pack.ts` (new builder), `tests/core/brain/pre-compress-pack.test.ts` (new), `src/mcp/brain-tools.ts` (register `brain_pre_compress_pack`), `src/mcp/instructions.ts` (document tool), `tests/mcp/*` (tool registration + budget round-trip).
- **Acceptance**: returns top-K confirmed preferences by confidence/recency + head of `active.md`, rendered as a system-prompt addendum under the shared budget; read-only; honours ToolScope; empty brain -> empty-but-valid bundle. Tests green.
- **Depends on**: Task 4, Task 5 (budget primitive).

## End state

All seven units' tests pass; `bun run validate` (typecheck + lint + test) green;
`bun run sync-version:check` consistent after the Phase 9 version bump. Diff is
feature-complete per `design.md`. Each feature individually disable-able and a
documented no-op when its input is absent.
