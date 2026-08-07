You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Open Second Brain is a deterministic memory layer for AI agents over an Obsidian-compatible Markdown vault: a TypeScript/Bun CLI (`o2b`) plus an MCP server, with a derived SQLite index (`brain.sqlite`) holding documents, chunks, an FTS5 keyword index, a trigram index and embeddings.

Eleven kanban tasks were selected as one release wave, all on the retrieval path. A reconnaissance pass over the actual code falsified the load-bearing premise of nine of them. What remains after falsification is the real scope, and it has an unexpected shape: most of these are not missing capabilities but **computed values that are discarded before anyone can see them**, or **checks that were never run at all**. The wave must be designed around that shape rather than around the eleven original feature descriptions.

The surviving scope, unit by unit:

1. **Entity identity quote fold.** `normalizeEntityName` does `NFC + trim + collapse whitespace + lowercase`. No Unicode normal form maps U+2019 to U+0027, so `Taylor's` and `Taylor's` are two distinct canonical entities in the registry. Folding them structurally makes two previously-distinct records collide, and the registry refuses alias-claim collisions — that refusal must name its resolution rather than surfacing as an opaque upgrade failure. The function is documented in-code as a byte-stable identity kernel, so every currently-valid label must key identically to before.

2. **Weighted fusion under RRF.** A per-query intent profile (quoted phrase, wikilink density, query length) already scales the keyword/semantic/entity weights, and it is on by default. In the opt-in `rrf` fusion mode the relevance term discards that profile entirely, so a user who quotes a phrase gets no lexical preference and receives no signal that their intent was ignored.

3. **Ranking determinism.** The ranker resolves `nowMs` as `opts.nowMs ?? Date.now()`, and the assembly stage never passes it — so every live search re-reads the wall clock. The recency layer is non-zero by default, the first tie-break rung is an exact float comparison, and two identical calls can therefore return two different orderings. The test suite already documents this in comments and strips scores to work around it. Three candidate SQL statements also order by a score column with no unique tiebreaker.

4. **Duplicate passage merge.** A `content_hash` column has existed on chunks since the first schema version and is populated on every index run, but it is never projected into the hydrated row. Exact-duplicate passages are therefore demoted by the diversity reranker but never merged, and continue to occupy result slots.

5. **Match-anchored snippets.** Every snippet surface (600-char MCP content, 240-char cards, 140-char CLI) truncates from the head of the chunk, so a match in the middle of a long chunk is invisible in the preview. A match-centred window function already exists in this repository — mounted on the session-transcript grep surface, not on search — alongside a char-span-to-line-span helper that lives in the search module and has only that one caller.

6. **Retrieval decision trace.** A structure recording evaluated / surfaced / excluded candidates with per-exclusion reasons is built on every search and declared on the outcome type, and is serialized by neither the CLI nor the MCP surface. It is reachable only from a test. Separately, the reported `total` is assigned the returned row count, so a caller cannot distinguish "the vault has three matches" from "the vault has three hundred and you got ten".

7. **Shadow recall-quality signals.** Of seven proposed per-result signals, five are computable (three already computed and discarded) and two — acquisition risk and expected regret — have no backing data anywhere in the system and would have to be invented. The house pattern for a record-only lane that must never perturb production ordering already exists as a documented shadow-only advisor module.

8. **Oversize chunk census.** The default chunk size is 800 whitespace-delimited words; the recommended default embedding model has a 512-token input window. The shipped defaults overflow each other by roughly two to three times and nothing notices. A per-chunk token count is already stored. No provider in this system exposes model metadata and no local model file exists, so the true window cannot be probed without a network round trip or a hardcoded per-model table over an open set of endpoints.

9. **Schema presence check.** The read-open path verifies the schema version integer and nothing else. A database stamped with the current version but missing a table opens successfully and fails later inside a query with a raw SQL error.

10. **As-of expiry.** The expiration filter already takes `now` as a parameter with a default, and the topic-query options already thread it, but no surface ever passes it. The same surface is also missing the flag that reveals expired records, which exists on the MCP side only.

11. **Store integrity gate.** There is no SQLite integrity check anywhere in the codebase. A corrupt-but-parseable index passes the version check, opens cleanly, and serves wrong results indefinitely. The self-heal path triggers only on unreadable, mismatched or missing.

# Project context

Open Second Brain — TypeScript on the Bun runtime, roughly 900 modules under `src/`, with a deterministic kernel that makes no LLM calls. SQLite via `bun:sqlite`, FTS5 and a vector extension. Surfaces are a CLI and an MCP server over the same core.

Recent commits:

```
0ae4b097 feat: provenance at the boundary (v1.43.0)
7e6a5672 refactor: module boundaries and the fallbacks behind them (v1.42.0)
5ac866eb feat: signals that survive (v1.41.0)
0963ef0a feat: no dead ends - every diagnosis names its exit (v1.40.0)
f91a698b feat: context integrity gates (v1.39.0)
c31a2574 feat: semantic-health baseline watermark (v1.38.0)
b0c37977 feat: retrieval quality and context delivery (v1.37.0)
842d690f feat: knowledge intake and consolidation (v1.36.0)
95dc8577 feat: trusted recall and memory write surface (v1.35.0)
4b8100ca feat: source pipeline integrity and operator tooling (v1.34.0)
```

Related areas: the retrieval pipeline (request resolution, query shape, keyword lane, semantic lane, assembly, ranking, post-rank phases, final truncation), the SQLite store and its migration ladder, the entity registry over Markdown files, the MCP tool registry, and the CLI verb dispatcher.

Conventions:

- Every user-facing error resolves a registered diagnostic code that names the command which fixes it; a build ratchet enforces registration.
- A new field on a result type is opt-in and *absent* rather than null when the flag is off; tests assert key absence.
- Byte identity when a feature is off is proved by comparing a flag-on projection against a flag-off projection. There are no golden-blob snapshot tests.
- Census and ratchet tests must be demonstrably able to fail; a previous release shipped one that passed vacuously and it was treated as a defect.
- Search behaviour is pinned by a recall benchmark with hard floors and by exact pass-count assertions in several evaluation harnesses.

Constraints:

- **The SQLite schema version may not be bumped in this wave.** A bump forces every existing index into a mismatch, which triggers a silent self-heal reindex that drops every embedding unless the operator re-runs the embedding phase with an API key and spend. Every unit must therefore be a read projection, a new computation over existing columns, or a file-level artifact.
- No network calls in tests, and no natural-language word lists in any language for gating, classification, ranking or extraction — signals must be structural, corpus-frequency-derived, or score-derived.
- Fallbacks that silently do nothing are forbidden. Where a check cannot run, it must say that it did not run rather than reporting success.
- No new default readiness probe (an existing test pins the count), and the MCP registry enforces description length limits and a preview budget on every tool.

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
