# Hybrid Search and Recall Quality Suite - implementation plan

Five atomic units, one per commit, in dependency order on the same
`feat/search-recall-suite` branch. Each: failing test first, watch it fail,
minimal implementation, refactor green, commit.

## Task 1: Explainable recall (`why_retrieved`)

- **Files**: `src/core/search/types.ts` (add `reasons` to `BrainSearchResult`),
  `src/core/search/ranker.ts` (assemble `reasons` per result),
  `src/mcp/search-tools.ts` (surface `reasons`), `src/cli/search.ts` (render),
  `tests/core/search/ranker-reasons.test.ts`,
  `tests/mcp/brain-search-reasons.test.ts`.
- **Acceptance**: ranker emits one `"<layer>: <value>"` entry per layer that
  fired (keyword/semantic/link/recency/tier); zero-valued layers omitted;
  ordering stable; MCP `brain_search` output includes `reasons`. A
  keyword-only hit lists exactly `fts5_bm25`; a hybrid hit lists keyword and
  semantic; a recent linked hit also lists link and recency.
- **Depends on**: none.

## Task 2: MMR diversity rerank

- **Files**: `src/core/search/mmr.ts` (new pure module),
  `src/core/search/types.ts` (config `mmrLambda` + `SearchOptions` opt-out),
  `src/core/search/search.ts` (wire after rank), `src/core/search/index.ts`
  (resolve config default), `tests/core/search/mmr.test.ts`,
  search-integration fixture updates.
- **Acceptance**: `mmrRerank` with `lambda < 1` demotes a near-duplicate of an
  already-selected result below a less-similar but slightly-lower-relevance
  result; `lambda == 1` is identity; fewer than two results is identity;
  deterministic token-set similarity; `reasons` gains an `mmr_rank` note when
  MMR moved a result. Bounded to a fixed pool size.
- **Depends on**: Task 1 (reasons surface).

## Task 3: Link-graph traversal during recall

- **Files**: `src/core/search/traversal.ts` (new pure module),
  `src/core/search/store.ts` (`outboundLinkTargets`),
  `src/core/search/search.ts` (expand + merge before MMR),
  `src/core/search/types.ts` (config `maxHops`, `hopDecay`,
  `maxExpansionPerHit`), `tests/core/search/traversal.test.ts`,
  `tests/core/search/store-outbound-links.test.ts`,
  search-integration test.
- **Acceptance**: a doc linked from a top hit appears in results scored as
  `parent_score * hop_decay`, capped at `max_expansion_per_hit` per hit and
  `max_hops` depth; an already-present doc keeps its higher score (dedup); a
  result added by traversal carries a `link_traversal: <hops>` reason;
  `max_hops == 0` is a no-op (bit-identical).
- **Depends on**: Task 1.

## Task 4: Entity-boosted retrieval

- **Files**: `src/core/search/entities.ts` (new pure extractor + normaliser),
  `src/core/search/schema.ts` (migration v2: `chunk_entities` table; bump
  `LATEST_SCHEMA_VERSION`), `src/core/search/store.ts` (`replaceEntities`,
  `chunkEntityMatches`), `src/core/search/indexer.ts` (extract + store per
  chunk), `src/core/search/ranker.ts` (optional entity-match map -> capped
  boost + reason), `src/core/search/search.ts` (extract query entities, fetch
  matches), `tests/core/search/entities.test.ts`,
  `tests/core/search/ranker-entity-boost.test.ts`,
  `tests/core/search/store-entities.test.ts`,
  `tests/core/search/schema-migration-v2.test.ts`.
- **Acceptance**: extractor pulls wikilink targets, quoted spans, and
  Unicode-uppercase / CamelCase / ALLCAPS runs from mixed-script text with no
  language word list; a result whose entities overlap the query entities gets
  a capped boost and an `entity_match: N` reason; an empty `chunk_entities`
  table yields zero boost (bit-identical); migration v2 creates the table and
  a v1 DB upgrades cleanly.
- **Depends on**: Task 1; shares migration v2 with Task 5.

## Task 5: Header-anchored chunking

- **Files**: `src/core/search/heading-path.ts` (or fold into `chunker.ts`),
  `src/core/search/chunker.ts` (emit `headingPath` per chunk),
  `src/core/search/schema.ts` (migration v2: `chunks.heading_path` column +
  rebuilt two-column `chunk_fts` + triggers), `src/core/search/store.ts`
  (write heading_path; two-column FTS query + bm25 weights),
  `src/core/search/indexer.ts` (persist heading_path), `src/core/search/fts.ts`
  (column-aware query if needed),
  `tests/core/search/chunker-heading-path.test.ts`,
  `tests/core/search/heading-anchored-recall.test.ts`,
  migration test extended.
- **Acceptance**: a chunk split off from its section carries the ancestor
  heading breadcrumb (e.g. `"Parent > Child"`); a query matching only the
  heading recalls the chunk via the heading FTS column; display `content` is
  unchanged (breadcrumb never appears in returned content); heading bm25
  weight is lower than content; empty heading_path (pre-reindex) is
  bit-identical.
- **Depends on**: shares migration v2 with Task 4.

## Cross-cutting

- Migration v2 is authored once (Task 4 lands the table; Task 5 extends the
  same migration version with the column + FTS rebuild) so a single
  `LATEST_SCHEMA_VERSION = 2` covers both. Order the commits so the migration
  is internally consistent at each commit.
- After all five: full `bun test`, `bun run typecheck`, lint,
  `bun run sync-version:check`, and a live `o2b search` smoke test on a
  scratch vault (index -> query -> confirm `reasons`, diversified order,
  traversal expansion, entity boost, heading recall).
