# Recall & Ranking Suite - sharpen the retrieval, recall-budget, and pre-injection layers

**Status:** draft
**Author:** claude-vps-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain's retrieval layer fuses FTS5, semantic vectors, MMR diversity,
link traversal, entity boost, and tier weighting (v0.13.0), but recency is a
hardcoded step function, every query is treated identically regardless of what it
is asking for, identical queries are recomputed from scratch, and a query whose
wording differs from the stored wording under-recalls. Separately, the
context-injection surface (`brain_context_pack`) budgets only by token count - a
single oversized preference can still crowd out the rest - and there is no
read-only bundle an external runtime can inject just before a compression event.
Each gap is something a memory product is expected to address; together they are
the recall-quality and context-economy core of the product.

## Scope

Eight features across seven atomic units, one pull request, separate commits, in
dependency order. All are individually disable-able and bounded.

- **F1 - Weibull recency decay.** Replace the stepwise `recencyBoost` in
  `ranker.ts` with a configurable Weibull curve (shape + scale). Default
  parameters approximate today's curve; bounded and deterministic (injectable
  `nowMs`).
- **F2 - Query-intent classification.** A pure `QueryPlan` stage classifies the
  query into a structural intent and emits a `weightProfile` that nudges the
  keyword/semantic/entity/recency mix. Structural signals only - no language
  tables.
- **F3 - Synonym / query expansion.** `QueryPlan.expandedTerms` augment the FTS
  candidate set, language-agnostically (vault-derived term co-occurrence; optional
  embedding-neighbour expansion when the embedding provider is configured).
  No-op (bit-identical) when no expansion signal exists.
- **F4 - Per-memory character cap.** A shared `recall-budget` primitive trims
  individual oversized entries by score order before they consume the bundle.
  Consumed by `context-pack.ts`.
- **F5 - Total recall character cap.** A second budget axis alongside `max_tokens`,
  discarding lowest-scored overflow. Same shared primitive.
- **F6 - Persistent query cache + corpus-generation invalidation.** A SQLite-backed
  `query_cache` table (additive migration v4) keyed by
  `(normalizedQuery, scope, planHash, corpusGeneration)` with a TTL. The
  `corpusGeneration` fingerprint (embedding model + dimension + schema version +
  monotonic index revision) is derived from `index_state`; rows whose generation
  differs from current are never served and are swept. A cache hit is byte-identical
  to a fresh compute. The index-revision component is what makes a content reindex
  (which changes the index DB `search()` reads from, but not the embedding
  model/dimension/schema) invalidate the cache.
- **F7 - `brain_pre_compress_pack` MCP tool.** Read-only tool returning a budgeted
  bundle of top-K highest-confidence preferences plus the head of `active.md`,
  formatted as a system-prompt addendum. Reuses the F4/F5 budget primitive. OSB
  ships only the tool; host-runtime wiring is an out-of-scope recipe.

(F6 bundles the cache and its corpus-generation invalidation gate into one atomic
unit because the gate is meaningless without the cache it guards - the "smaller
first cut" the source task calls for.)

## Out of scope

- In-memory-only caching (rejected: the CLI runs a fresh process per call).
- Per-page corpus-generation hashing (the gbrain full model); generation is
  tracked at embedding-model/dimension/schema granularity - the documented
  smaller first cut.
- LLM-based intent classification or LLM query rewriting (non-deterministic,
  language-coupled).
- Any per-language keyword / synonym / stopword list (forbidden by the
  language-agnostic invariant).
- Host-runtime (Hermes) pre-compress wiring - shipped separately as a recipe.
- Changing the meaning of existing `BrainSearchResult` fields.

## Chosen approach

Variant 2 (dedicated query-analysis layer), per `variants.md`. A new pure module
`query-plan.ts` runs one structural pass over the query and returns
`QueryPlan { intent, weightProfile, expandedTerms, planHash }`. `search.ts`
consumes it: `expandedTerms` augment FTS candidates; `weightProfile` is threaded
into `rankResults` as per-query weight multipliers. Weibull recency stays a pure
config-driven curve inside `ranker.ts` (not routed through the plan). A persistent,
generation-gated `query_cache` wraps `search()`. A shared `recall-budget` primitive
backs both `context-pack.ts` and the new `brain_pre_compress_pack` tool.

Pipeline after the change (`search.ts`):

```text
buildQueryPlan(query)                                          [F2 intent, F3 terms, planHash]
  -> query-cache lookup (normQuery, scope, planHash, generation) -- hit? return  [F6]
  -> fts candidates (+ expandedTerms augmentation)             [F3]
  -> semantic candidates -> hydrate
  -> rankResults(... weightProfile, Weibull recency ...)       [F1, F2]
  -> traversal -> MMR -> property filter -> visibility -> slice (unchanged v0.13.0)
  -> query-cache store (with current generation, TTL)          [F6]
```

Graceful degradation, per feature:
- F1: defaults approximate the prior curve; a config flag can restore exact prior steps if needed. Pure, deterministic.
- F2: `weightProfile` defaults to neutral (all multipliers 1.0) for an unclassifiable query -> bit-identical ranking.
- F3: empty `expandedTerms` (no co-occurrence signal, no embeddings) -> identical candidate set.
- F4/F5: zero/unset caps -> no trimming (today's behaviour).
- F6: cache disabled by config, or empty on first query, or generation mismatch -> always falls through to a fresh compute that equals the uncached path.
- F7: additive new tool; no existing surface changes.

## Design decisions

- **`QueryPlan` is the single audit seam for the language-agnostic invariant.**
  Both intent classification and synonym expansion derive exclusively from
  structural signals computed once here: `extractEntities` (already structural),
  quoted-phrase spans, FTS wildcard/boolean operators, wikilink-shaped tokens,
  digit/date tokens, token count. No natural-language word list appears anywhere.
- **Intent is structural, not semantic.** Intents are derived from query shape
  (e.g. high entity share -> entity-leaning profile; a quoted exact phrase ->
  keyword-leaning, expansion suppressed; long natural-language run with no
  entities -> semantic/recency-leaning). The mapping is a small fixed table from
  structural features to weight multipliers - never from words to meaning.
- **Weibull stays pure and config-driven, outside the plan.** `recencyBoost(age)`
  becomes `weibullDecay(ageDays, shape, scale, amplitude)`; recency does not depend
  on the query, so threading it through `QueryPlan` would be artificial coupling.
- **Synonym expansion is vault-derived, never a bundled dictionary.** Primary
  source: co-occurrence statistics already implicit in the index (terms frequently
  sharing chunks). Optional: nearest-neighbour terms via the existing embedding
  provider when configured. Both are language-agnostic by construction and degrade
  to no-op without data.
- **The query cache is persistent and generation-gated.** New `query_cache` table
  (migration v4, additive, reindex-safe), columns include the serialized result,
  `corpus_generation`, and `created_at` for TTL. Lookups filter on the current
  generation, so an embedding-model/dimension/schema change silently invalidates
  the cache. A cache hit is asserted byte-identical to a fresh compute.
  `corpusGeneration` is a pure function of `(embedding_model, embedding_dimension,
  LATEST_SCHEMA_VERSION, index_revision)` read from `index_state`. `index_revision`
  is a monotonic counter the indexer bumps whenever it actually mutates the index
  (added + updated + deleted > 0), so a content reindex invalidates the cache even
  though the embedding model/dimension/schema are unchanged - `search()` reads only
  from the index DB, so the cache stays exactly as fresh as that DB.
- **One shared budget primitive.** `recall-budget.ts` exposes a pure
  `applyBudget(entries, { maxTokens?, maxCharsPerEntry?, maxTotalChars? })` that
  trims per-entry then enforces the total, discarding lowest-scored overflow.
  `context-pack.ts` and `brain_pre_compress_pack` both consume it - no duplicated
  trimming logic.
- **`brain_pre_compress_pack` reuses ranking + budget, adds no new storage.** It
  selects top-K confirmed preferences by confidence/recency, prepends the head of
  `active.md`, and renders a compact system-prompt addendum under the same budget
  primitive. Read-only; ToolScope consistent with other read tools.

## File changes

New:
- `src/core/search/query-plan.ts` - pure `buildQueryPlan(query)` -> `{ intent, weightProfile, expandedTerms, planHash }`.
- `src/core/search/recency.ts` - pure `weibullDecay(ageDays, opts)` (or folded into `ranker.ts` if cleaner).
- `src/core/search/synonyms.ts` - pure expansion given a co-occurrence/embedding-neighbour source.
- `src/core/search/query-cache.ts` - persistent cache get/put + generation gate + TTL sweep (I/O via Store).
- `src/core/search/corpus-generation.ts` - pure generation fingerprint from index_state values.
- `src/core/brain/recall-budget.ts` - shared pure budget primitive.
- `src/core/brain/pre-compress-pack.ts` - core builder for the pre-compress bundle.
- Test files under `tests/core/search/` and `tests/core/brain/` for each new module, plus integration tests in the search/context-pack suites.

Modified:
- `src/core/search/ranker.ts` - Weibull recency; accept per-query `weightProfile`.
- `src/core/search/types.ts` - `QueryPlan`, `weightProfile`, recall-config fields (weibull shape/scale/amplitude, intent toggle, expansion toggle, cache TTL/enable); `SearchOptions` opt-outs.
- `src/core/search/index.ts` - resolve + validate the new config fields and `DEFAULTS`.
- `src/core/search/search.ts` - build plan, augment candidates, thread weightProfile, wrap with cache.
- `src/core/search/store.ts` - `query_cache` read/write/sweep; `corpusGeneration` accessor; co-occurrence accessor for synonyms.
- `src/core/search/schema.ts` - migration v4 (`query_cache` table); bump `LATEST_SCHEMA_VERSION` to 4.
- `src/core/brain/context-pack.ts` - consume `recall-budget` (per-memory + total char caps).
- `src/mcp/brain-tools.ts` - `brain_context_pack` new cap args; register `brain_pre_compress_pack`.
- `src/mcp/instructions.ts` - document the new tool + cap args.
- `src/cli/brain/verbs/*` - surface new flags where a CLI verb maps (context-pack / search), if applicable.
- `README.md`, `CHANGELOG.md`, `docs/mcp.md`, `docs/cli-reference.md`, `docs/how-it-works.md`.

## Risks and open questions

- **Migration v4 correctness.** Adding `query_cache` is additive, but the migration
  must be reindex-safe and a newer-than-supported DB must still raise
  `SCHEMA_MISMATCH`. Mitigation: a migration test that opens a v3 fixture, migrates,
  and asserts the table exists and old data is intact.
- **Cache transparency.** A hit must equal a fresh compute. Mitigation: a test that
  runs a query twice and asserts deep-equality of results, and a test that mutates
  generation and asserts the stale row is not served.
- **Intent over-steering.** A misclassified intent must never inject irrelevant
  docs - only re-weight an already-relevant set. Mitigation: bound weight
  multipliers to a narrow band and keep the neutral profile bit-identical.
- **Synonym precision.** Vault-derived expansion can add noise. Mitigation: cap the
  number of expansion terms, require a minimum co-occurrence threshold, and keep
  expansion off for quoted exact-phrase queries.
- **Determinism.** All new ranking/plan/budget math is pure with injectable time;
  no `Date.now()`/`Math.random()` inside pure modules.
