You are a senior backend architect reviewing a feature scope for an existing, mature TypeScript codebase.
Produce an architecture review. NO CODE. Follow the output format EXACTLY.

# Project: Open Second Brain (o2b)

- Runtime: Bun (also runs on Node). Language: TypeScript. Pure filesystem + SQLite, no daemon.
- Domain: an Obsidian-vault-native memory layer for AI agents. Plain Markdown on disk under `Brain/`. Deterministic by design: counters, atomic file moves, hash-stable chunks. The kernel never calls an LLM for its own logic; agents own generation, the vault owns the durable provenanced record.
- Core principle: "you own plain Markdown." Storage stays verbatim; presentation is computed at read time. Syncthing replication across peers, so any persisted value must be hash-stable across machines.
- Conventions: SOLID/KISS/DRY, no misleading fallbacks, no hardcoding, English-only strings (logic must be language-agnostic, no per-language word lists). All new behavior ships behind an explicit switch whose default keeps ranking/behavior bit-identical when the switch is off. Continuity records are append-only JSONL; existing JSONL is never migrated; additive optional fields do NOT bump schema version. Telemetry is fail-open (must never block the primary op) and routed through `emitGatedTelemetry(gate, build)` so the build thunk is never invoked when the gate is off.

# Release scope: "Recall precision, coverage & provenance hardening"

Six concrete-leaf cards ship together on branch `feat/recall-precision-provenance`. They are the primary user-facing function of a second brain: accurate, complete, auditable recall.

## D1 — Context traces attached to logged events (provenance join)
Upstream (signetai v0.144.0) attaches context traces directly to logged events so an operator can answer "why did the agent do this" from one surface.
Status in o2b: present_weaker. o2b ALREADY emits both Brain log events (`appendLogEvent()` → `Brain/log/<date>.md` + JSONL sidecar) AND rich continuity records (`recall_telemetry`, `context_receipt`, `gate_telemetry`, `generation_report`, `session_turn`, `session_summary_node`), but they are queried by SEPARATE readers. The correlation-ID scaffolding (`sourceRefs`, `session_id`, `turn_id`, `handoffKind/handoffRef`, `timestamp`, `agent`) already exists and is the natural join key.
NOT FOUND: a single reader that, given a log event via its correlation IDs, resolves and displays the attached context trace (context_receipt / recall_telemetry / generation_report). o2b has no web dashboard, so the o2b form is a CLI/MCP reader. Reader infrastructure exists: `brain_recall_telemetry`, `brain_context_receipts`, `brain_generation_reports` (MCP) + `o2b brain recall-telemetry|context-receipts|generation-reports` (CLI). Continuity read-model (`src/core/brain/continuity/read-model.ts`) already normalizes records and lifts `session_id`/`turn_id`/handoff fields to first-class join fields.

## D2 — Read-time virtual line numbering for precise line-span citations
Upstream (mempalace) ships two pure functions: `render_with_line_numbers(text, start_line=1)` and `extract_line_range(text, line_start, line_end)` that apply `[N]` line markers at READ time only. A pointer `path:Lstart-Lend` resolves by slicing the range; bytes on disk are untouched.
Status in o2b: not_in_project_useful. o2b cites at path level + a char-offset snippet (`snippet()` in `src/core/brain/session-recall.ts:510`; `EvidencePack` in `src/core/search/evidence-pack.ts:44`). NO line-anchored citation exists. Line-range pointers sharpen the recall benchmark's citation-depth/answer-containment signals and point a reader to exact lines of a long note.
Pure read-time functions, no storage migration. Implement as helpers next to the search/snippet path; plumb a `Lstart-Lend` pointer form into evidence-pack/citation rendering.

## D3 — Generalize progressive search→expand→transcript disclosure to ALL recall
Upstream (memsearch) describes 3-layer recall (search → expand → transcript): compact cards (layer 1), expand a hit to the fuller note (layer 2), drill to raw transcript/source (layer 3). Token-cheap by default; pay for depth on demand.
Status in o2b: present_weaker. o2b ALREADY has this pattern but ONLY for session recall: `searchSessionRecall` returns snippet hits, `expandSessionRecall` walks hit → immediate sources → paginated raw turns (`src/core/brain/session-recall.ts`). The GENERAL vault search (`src/core/search/search.ts`) returns a FLAT ranked list with full content per result and per-layer score breakdowns (`src/core/search/types.ts`) — no compact-card-then-expand depth contract. NOTE: `expand` flag in search/types.ts is query-lane expansion, NOT result-depth disclosure (different meaning). Generalizing search→expand→transcript to the main recall surface serves context-budget goals (context-presets, pre-compress). The session-recall expand machinery is the proven blueprint to lift up a layer. The expand step must reuse the existing store read, not a new index.

## D4 — Normalized-confidence chain-stop for early termination of multi-scope recall
Upstream (mem9) gates early termination of multi-scope recall on a NORMALIZED-confidence threshold (`MNEMO_CHAIN_RECALL_STOP_SCORE`, default 0.8): stop querying later scopes once one reaches the threshold. Crucially uses normalized confidence, not raw score (a high raw score on a tiny corpus must not trigger the stop).
Status in o2b: present_weaker. o2b's cross-vault recall (`src/core/search/cross-vault.ts`) runs the SAME query across every configured vault and merges — no early termination, so N vaults always pay N searches even when the first confidently answers. o2b already has confidence, query planning (`query-plan.ts`), query caching (`query-cache.ts`), and a retrieve-or-not surfacing-gate (`surfacing-gate.ts` — a DIFFERENT decision: WHETHER to retrieve, keep distinct). NOT FOUND: nothing decides WHEN to stop chaining scopes. Threshold MUST gate on normalized confidence, not raw score. Deterministic, no LLM. BrainSearchResult already carries a final normalized [0,1] score (relevance threshold drops results below it).

## D5 — Coverage-driven targeted self-correcting recall on partial misses
Upstream (argus) extends self-correcting recall to fire on PARTIAL evidence (low coverage), not only zero-result, and to issue TARGETED follow-up queries built from specifically-missing facts rather than generic broadening.
Status in o2b: present_weaker. o2b computes IDF-weighted coverage and uncovered rare terms (`src/core/search/coverage.ts` `CoverageReport.uncoveredRareTerms`, `COMPLETENESS_COMPLETE_THRESHOLD`), AND has a self-correcting two-pass recall — but that retry triggers ONLY on a ZERO-candidate first pass in evidence-pack mode and broadens generically with a single OR pass (`src/core/search/types.ts:424` `secondPass`, `twoPassEnabled`; `search.ts`). So when the first pass returns results that nonetheless leave rare terms uncovered (partial miss), o2b does NOT re-query. Wiring coverage's `uncoveredRareTerms` into a targeted follow-up pass (queries derived from the uncovered terms via existing expansion `query-expansion.ts`/`synonyms.ts`), gated on the existing completeness threshold, closes the loop. o2b already abstains rather than guesses. Deterministic trigger (coverage below threshold), no LLM for the trigger. Cap the loop (one targeted follow-up pass) to bound cost, matching the existing single-retry discipline.

## D7 — Make the markdown chunker's token budgets configurable per vault (NOT hardcoded)
Upstream (hindsight v0.8.3) exposes chunker granularity as operator-tunable config.
**IMPORTANT CORRECTION TO THE CARD'S PREMISE (verified in source):** The card claims "the sole caller `indexInto` passes nothing, so chunk size is pinned to hardcoded constants." This is PARTIALLY STALE. Verified facts in the live tree:
- `chunkMarkdown(text, filenameBase, opts)` at `src/core/search/chunker.ts:449` accepts optional `ChunkOptions { maxTokens?, minTokens?, overlapTokens? }`.
- Hardcoded defaults at `chunker.ts:11-13`: `DEFAULT_MAX_TOKENS=800`, `DEFAULT_MIN_TOKENS=100`, `DEFAULT_OVERLAP_TOKENS=100`.
- The sole caller `indexInto` at `src/core/search/indexer.ts:263-265` ALREADY passes `{ maxTokens: config.chunkSize, overlapTokens: config.chunkOverlap }`.
- `resolveSearchConfig` (`src/core/search/index.ts`) ALREADY resolves `chunkSize` (default 800) and `chunkOverlap` (default 100) from config key `search_chunk_size` / `search_chunk_overlap` AND env `OPEN_SECOND_BRAIN_SEARCH_CHUNK_SIZE` / `OPEN_SECOND_BRAIN_SEARCH_CHUNK_OVERLAP`, with validation (`chunkOverlap < chunkSize`).
So `maxTokens` and `overlapTokens` ARE already operator-tunable via config. What is NOT yet configurable: `minTokens` (the chunk-packing floor, hardcoded DEFAULT_MIN_TOKENS=100, has no config/env surface and is not threaded into the indexer call). The chunker also carries a determinism contract ("hashes the same chunks on every Syncthing peer") — any per-vault config must stay stable/shared across peers or it churns chunk hashes. Consider whether this card collapses to "expose `minTokens`" only, or whether it should be reframed.

# Recent git log (most recent first)
```
da2e3cc feat: memory subsystem alignment - honest pinned budgets, atomic batch writes, on_memory_write host bridge (v1.16.0) (#107)
4db7862 fix(hermes): pass --repo so bridge skill discovery resolves repoRoot (#103) (#106)
0a4b6da feat: calendar obligations, agenda synthesis, OKF portability, Obsidian Bases and steelman synthesis (v1.15.0) (#105)
f8b4abf feat(brain): add feedback default scope and vault write containment (#104)
20ea7ef feat: per-handoff LLM generation tracing and prompt-prefix stability metric (#102)
9c1d48f feat: CodeGraph and MCP operational readability (v1.12.0) (#101)
c2c3ff4 feat: Session Knowledge Synthesis Suite - structured session summaries, idea-lineage, episodic note history (v1.11.0) (#100)
56dd3dd fix(hermes): bridge EOF - byte streams, stderr drain, retry loop (#92)
35b824e feat: Recall & Working-Memory Quality Suite - selectable profiles, usage decay, co-occurrence, file-context (v1.10.0) (#99)
929d54c feat: Brain Portability & Interop Suite - bank export/import, page contract, brain_create_note, in-process SDK (v1.9.0) (#98)
8b679fe feat: Knowledge Provenance Suite - ingest, research, NER, derived facts, owner-scope, standing-query (v1.7.0) (#96)
6e59a42 feat: Vault Integrity & Trust Suite - untrusted-source containment, NFC identity, watch-sync, O(1) graph, agent-scope (v1.6.0) (#95)
e4df212 feat: Search & Recall Quality Suite - explainable scores, trust, threshold, reinforce, eval (#93)
```
Pattern: each release is a themed multi-card suite landing as ONE PR. Recall/search quality is a recurring theme. o2b already has a rich search-quality substrate (coverage, IDF, evidence-pack, two-pass, cross-vault, query-plan/cache, surfacing-gate, confidence, reinforcement).

# Constraints to honor
- Default-off / bit-identical-when-off switches for any new ranking or cost behavior (D4, D5 especially).
- Telemetry fail-open via emitGatedTelemetry; never block the primary op.
- Read-time-only for D2: never mutate stored Markdown; pointers must not invalidate on re-mine (deterministic numbering).
- D3 expand must reuse existing store reads, not a new index.
- D4 must gate on NORMALIZED confidence; stay distinct from the surfacing-gate (whether-to-retrieve) and from query-cache (which is per-request, not cross-scope chain order).
- D5 must cap at one targeted follow-up pass; deterministic trigger; reuse existing coverage + expansion machinery.
- D7: the per-vault determinism contract across Syncthing peers must not break; chunk hashes must stay stable.
- Cards are driven ONE AT A TIME on the shared branch, so designs must not overlap/conflict (e.g. D4 and D5 both touch recall search.ts; D3 and D2 both touch result/citation rendering).

# Your output — EXACTLY this structure, nothing else

## Variant 1
Approach: <2-3 sentences>
Trade-offs:
- <bullet>
- <bullet>
Complexity: small|medium|large
Risk: low|medium|high

## Variant 2
Approach: <2-3 sentences>
Trade-offs:
- <bullet>
- <bullet>
Complexity: small|medium|large
Risk: low|medium|high

## Variant 3
Approach: <2-3 sentences>
Trade-offs:
- <bullet>
- <bullet>
Complexity: small|medium|large
Risk: low|medium|high

## Recommended: Variant N
<rationale: which variant best fits o2b's "plain Markdown you own, deterministic, default-off, fail-open, no-LLM-kernel, one-PR-suite" conventions, and how it keeps the 6 cards non-conflicting on the shared branch.>
