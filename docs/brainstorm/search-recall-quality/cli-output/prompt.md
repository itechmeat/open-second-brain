You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship a "Search & Recall Quality" suite for Open Second Brain: seven related, atomic enhancements to the retrieval core (all in `src/core/search/` plus the MCP search surface `src/mcp/search-tools.ts`). They share one release. Each is additive, opt-in or backward-compatible, and language-agnostic (NO hardcoded natural-language word lists in any language; structural signals, frontmatter fields, document-frequency, or LLM extraction only). The seven units:

1. score_breakdown (explain): add an opt-in `explain` flag to brain_search that returns a structured per-result `score_breakdown` object (semantic, keyword, entity_boost, recency_boost, link_boost, activation, co_access, etc.) alongside the existing human-readable `reasons[]` strings. The ranker already computes every numeric component; the gap is a structured projection in the output schema.

2. relevance threshold + rerank: add an opt-in `threshold` (similarity/score floor, default disabled) and `rerank` flag to brain_search so a query with no sufficiently relevant memory returns no match instead of weak noise. Must compose with the existing post-rank MMR diversity pass.

3. hybrid-degrade warning: emit a warning when the caller expects hybrid (keyword+semantic) search but it silently degrades to a single lane (e.g. semantic enabled but the vec extension/embedding key is unavailable, or keyword-only fallback). Today this degradation is silent.

4. inline trust metadata on hits: stamp each recall hit with computed-at-read-time trust fields (age in days, superseded status, conflict status). The signals already exist in separate passes (brain_truth conflicts, bi-temporal `supersedes` frontmatter) but are not projected onto search hits. Must be read-time/computed like the existing recall-hint, never stored.

5. self-tuning reinforce: add an opt-in `reinforce=[id,...]` parameter to recall that lifts specific memories proven useful (via a small plugin-side ledger) by re-ranking them before the top_k cut. Distinct from the existing feedback loop (which folds up/down verdicts into learned per-layer weights). Surfaced-only frequency is never a positive boost.

6. MCP eval suite: expose the existing recall benchmark over MCP (a `run_eval`-style tool), add source-utilization and citation-depth eval dimensions, and a `source_warnings_max` CI gate. Read-only eval report/history resources.

7. answer-containment metric + reproducible corpus: extend the existing recall benchmark (`src/core/search/benchmark.ts`, currently hit@k + MRR over a committed fixture) with an answer-containment@k metric and ensure a curated reproducible corpus + CI guard.

# Project context

Open Second Brain — an agent-owned Obsidian/Markdown second-brain memory system. TypeScript on the Bun runtime; SQLite (FTS5 + sqlite-vec) search index; MCP server exposing brain tools; CLI `o2b`. Single authoring language (English). Versioned via package.json mirrored to several manifests.

Recent commits (suite-style PRs are the norm):
2e74afe feat: native Grok Build CLI integration (v1.4.0)
0340560 feat: Continuity, Hygiene & Freshness Suite (v1.3.0)
957a403 feat!: Stability & Trust - 1.0.0 API freeze, safeguard, staged dream
6d09d3c feat: Link & Recall Intelligence Suite - alias resolution, communities, recall benchmark, self-tuning
b16c37d feat: Time-Aware Recall & Activation Suite - usage-aware ranking, event-time recall, two-pass recovery

Related files (already read, accurate):
- src/core/search/ranker.ts — pure ranker; computes keywordScore, semanticScore, linkBoost, recencyBoost, entityBoost, activationBoost, coAccessBoost, sessionFocus; emits reasons[] strings via buildReasons().
- src/core/search/types.ts — BrainSearchResult (carries keywordScore, semanticScore, linkBoost, recencyBoost), SearchOptions, SearchOutcome (results, warnings, total), ResolvedRecallConfig (per-layer kill switches: learnedWeightsEnabled, selfTuningEnabled, relationPolarityEnabled, activationEnabled...).
- src/mcp/search-tools.ts — brain_search input/output JSON schema; SEARCH_OUTPUT_SCHEMA already has results[].reasons, warnings[], total, recall_hint.
- src/core/search/recall-hint.ts — deriveRecallHint(): computed-at-read-time, never-stored, single English template + numbers. The model pattern for inline trust metadata.
- src/core/search/feedback.ts — explicit up/down feedback folded into bounded learned per-layer weights (Brain/search/feedback/, learned-weights.json). Pure, replayable fold.
- src/core/search/benchmark.ts — runRecallBenchmark(): hit@k + MRR over a dataset; consumed by CI test, `o2b brain benchmark run`, and tuneRecall objective.
- src/core/search/tuning.ts — grid-evaluates recall params against the benchmark, persists winner to Brain/search/tuning.json.
- src/core/search/search.ts — resolveSemanticPolicy() decides semantic on/off; runSemanticPhase() attempts the semantic lane; warnings[] already collected and surfaced.
- src/core/search/mmr.ts — mmrRerank() post-rank diversity pass.

Conventions:
- Every new ranking/recall behaviour is opt-in or has an explicit kill switch in ResolvedRecallConfig, and a vault that does not opt in ranks bit-identically to before.
- Pure core stays side-effect free; CLI/MCP surfaces opt into recording/telemetry.
- Per-result `reasons[]` and set-level recall_hint are computed at read time, never stored.
- One-file-per-signal under Brain/search/* for conflict-free multi-device sync (feedback pattern).
- Strict TypeScript; no `as` cast crutches; build values with the correct type from the start.
- Language-agnostic: no natural-language keyword lists.

Constraints:
- Do not change existing public API result shapes by default — new fields must be additive and gated behind the opt-in flag (explain/threshold/reinforce), preserving byte-identical legacy output when the flag is off.
- No new external runtime dependencies unless strongly justified.
- All seven units ship on ONE feature branch as atomic commits, ONE CHANGELOG version, implemented one-by-one via TDD.
- Trust metadata and score_breakdown must reuse the existing computed-at-read-time pattern, not add stored columns.

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
