You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship a "Vault Integrity & Trust" suite for Open Second Brain: a TypeScript/Bun MCP server + `o2b` CLI over an Obsidian-compatible Markdown vault, backed by SQLite (FTS5 + sqlite-vec). The suite bundles five atomic units that share one release. They are independent in code but cohere around one theme: every byte that crosses a trust or identity boundary - into a model prompt, into the index, or out through recall - is delimited, neutralized, identity-stable, fast to query, and scoped to its owner. The architecturally significant decisions are listed per unit below; brainstorm the cross-cutting design, not line edits.

## Unit 1 - Untrusted-source delimiting + jailbreak-sentinel neutralization + prompt hardening (security, highest priority)
OSB assembles untrusted note/source text into agent-facing payloads at several sites (dream, deep-synthesis SynthesisNote, pre-compact-extract, context-pack / recall expansion). Today nothing delimits that untrusted span or neutralizes injection. Goal: wrap each untrusted span in a provenance-carrying delimiter `<untrusted_source path="..." sha256="...">...</untrusted_source>` reusing the existing content-hash, and neutralize jailbreak sentinels. HARD CONSTRAINT: language-agnostic - NO hardcoded natural-language word lists in any language (no "ignore previous instructions" string lists). Neutralization must be structural only: zero-width / bidi / control characters, fenced role-turn markers (e.g. lines that look like `system:` / `assistant:` chat-turn boundaries), nested-delimiter escaping. Existing home candidate: `src/core/redactor.ts` already exports `stripPrivateRegions`, `redactRawOutput`, `normaliseTextField`, `sanitiseTextField`.

## Unit 2 - NFC path-identity normalization (correctness)
`src/core/brain/note-path.ts` and `src/core/brain/content-hash.ts` do not NFC-normalize the path component before identity/hashing. macOS (APFS/HFS+) stores filenames as NFD, Linux/Android as NFC, so the same note has byte-different paths across a Syncthing multi-device vault, defeating incremental-index change detection (re-index churn) and surfacing phantom cross-device duplicates. `src/core/search/embeddings/local-provider.ts` already NFC-normalizes body text but not paths. Goal: NFC the path component at the identity boundary so the same note is one identity across devices.

## Unit 3 - File-watcher auto index sync (freshness)
The indexer (`src/core/search/indexer.ts`: `indexVault` full/incremental on hash+mtime, `indexCheck` diff report) runs on-demand only. Goal: an opt-in watch mode that watches the vault for `.md` edits and incrementally syncs the index. No new dependency - native `fs.watch` (Bun built-in); chokidar is NOT in deps. Must debounce bursts, coalesce rapid edits, never run overlapping index passes, and shut down cleanly. Decide: where the watch loop lives (CLI verb daemon vs library function), debounce/coalesce strategy, and how it reuses the existing incremental `indexVault` path without a full re-index.

## Unit 4 - O(1) graph query/stats via precomputed side-indexes (performance)
`src/core/brain/link-graph/communities.ts` rebuilds adjacency on every `detectCommunities` call and `sharedEntities` scans all documents each call. Graph access is centralized in a `Store` object (`listDocuments`, `resolvedDocLinkPairs`, `entitiesForDocument`). Goal: precomputed side-indexes (name->node, (src,dst,type)->edge, node->degree, top-degree snapshot) so graph stats/queries are O(1) instead of O(n) rebuild-per-call. Decide: where the side-indexes live and how they stay consistent (maintained inline on write vs lazily memoized + invalidated on store version vs persisted in SQLite). Read paths must stay correct and deterministic.

## Unit 5 - Agent-scoped recall isolation (security)
`src/core/search/search.ts` recall has a `visibility` frontmatter content-scope but NO agent-ownership isolation: any caller can recall any agent's memories. Goal: an opt-in agent-scope filter (analogous to the existing `visibility` scope option) so a recall call constrained to an agent never returns another agent's owner-private memories. Decide: query-time filter vs index partition, how ownership is declared (frontmatter field), and how it composes with the existing visibility scope. Must be backward compatible: a call that asks for no scope behaves byte-identically to today.

# Project context

Open Second Brain - TypeScript / Bun runtime, SQLite (FTS5 + sqlite-vec), MCP server (72 tools) + `o2b` CLI, Obsidian/Markdown vault.
Recent commits:
70d95c6 chore(release): bump version to 1.5.0 (#94)
e4df212 feat: Search & Recall Quality Suite - explainable scores, trust, threshold, reinforce, eval (#93)
2e74afe feat: native Grok Build CLI integration (v1.4.0) (#91)
0340560 feat: Continuity, Hygiene & Freshness Suite (v1.3.0) (#87)
8972f13 refactor: SOLID/DRY decomposition - domain modules, unified helpers (v1.2.0) (#86)
6651228 refactor: language-agnostic fact extraction (v1.1.0) (#85)
9886d9a refactor: make search and classification language-agnostic (#84)
Related files:
src/core/redactor.ts, src/core/brain/pre-compact-extract.ts, src/core/brain/dream.ts, src/core/brain/deep-synthesis.ts, src/core/brain/note-path.ts, src/core/brain/content-hash.ts, src/core/search/indexer.ts, src/core/search/embeddings/local-provider.ts, src/core/brain/link-graph/communities.ts, src/core/search/search.ts, src/core/search/types.ts, src/core/search/store.ts, src/core/graph/visibility.ts
Conventions:
- Byte-identical-when-flags-off: a new opt-in behaviour must leave every existing caller bit-identical when it opts into nothing.
- Read-time-never-stored enrichment pattern (recall-hint.ts, enrich.ts precedents): derive at read time, do not persist into notes.
- Pure functions for derivation; side effects (ledger writes, daemon lifecycle) stay at the CLI/MCP edge.
- Language-agnostic: no hardcoded natural-language word lists - only structural signals, typed-relation identifiers, frontmatter fields, document frequency, folded substring, mtime.
Constraints:
- No new external dependencies (native fs.watch only for Unit 3).
- No `as` / `as unknown as` TypeScript cast crutches; build values with the correct type.
- No misleading fallbacks or hardcoding.
- Each unit must be opt-in and preserve the byte-identical-when-off guarantee where it touches an existing path.
- All five units share ONE feature branch and ONE release; they are implemented one-by-one via TDD.

# Required output format

Produce exactly 3 distinct architectural variants for how to structure this five-unit suite as a coherent whole (e.g. how much shared infrastructure to build vs keeping the units independent, where the trust-boundary primitives live, how the read-time-derive vs persisted-side-index tension is resolved across units). For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
