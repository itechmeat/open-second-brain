You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship a "Hybrid Search & Recall Quality" suite for Open Second Brain - five related additions to the existing `src/core/search/` pipeline that complete and make introspectable the hybrid retrieval layer. The five atomic units (one PR, separate commits):

1. **Explainable recall (`why_retrieved`)** - every search result carries a `reasons: string[]` array, one entry per scoring layer that contributed (e.g. `["fts5_bm25: 0.82", "semantic_cos: 0.74", "link_boost: 0.03", "recency: 0.05"]`). No new ranking logic - expose what `rankResults` already computes. Foundation for tuning the layers below.

2. **MMR diversity rerank** - after the fused ranking, apply Maximal Marginal Relevance to the top-K so near-identical results don't flood the list. Classic formula `argmax over remaining of lambda*sim(q,d) - (1-lambda)*max(sim(d,selected))`. Single tunable lambda (default ~0.7). Similarity between candidates uses the embeddings already computed in the semantic phase; when semantic is unavailable, degrade gracefully (no MMR or a content-overlap fallback).

3. **Link-graph traversal during recall** - two-stage: (1) hybrid retrieval returns top-K by relevance; (2) for each hit follow outbound wikilinks up to depth N, scoring linked docs as parent_score * decay^hop, merge into the result set with dedup. Tunables: max_hops (default 1), hop_decay (default 0.5), max_expansion_per_hit (default 3). The `links` table already persists `target_document_id`; today only INBOUND links feed a small ranking boost - no outbound walk exists.

4. **Entity-boosted retrieval (third hybrid signal)** - extract entities at index time into a parallel store; at query time, entities extracted from the query deterministically boost results that mention them. Must be language-agnostic and dependency-free: extract candidate entities via Unicode-category heuristics (wikilink targets, quoted spans, capitalized/CamelCase/ALLCAPS runs) - NO NER library, NO per-language word lists. Graceful: a vault with no extractable entities ranks bit-identically to today.

5. **Header-anchored chunking** - long documents split into multiple chunks; mid-document chunks lose the section's heading context, hurting recall ("facts established under a heading that the chunk no longer contains"). Compute a heading breadcrumb (ancestor heading path) per chunk and make it searchable WITHOUT polluting the stored display content. The chunker already detects heading blocks and resolves a title.

# Project context

Open Second Brain - TypeScript on the Bun runtime. An Obsidian-vault-backed agent-memory system; markdown files on disk, indexed into a per-vault SQLite database (FTS5 + optional sqlite-vec semantic vectors). Search is the core value proposition versus competitors (mem0, mnemosyne, agentmemory, gbrain).

Recent commits:
84886d1 v0.12.0 - Brain Integrity Suite (typed collision detection, content-hash drift, durable dream workruns)
c002268 v0.11.0 - Brain-centric vault layout
a8d4803 v0.10.18 - temporal axis (timeline, belief evolution, stale watch)
d0598af v0.10.17 - link graph surfaces (aliases, anchors, mentions, synthesis, MOC audit, property filter)
3b7dfe9 v0.10.16 - trust and operator surfaces

Related files (current pipeline):
- src/core/search/search.ts - orchestrator: FTS candidates -> semantic candidates -> hydrate -> rankResults -> optional property filter
- src/core/search/ranker.ts - pure `rankResults`; already computes keywordScore, semanticScore, linkBoost (inbound), recencyBoost per result
- src/core/search/store.ts - SQLite access: keywordTopK, semanticTopK, hydrateChunks, inboundLinkSources, tagsByChunkDocument, replaceLinks, resolveLinkTargets
- src/core/search/types.ts - BrainSearchResult, SearchOptions, SearchOutcome, ResolvedSearchConfig
- src/core/search/schema.ts - DDL; LATEST_SCHEMA_VERSION = 1; chunk_fts is EXTERNAL-content FTS5 (content='chunks') synced by triggers from chunks.content; `links` table with target_document_id + idx
- src/core/search/chunker.ts - pure two-pass markdown chunker; emits MarkdownChunk { chunkIndex, content, startLine, endLine, tokenCount }; detects heading blocks; resolveTitle
- src/core/search/indexer.ts - walks vault, chunks, writes documents/chunks/links, populates embeddings
- src/mcp/search-tools.ts - `brain_search` MCP tool (read-only); maps BrainSearchResult to a flat JSON object
- src/cli/search.ts - `o2b search` CLI surface

Conventions:
- TDD throughout (Bun test). Pure functions where possible; the ranker imports no I/O.
- Determinism is load-bearing: the same vault must hash the same chunks on every Syncthing peer. Chunker is dependency-free and machine-independent.
- Results are `Object.freeze`d. Tie-break order is explicit and tested.
- Schema migrations append to `MIGRATIONS` and bump `LATEST_SCHEMA_VERSION`; a newer-than-supported DB raises `SCHEMA_MISMATCH`.
- "Graceful degrade to existing behaviour" is a hard requirement: an untagged / unembedded / un-reindexed vault must rank bit-identically to today.

Constraints:
- No hardcoded human-language phrases or per-language word lists anywhere; handle other languages abstractly (Unicode categories, structural cues).
- No new runtime dependencies without strong justification (prefer dependency-free / deterministic).
- Do not change the meaning of existing `BrainSearchResult` fields; additions only.
- Keep search response time bounded and predictable (the traversal/MMR steps must cap their work).
- Two of the five features (entity store, header-anchored chunking) appear to require a schema migration + reindex; the design should state how a pre-migration index degrades until reindex.

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
