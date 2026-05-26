# Hybrid Search and Recall Quality Suite - complete and introspect the retrieval layer

**Status:** draft
**Author:** claude-vps-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain search fuses FTS5 keyword scoring and optional semantic
vectors, but the hybrid layer is incomplete and opaque. There is no
diversification (near-identical paraphrases flood the top-K), no walk of the
link graph at query time (densely linked context one hop away is missed), no
proper-noun signal (entity matches are not distinguished from keyword
matches), no recall anchor for mid-document chunks (a chunk that splits off
from its section loses the heading context), and no per-result explanation of
why a hit ranked where it did. Each gap is something every memory competitor
already addresses; together they are the core value proposition of the
product.

## Scope

Five atomic units shipped in one pull request, separate commits, in this
order (each builds on the introspection surface of the first):

- **F1 - Explainable recall (`why_retrieved`).** Every result carries a
  `reasons: ReadonlyArray<string>` listing each scoring layer that
  contributed. Pure exposure of values `rankResults` already computes.
- **F2 - MMR diversity rerank.** Maximal Marginal Relevance over the fused
  top pool so near-identical results do not crowd out complementary ones.
  Single tunable `lambda`. Deterministic lexical similarity (no embedding
  round-trip).
- **F3 - Link-graph traversal during recall.** Two-stage retrieve-then-walk:
  follow outbound wikilinks from top hits, score expansion docs as
  `parent_score * decay^hop`, merge with dedup. Bounded by `max_hops`,
  `hop_decay`, `max_expansion_per_hit`.
- **F4 - Entity-boosted retrieval.** A third hybrid signal. Deterministic,
  language-agnostic entity extraction at index time into a parallel table;
  query-time entity overlap adds a capped boost. No NER dependency, no
  per-language word lists.
- **F5 - Header-anchored chunking.** Each chunk carries the ancestor heading
  breadcrumb in a dedicated, searchable FTS column so mid-document chunks
  retain topical anchors - without polluting the stored display content.

## Out of scope

- Embedding-based MMR similarity (lexical similarity ships now; a vector
  variant can follow if measured to help).
- Pluggable external vector backends (Qdrant/Milvus/etc.) - separate task.
- Full conversation/session transcript indexing - F5 addresses the
  long-document recall problem in the existing chunker, which is the
  OSB-shaped form of the upstream "header injection" idea.
- Any change to the meaning of existing `BrainSearchResult` fields.

## Chosen approach

Variant 1 - incremental in-place extension. `rankResults` stays the single
scoring authority and gains: a per-result `reasons` array assembled from the
layer values it already computes, plus an optional entity-boost component.
MMR and traversal land as new pure modules (`mmr.ts`, `traversal.ts`) invoked
sequentially by `search.ts` after ranking. Entity storage and heading
breadcrumbs each get backing in a single schema migration (v1 -> v2). I/O stays
confined to `store.ts`; the new ranking math stays pure and unit-testable.

Pipeline after the change (`search.ts`):

```text
fts candidates -> semantic candidates -> hydrate
  -> rankResults (keyword + semantic + link + recency + tier + ENTITY)   [F1 reasons, F4 boost]
  -> traversal expand (outbound links, decayed) -> re-merge + re-sort     [F3]
  -> MMR diversify the pool                                               [F2]
  -> property filter -> slice to limit
```

Graceful degradation is per-feature and explicit:

- F1: additive field; always present.
- F2: no-op when fewer than two results or `lambda == 1`.
- F3: no-op when `max_hops == 0` or a doc has no resolved outbound links.
- F4: zero boost when `chunk_entities` is empty (pre-reindex) - bit-identical
  to today.
- F5: empty `heading_path` column (pre-reindex) contributes nothing to bm25 -
  bit-identical to today.

## Design decisions

- **`why_retrieved` is built in the ranker, not bolted on in `search.ts`.**
  The ranker is the only place that holds every component value; assembling
  the array there keeps a single source of truth and falls out for free.
  Format `"<layer>: <fixed-precision value>"`, one entry per layer that
  actually fired (zero-valued layers omitted to keep the array meaningful).
- **MMR similarity is lexical (token-set), not vector.** A deterministic
  token-set cosine over chunk content catches the near-duplicate paraphrases
  MMR targets, works uniformly whether or not semantic is enabled, needs no
  vector retrieval, and preserves the Syncthing determinism contract. The
  relevance term reuses the already-computed fused `score`.
- **MMR and traversal are enabled by default but fully tunable.** Value to the
  operator is the priority; both are bounded and deterministic. `lambda = 0.7`,
  `max_hops = 1`, `hop_decay = 0.5`, `max_expansion_per_hit = 3`. Each can be
  turned off via config (`lambda = 1`, `max_hops = 0`). The pure `rankResults`
  unit tests are unaffected because the new phases live in `search.ts`;
  affected search-integration fixtures are updated as part of the change since
  the new behaviour is intentional.
- **Entity extraction is structural, not linguistic.** Candidates come from
  wikilink targets, quoted spans, and Unicode uppercase-initial / CamelCase /
  ALLCAPS token runs. Normalisation is lowercase + trim. No human-language
  phrase or word list appears anywhere, satisfying the project constraint and
  keeping extraction identical across locales.
- **One schema migration (v2) backs F4 and F5.** It adds the `chunk_entities`
  table, adds a `heading_path` column to `chunks`, and rebuilds `chunk_fts` as
  a two-column external-content FTS (`content`, `heading_path`) with refreshed
  triggers. `LATEST_SCHEMA_VERSION` becomes 2; a newer-than-supported DB still
  raises `SCHEMA_MISMATCH`. Both features need a reindex to populate; until
  then their columns/tables are empty and ranking is unchanged.
- **bm25 column weighting keeps content dominant.** The heading column gets a
  smaller bm25 weight than content so a breadcrumb match nudges recall without
  overpowering a body match.

## File changes

New:

- `src/core/search/mmr.ts` - pure `mmrRerank(results, opts)`.
- `src/core/search/traversal.ts` - pure expansion/scoring given outbound map.
- `src/core/search/entities.ts` - pure `extractEntities(text)` + normaliser.
- `src/core/search/heading-path.ts` - pure breadcrumb builder over heading
  blocks (or folded into `chunker.ts` if cleaner).
- Test files under `tests/core/search/` for each new module, plus integration
  tests in the existing search/indexer/chunker suites.

Modified:

- `src/core/search/types.ts` - add `reasons` to `BrainSearchResult`; add
  config fields (`mmrLambda`, `maxHops`, `hopDecay`, `maxExpansionPerHit`,
  entity/heading bm25 weights) to `ResolvedSearchConfig`; matching
  `SearchOptions` opt-outs.
- `src/core/search/ranker.ts` - emit `reasons`; accept optional entity-match
  map and add a capped entity boost.
- `src/core/search/search.ts` - wire traversal + MMR phases; fetch entity
  matches and outbound links from the store.
- `src/core/search/store.ts` - `outboundLinkTargets`, `chunkEntityMatches`,
  `replaceEntities`; heading_path read/write; two-column FTS queries.
- `src/core/search/schema.ts` - migration v2 (`chunk_entities`,
  `chunks.heading_path`, rebuilt `chunk_fts` + triggers); bump
  `LATEST_SCHEMA_VERSION`.
- `src/core/search/chunker.ts` - emit `headingPath` per chunk.
- `src/core/search/indexer.ts` - persist heading_path; extract + store
  entities per chunk.
- `src/mcp/search-tools.ts` - surface `reasons` in `brain_search` output.
- `src/cli/search.ts` - render `reasons` in CLI output.
- `README.md`, `CHANGELOG.md`, affected `docs/`.

## Risks and open questions

- **FTS rebuild correctness.** Migrating an external-content FTS to two
  columns is delicate; the migration must drop/recreate the virtual table and
  triggers atomically and a reindex must repopulate. Mitigation: dedicated
  migration test that opens a v1 fixture DB, migrates, and asserts both
  columns query correctly; assert pre-reindex bit-identical ranking.
- **Default-on MMR/traversal changing existing search-integration
  expectations.** Accepted and intentional; fixtures updated under TDD. Pure
  ranker/chunker unit tests stay green.
- **Traversal hydration cost.** Expansion hydrates a representative chunk per
  linked doc; capped by `max_expansion_per_hit` and applied only to the top
  hits so response time stays bounded.
- **Entity precision.** Structural extraction is recall-oriented and may admit
  noise (e.g. sentence-initial capitalised words). Mitigation: cap the entity
  boost low and require multi-character / multi-token entities; the boost can
  only reorder within an already-relevant set, never inject unrelated docs.
