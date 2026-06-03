You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

This is an epic bundling four related kanban tasks that all extend the embedding/semantic-search subsystem of Open Second Brain (a local-first, Obsidian-Markdown agent memory store). The four atomic units, in priority order:

## Unit 1 (p4) — Hybrid dense+sparse RRF ranking
Add Reciprocal Rank Fusion (RRF) as an alternative to the current weighted-linear-sum fusion of BM25 (sparse keyword) and cosine (dense vector) scores. RRF combines the two rankings by rank position (score = sum over lanes of 1/(k + rank)) rather than by min-max-normalised magnitudes. VENDOR-AGNOSTIC ONLY: the upstream inspiration (Tencent TCVDB) is a cloud vector database; we are NOT adding a cloud vector DB. We keep SQLite + sqlite-vec + FTS5 as the storage layer and only add the rank-fusion mode.

## Unit 2 (p3) — Offline local embedder provider
The provider abstraction currently has only `openai-compat` (remote HTTP) and `disabled` (null). Add a `local` provider that produces embeddings with no cloud call, no API key, and no surprise bills — aligned with the product's local-first/privacy promise. The default install must stay lightweight; the local model/runtime can be a lazy/optional dependency. Needs predictable dimension, a model signature, and clear diagnostics when the runtime is unavailable.

## Unit 3 (p2) — CLI provider registry
Today an embedding provider is configured via env vars or by editing the YAML config. Add CLI verbs (`provider add/list/show/remove`) that persist provider definitions (base-url, default-model, env-key for the API key) to a registry file, so users add/remove providers at runtime without editing config. Registered providers are auto-detected AFTER built-ins so they never shadow an explicitly configured key.

## Unit 4 (p2) — Embedding cost model + stale-detection via signatures
Add model-aware embedding pricing (price per million tokens), an embedding "signature" (model + dimension, and possibly provider) stamped per chunk, stale-detection that flags chunks whose signature no longer matches the active config, and a cost gate that blocks a large (re-)embedding run when estimated spend exceeds a configurable threshold. The store already clears all embeddings on a model/dimension change and stamps a per-chunk `embedding_hash`; this unit adds cost visibility, a finer-grained signature, and the spend gate.

# Project context

Project: Open Second Brain. Language: TypeScript. Runtime: Bun. Tests: `bun test`. Lint: oxlint (baseline must not grow). Format: oxfmt. Typecheck: tsc.

Recent commits:
dee5ab7 feat: Memory Integrity Suite - canonical entities, conflict-free log shards, capture boundaries, fact extraction (#66)
5066e71 feat: Token Diet - budgeted injection, reminder cadence, consolidated MCP surface (#65)
c494fd8 feat(search): Recall Trust Suite - relation polarity, learned weights, time-aware and verified recall (#64)
0952dfc feat: become a native Hermes memory provider (#62)
bd49cd5 feat: recall and ranking quality - Weibull recency, query intent, synonym expansion, recall budgets, query cache, pre-compress pack (#47)

Related files (already studied):
- src/core/search/embeddings/provider.ts — `EmbeddingProvider` interface (name, model, dimension, embed(), ping(), consumeRetryCount?()); `makeProvider(config)` factory dispatching on `config.provider` with lazy require().
- src/core/search/embeddings/openai-compat.ts — remote provider: semaphore-bounded batches, retry/backoff, unit-normalised vectors, abort on first failure.
- src/core/search/embeddings/null-provider.ts — disabled provider.
- src/core/search/types.ts — `ResolvedEmbeddingConfig { enabled, provider: "openai-compat"|"disabled", baseUrl, model, apiKey, dimension, timeoutMs, concurrency, batchSize }`; `ResolvedSearchConfig` with keywordWeight/semanticWeight.
- src/core/search/index.ts — `resolveSearchConfig()`: parses embedding_* keys from YAML + env (`OPEN_SECOND_BRAIN_EMBEDDING_*`); `parseProvider()` only accepts openai-compat|disabled; DEFAULTS table (keywordWeight 0.6, semanticWeight 0.4).
- src/core/search/indexer.ts — `populateEmbeddings()`: drives provider.embed() in super-batches, stamps per-chunk sha256(embedding) as `embedding_hash`, calls `store.ensureEmbeddingModel(model, dim)`, `store.vecUpsert()`; `indexStatus()` reports embeddings/staleEmbeddings/embeddingModel/embeddingDimension; `indexCheck()` pings provider.
- src/core/search/store.ts — `vecUpsert(chunkId, vec, model, dim, embeddingHash)`; `ensureEmbeddingModel()` clears embeddings on model/dim change; `corpusGeneration()` = embeddingModel + dimension + schemaVersion + indexRevision (gates query cache); `findChunksWithoutEmbeddings()`; `staleEmbeddings()`; per-chunk `embeddings(chunk_id, model, dimension, embedding_hash, created_at, updated_at)` table.
- src/core/search/ranker.ts — `rankResults()`: current fusion is weighted linear sum `keywordWeight*kwMul*kwNorm + semanticWeight*semMul*semNorm` where kwNorm is min-max-normalised inverted BM25 and semNorm is cosine-from-L2-distance; explainable `reasons` array (`fts5_bm25`, `semantic_cos`, ...).
- src/cli/search.ts — search CLI verbs (reindex, check, focus, feedback, ...).
- src/core/config.ts — `setConfigValue(key, value, path)`, `discoverConfig()`, device-id pattern (env override -> read -> generate under directory lock); YAML-subset parser does NOT unescape backslashes in quoted scalars.

Conventions:
- Provider selection is a closed string union resolved in `resolveSearchConfig`; adding a provider means extending the union, the parser, and the `makeProvider` factory.
- The store is the single source of truth for the embedding model/dimension; `corpusGeneration()` already fingerprints them and self-invalidates the query cache.
- Every config knob has a YAML key + an `OPEN_SECOND_BRAIN_*` env override, with a default in the DEFAULTS table and range validation.
- Ranking layers are bounded, deterministic, and have an explicit off switch that keeps untouched vaults bit-identical; explainable `reasons` strings are part of the contract and are asserted in tests.
- Lazy `require()` keeps the module graph small for users who never enable semantic search.
- Fail-soft: a bad/absent registry or runtime degrades to current behaviour, never throws into the hot path.

Constraints:
- Do NOT add a cloud/hosted vector database. Storage stays SQLite + sqlite-vec + FTS5.
- Do NOT add a heavy mandatory dependency to the default install; any local-embedder model/runtime must be optional/lazy.
- Do NOT break the existing `openai-compat`/`disabled` providers or change their on-disk index format incompatibly.
- Keep ranking changes opt-in and bit-identical-when-off (an existing project rule).
- No new public-API breakage of `EmbeddingProvider` / `ResolvedEmbeddingConfig` consumers without a migration.
- SOLID / KISS / DRY. One shared canonicalization/signature kernel rather than per-call-site duplication.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
