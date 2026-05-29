You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship one coherent "Recall & Ranking Quality" pull request for Open Second Brain (an agent-owned second brain over an Obsidian-compatible Markdown vault; TypeScript + Bun; exposes an `o2b` CLI and MCP servers). The PR bundles 8 features drawn from 5 upstream-inspired kanban tasks, all touching the retrieval / recall / context-injection layer. Implementation will be TDD, one feature at a time, on a single feature branch.

The 8 features:

1. **Weibull recency decay** (replace the current stepwise `recencyBoost`). Today `src/core/search/ranker.ts:recencyBoost` is a hardcoded step function (<=7d -> 0.05, <=30d -> 0.025, <=90d -> 0.01, else 0). Generalise to a configurable Weibull decay curve (shape + scale parameters) so different vaults can tune how fast old content loses relevance. Must default to a curve that is close to today's behaviour and remain bounded and deterministic.

2. **Query-intent classification**. Classify the incoming query into an intent (e.g. fact-seeking, decision-seeking, pattern-seeking, instruction-seeking, exact-phrase) and adjust ranking strategy accordingly (e.g. fact queries lean keyword/entity, pattern queries lean recency/semantic). HARD CONSTRAINT: the classifier MUST be language-agnostic and structural/statistical only - NO per-language keyword lists, NO hardcoded natural-language phrases. Signals available without language tables: presence of quoted exact phrases, share of entity-like tokens (the codebase already has structural, language-agnostic `extractEntities`), query length, presence of wildcard/boolean FTS operators, wikilink-shaped tokens, digits/dates.

3. **Per-memory character cap** in `brain_context_pack` (`src/core/brain/context-pack.ts`): trim individual oversized entries by score order before they consume the bundle budget. Zero/unset = no trimming (today's behaviour).

4. **Total recall character cap**: a second budget dimension alongside the existing `max_tokens`, capping total characters across the returned bundle, discarding lowest-scored overflow.

5. **Query result cache**: cache search results to avoid recomputing FTS5 + semantic phases for repeated/identical queries within a scope. Decide session-scoped (ephemeral) vs vault-scoped (persistent with TTL).

6. **Synonym / query expansion**. Broaden recall when the query wording differs from stored wording. HARD CONSTRAINT: language-agnostic. NO WordNet, NO bundled per-language synonym tables. Acceptable approaches: vault-derived co-occurrence/statistical expansion, morphological/affix folding that is not language-specific, or embedding-neighbour expansion reusing the existing optional embedding provider. Must be a no-op (bit-identical results) when the signal is absent.

7. **Corpus-generation tracking + query-cache invalidation gate**. Track a "corpus generation" fingerprint (composed of embedding model + embedding dimension + relevant index/schema version) so the query cache (feature 5) can be invalidated when the underlying embedding state changes, never serving stale results. Smaller-first-cut acceptable: generation/dimension-level invalidation rather than per-page hashing.

8. **`brain_pre_compress_pack` MCP tool**: a read-only tool that returns a tight, budgeted bundle of the top-K highest-confidence preferences plus the head of `active.md`, formatted as a system-prompt addendum, so an external runtime can inject it just before a context-compression event. OSB ships only the tool; any host-runtime (Hermes) wiring is an out-of-scope integration recipe. Reuses the budgeting/ranking primitives from features 3/4.

# Project context

- Language/runtime: TypeScript, Bun. Search layer is pure-function-heavy with I/O confined to a `Store` (SQLite, FTS5, optional sqlite-vec).
- Current search pipeline (`src/core/search/search.ts`): fts candidates -> semantic candidates -> hydrate -> `rankResults` (keyword + semantic + link + recency + tier + entity) -> link-graph traversal -> MMR diversify -> property filter -> visibility scope -> slice. NOTE: MMR diversity rerank (`src/core/search/mmr.ts`), link traversal (`traversal.ts`), entity boost (`entities.ts`), explainable-recall `reasons`, and tier weighting ALREADY SHIPPED in v0.13.0 - do NOT propose re-implementing them.
- Config: `resolveSearchConfig` in `src/core/search/index.ts` resolves a frozen `ResolvedSearchConfig` from env-or-config keys (`OPEN_SECOND_BRAIN_SEARCH_*`) with documented `DEFAULTS` and a `validateResolvedConfig` gate. Recall tunables live in a nested `ResolvedRecallConfig` (`recall.mmrLambda`, `recall.maxHops`, `recall.hopDecay`, `recall.maxExpansionPerHit`). Per-query overrides ride on `SearchOptions`.
- Persistence: `src/core/search/schema.ts` has `LATEST_SCHEMA_VERSION = 3` with an additive, reindex-safe migration ladder. A key-value `index_state` table already persists `embedding_model` and `embedding_dimension` (see `store.ts:683`). `chunk_entities` table exists (v2).
- Ranking is pure and deterministic (a hard "Syncthing determinism" contract: same vault -> byte-identical results across peers). `extractEntities` is explicitly structural with "no language word lists".
- `brain_context_pack` (`src/mcp/brain-tools.ts:1588`, core `src/core/brain/context-pack.ts`) returns the highest-tier, newest vault slice under `max_tokens`, tier-ordered core->supporting->peripheral.

Recent commits (git log --oneline):
- cbbe18f feat: typed graph semantics - typed relations, visibility scoping, MCP landscape (#46)
- 5fa7eb0 feat: MCP context economy - preview budget, artifact fetch, recall hint (#45)
- 2bd3f48 v0.17.0 - Brain Lifecycle Review Suite
- 2147640 v0.13.0 - Hybrid Search and Recall Quality: explainable recall, MMR, link traversal, entity boost, header anchoring

Related files:
- src/core/search/search.ts (orchestrator)
- src/core/search/ranker.ts (pure ranker; recencyBoost step function lives here)
- src/core/search/mmr.ts, traversal.ts, entities.ts (shipped recall layers)
- src/core/search/types.ts (BrainSearchResult, SearchOptions, ResolvedRecallConfig, ResolvedSearchConfig)
- src/core/search/index.ts (resolveSearchConfig, DEFAULTS, validation)
- src/core/search/store.ts (Store: FTS, semantic, hydrate, index_state KV at :683)
- src/core/search/schema.ts (migration ladder, LATEST_SCHEMA_VERSION=3)
- src/core/search/fts.ts (runFtsQuery)
- src/core/brain/context-pack.ts (budgeted context pack)
- src/mcp/brain-tools.ts (brain_search, brain_context_pack, MCP tool registration)
- src/mcp/instructions.ts (agent-facing tool docs)

Conventions:
- Pure deterministic modules; I/O confined to Store. Same vault -> identical output across Syncthing peers.
- Per-feature graceful degradation: every new layer must be a documented no-op when its input is absent/disabled, so untagged/pre-reindex vaults stay byte-identical.
- Config via env-or-config with DEFAULTS + validation; per-query opt-outs on SearchOptions.
- Additive, reindex-safe schema migrations; bump LATEST_SCHEMA_VERSION only when a column/table is genuinely needed.
- TDD: each atomic unit is a separate conventional commit with failing tests first.
- One PR = one CHANGELOG version.

Constraints:
- LANGUAGE-AGNOSTIC IS NON-NEGOTIABLE: no per-language keyword/synonym/stopword lists, no hardcoded natural-language phrases anywhere. Intent classification and synonym expansion must use structural/statistical/vault-derived/embedding signals only. This is both a project invariant and an explicit operator rule.
- Preserve determinism (no Date.now() baked into pure modules without an injectable nowMs; no Math.random()).
- Do not change the meaning of existing BrainSearchResult fields; additive only.
- Avoid new heavy external dependencies; prefer reusing the existing optional embedding provider and SQLite.
- Keep each feature individually disable-able and bounded.

# Required output format

Produce exactly 3 distinct architectural variants for how to STRUCTURE and INTEGRATE these 8 features into the existing pipeline (e.g. where intent classification plugs in and how it adjusts weights; where the cache + invalidation layer sits relative to search(); whether budgeting is a shared primitive reused by context_pack and pre_compress_pack; whether synonym expansion is query-rewrite-before-FTS vs candidate-augmentation). For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
