You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Epic "Recall Lane Latency and Caller Control" for Open Second Brain (v1.84.0 wave). Four kanban tasks ship as one release on one feature branch. Theme: make the recall lane faster and give callers honest, opt-in control and accounting over what it returns.

## Task 1 (t_862b4d29, p4): Run the semantic lane concurrently with the keyword lanes in hybrid search

Upstream gbrain v0.60.214.0 starts the query embedding and vector search at the same time as the keyword/lexical arms instead of after them, joining the vector side before fusion. On a large brain this removed roughly 130-150 ms of median search latency by hiding the query-embed round trip behind keyword execution, with byte-identical results and an `overlapped_ms` timing breakdown showing how much of each stage was hidden.

Open Second Brain's hybrid search runs its lanes strictly sequentially, so every semantic query pays the full query-embed latency after keyword retrieval finishes. Overlapping the lanes is a pure latency win for interactive recall (CLI and MCP search alike) with no change to ranking, and the same `overlapped_ms` accounting would keep `search --explain` timings honest.

Validator verdict: premise confirmed with minor line drift. The keyword lane is synchronous (`runKeywordLane`, src/core/search/pipeline/keyword-lane.ts:64) and completes at src/core/search/search.ts:413-431 before the semantic lane is awaited at 454-461 (`awaitWithinDeadline` at 457 under the composite deadline). The embed round trip is awaited inside the lane (semantic-phase.ts:185-189 embed, :232 semanticTopK). No start-early/join exists on the query path. Two risks: a dangling in-flight embed when the keyword lane throws (unhandled rejection / closed-store hazard), and `keywordHitCount` (semantic-lane.ts:32, read by `detectHybridDegrade` at 109-113) which would read zero at call time under start-early. `overlapped_ms` must ride a per-call sink, never `SearchOutcome`: the query cache persists whole outcomes (cache-slot.ts:472, finalize guard search.ts:402-410).

## Task 2 (t_767a6bd3, p3): Caller-selectable recall packing policy (query-first vs facts-first) for the limited reading budget

Upstream gbrain v0.58.0.0 adds an explicit, caller-selectable packing policy for recall's limited token reading budget: `query_first` spends the budget on matching source pages first and lets stored facts fill the remainder, versus the existing facts-first default. Exposed as a `budget_policy` option, with explicit packing accounting and identical validation across local and remote transports. Omitting the option preserves current behavior. Upstream deliberately keeps facts-first as default (a misrouted fact question regressed 1/1 to 0/1 under query-first).

Validator verdict: premise partly false. The budget primitive exists and the `queryMode` opt-in precedent ships (frozen tuple + guard + option at context-pack.ts:113-121/258, MCP coercion and refusals at pack-tools.ts:186-204, schema enum at 1056-1062, `dependentRequired` at 1141). But pages and facts are budgeted by two separate surfaces - `maxTokens` + `applyCharBudget` in src/core/brain/context-pack.ts (option at 245, loop 726-765, char budgets 715/815) versus the recall-inject hook's own caps (RECALL_INJECT_MAX_NOTES/MAX_CHARS/TIME_BUDGET_MS, recall-inject.ts:42-48, config specs in src/core/config.ts:1413-1447) - so there is no single budget for a packing order to reorder. Corrected scope: correlate the budgets first, then add the knob modeled on queryMode, opt-in per caller, default unchanged. Operator note for this wave: if the budget correlation grows during design, land concurrency, facets and the fixture first and keep the knob strictly opt-in or defer that one card. Both surfaces already denominate content with the same `estimateTokens` currency (shared from src/core/brain/text/tokenizer.ts), and src/core/brain/recall-budget.ts is the one module both trimming paths reuse.

## Task 3 (t_4b2ffde5, p3): Opt-in standing-instruction facets with first-mention provenance

Upstream yantrikdb v0.17.0 ships an opt-in "standing-instruction facets" lane: standing instructions are faceted for recall, each facet exposing the first mention turn, with a measured retrieval improvement (+0.875 on the standing-instruction category in the upstream harness, no default behavior change). Open Second Brain has a rich standing-preference system (Brain/preferences pref-* notes) but its runtime recall surface exposes bare `pref-<slug> (scope)` strings (src/core/brain/attention-flows.ts:196-221) with no first-mention provenance. Ship as opt-in and gate the lane on a bench run rather than shipping unmeasured.

Validator verdict: premise partly false. The facet gap is real, but provenance has a home: preferences carry `created_at`/`evidenced_by` (preference.ts:148/:151) and a dream-stamped `valid_from` (:248/:904); the turn id exists one hop away in `BrainSignal.session_ref` typed `<path>#<turn-id>` (types.ts:877), baked in by import-session (import.ts:445). The thread-recall lane has since shipped `ThreadFacet`/`ThreadFacetMention`/`ThreadFacetCluster` (src/core/brain/thread-topics.ts:38-59), so the work is a read-time join following that contract style, not a new stamp - and a distinct type name to avoid overloading "facet". Residual gap: extract-signals persists a bare `session:<id>` ref (extract-signals.ts:646), so auto-extracted preferences have no turn to join. Operator standing rules must never be rewritten; the lane is read-only. Capture lifecycle refs look like `session:<id>#<event>` (session-lifecycle.ts:858) - event ids, not guaranteed turn ids. The bench (`runMemoryBench`, src/core/bench/phases.ts) has a frozen category tuple (`BENCH_CATEGORIES`, types.ts:36-48), pinned knobs (`BenchPinnedKnobs`, types.ts:247-262, part of the run identity hash; `DEFAULT_BENCH_KNOB_PIN` at 260) and an all-pass-or-nonzero exit code.

## Task 4 (t_1b2b6932, p1): Shared deterministic OpenAI-compatible mock endpoint for local and CI test runs

Upstream honcho PR #1094 provides a single shared, deterministic OpenAI-API-compatible HTTP fixture (embeddings + rerank) so search/embedding/rerank flows can be integration-tested with no keys and no flakiness, collapsing duplicated per-test HTTP stubs.

Validator verdict: premise partly false - the consolidation already exists. tests/helpers/fake-http.ts is the shared deterministic fixture (44 references): Bun server with a per-test `setHandler` seam, a default handler serving only `/embeddings` with vectors derived deterministically from the input text (fake-http.ts:37-50), 404 otherwise, call counter, per-instance `/i{N}/v1` path segment added to defeat a port-reuse flake. Honest scope: add a `/rerank` route to the default handler (wrapped `{ results: [{ index, relevance_score }], model }` shape, one item per document, deterministic scoring derived from the request text) and move the cross-encoder tests onto it (tests/core/search/rerank.cross-encoder.test.ts stubs `globalThis.fetch` against a fake endpoint constant today; three pipeline files duplicate a `stubRerankFetch(winner)` stub). No standalone mock server, no chat-completions route (no chat flow exists in this tree). Watch the byte-pinned warning strings: the fixture JSON-encodes bodies, so raw-body 503 cases that pin `rerank_degraded:` messages should stay at the fetch seam.

# Project context

Open Second Brain: TypeScript on Bun 1.4.0, second brain for AI agents over Obsidian-compatible Markdown vaults plus SQLite (FTS5 + sqlite-vec) index. CLI (`o2b brain <verb>`, `o2b search`), MCP server, python Hermes plugin. Markdown files are authority; SQLite and state files are recomputable caches.

Recent commits:
e239d323 chore(release): v1.83.0
(recent waves shipped as single squashed feature PRs: recall lanes, decision model, thread recall, honest embedding spend, memory bench)

Related files:
- src/core/search/search.ts (composite deadline, awaitWithinDeadline, lane orchestration, finalize/cache guard)
- src/core/search/pipeline/keyword-lane.ts, pipeline/semantic-lane.ts, pipeline/post-rank.ts (raceRerank), pipeline/cache-slot.ts
- src/core/search/semantic-phase.ts (query embed, semanticTopK), src/core/search/types.ts (SearchOptions, freshenSpawn per-call hook precedent)
- src/core/search/explain-envelope.ts, src/cli/search/outcome-render.ts, src/cli/search/verbs/query.ts (--explain, off-means-absent house rule)
- src/core/brain/context-pack.ts (maxTokens packing loop, applyCharBudget, queryMode pattern), src/core/brain/recall-budget.ts (shared trim primitive), src/core/brain/recall-inject.ts (hook-side caps), src/core/config.ts (RECALL_INJECT_CAP_SPECS)
- src/mcp/brain/pack-tools.ts (query_mode coercion, refusals, schema enum, dependentRequired)
- src/core/brain/attention-flows.ts (standing_query emission), src/core/brain/thread-topics.ts (ThreadFacet contract), src/core/brain/preference.ts, src/core/brain/signal.ts, src/core/brain/sessions/import.ts, src/core/brain/extract-signals.ts, src/core/brain/session-lifecycle.ts
- src/core/bench/types.ts (BENCH_CATEGORIES, BenchPinnedKnobs, DEFAULT_BENCH_KNOB_PIN), src/core/bench/phases.ts (runMemoryBench), src/cli/brain/verbs/bench.ts
- tests/helpers/fake-http.ts (shared deterministic fixture)

Conventions:
- Deterministic, bounded, fail-closed core; no model calls on recall paths; provider-dependent work degrades cleanly under the composite deadline.
- Neutral defaults: an omitted new option is byte-identical to the previous release on every surface, pinned by tests (the queryMode absent-option pin, the bench baseline fixture, the search resultShape projections).
- Nothing silently falls back: refusals are named; degraded answers carry named warnings; a knob that cannot be honest on a surface is not shipped there.
- Every new capability ships as: core module + caller surface + tests (bun test) + docs; TDD with atomic conventional commits; oxlint/oxfmt baseline; TypeScript strict, no `as` cast crutches.
- Repeated values hoisted into named constants; no hardcoded natural-language phrases outside named constants; English everywhere.

Constraints:
- Do not change existing public APIs: new options are additive and optional; the frozen bench category tuple, knob pin, MCP tool list and pinned warning strings must stay stable or move deliberately.
- The recall-inject hook has a hard 2,500 ms retrieval budget; no change may add a second retrieval pass to it.
- The query cache persists whole outcomes, so nothing per-call (timings) may ride SearchOutcome.
- Operator note: if the packing-knob budget correlation grows during design, land concurrency, facets and the fixture first and keep the knob strictly opt-in or defer that one card.
- Four lanes must be able to land in parallel with disjoint files; shared seams (bench runner, explain schema, docs, CHANGELOG) need pinned hunk ownership.

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
