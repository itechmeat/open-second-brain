# Architecture consultation - retrieval-precision-quality-loop

You are a senior software architect advising on the design of a new feature suite for an
existing TypeScript project. Produce **exactly 3 distinct architectural variants** and then
**exactly one recommendation**. Variants and recommendation only - no code, nothing outside
those sections.

## Output format (follow EXACTLY)

```
## Variant 1
Approach: <2-3 sentences>
Trade-offs:
- <bullet>
Complexity: small | medium | large
Risk: low | medium | high

## Variant 2
Approach: <2-3 sentences>
Trade-offs:
- <bullet>
Complexity: small | medium | large
Risk: low | medium | high

## Variant 3
Approach: <2-3 sentences>
Trade-offs:
- <bullet>
Complexity: small | medium | large
Risk: low | medium | high

## Recommended: Variant N
<rationale - why this variant over the others, in the context of the project conventions below>
```

Do not include code, pseudo-code, or file listings. No preamble, no closing remarks.

## Project

- **Name**: Open Second Brain (package `open-second-brain`, v1.21.0).
- **Language/runtime**: TypeScript (strict), runs on Bun. Obsidian-native second-brain memory
  layer for AI agents. Plain Markdown vault under `Brain/`. Ships a deterministic CLI (`o2b`),
  an MCP server, and native plugins (Hermes/Claude Code/Codex/OpenClaw/opencode/Grok).
- **Invariants you MUST honor** (load-bearing conventions; violating any breaks the release):
  1. **The kernel calls no LLM.** Every decision in search/recall/ranking/lessons logic is
     deterministic. An optional cross-encoder endpoint is an external service call, not an
     in-kernel model - it must be opt-in and a graceful no-op when unconfigured.
  2. **Default-off switches are bit-identical to today.** Any ranking/score/cost change must
     produce byte-identical results when the new path is off. The easiest property to verify is
     a single guarded call site whose off-branch is unchanged.
  3. **Telemetry is fail-open** via `emitGatedTelemetry` - never throws into the hot path.
  4. **Language-agnostic.** No hardcoded natural-language word lists (stopwords, keywords,
     negations) in any language. Use structural signals, frontmatter fields, corpus document
     frequency / IDF, or explicit agent/LLM extraction.
  5. **Syncthing-peer determinism.** Anything written to the vault is deterministic across
     machines (stable sort keys, stable slugs, no wall-clock-only tiebreaks).
  6. **One release = one PR = many cards, driven ONE AT A TIME on a shared branch.** Each card
     builds on commits the previous cards already landed. Non-conflict is achieved by ordering
     the real collision pairs so the later card extends an already-merged seam.
  7. **Markdown-first persistence.** New knowledge (lessons, demand logs) is plain `.md` /
     JSON sidecar under `Brain/` so FTS indexes it and the operator can grep/edit it.
  8. No TypeScript cast crutches (`as unknown as T`). Build correct shapes with conditional
     spreads / narrowing. English-only strings in code; abstract multi-language.

## Release scope: retrieval-precision-quality-loop

Closing the full recall/search quality loop: rank (cross-encoder) -> verify (epistemic
provenance) -> observe (adequacy verdict + cross-query demand log) -> learn (outcome-tagged
lessons loop). Five cards ship together as one PR on branch
`feat/retrieval-precision-quality-loop`, driven one at a time:

### Card A (t_110867f5, p4) - Optional pluggable cross-encoder rerank stage for the search reader
OSB has hybrid search (rank-fusion of semantic + keyword) and several *heuristic* rerank stages
(relevance rerank, entity-match boost, MMR diversity, usage/activation decay) but no learned
cross-encoder re-scoring pass. Add an optional, opt-in cross-encoder rerank stage
(OpenAI-compatible / pluggable endpoint) that re-scores the top-K fused candidates as a final
reader step. Mirror the existing embedding-provider config pattern (key + endpoint, graceful
no-op when unset) so the stage is zero-cost when disabled. Default behavior unchanged when no
rerank endpoint is configured.

### Card B (t_62363378, p4) - Outcome-tagged, recency-scored lessons loop unifying dead-ends and preferences with corroboration tiering
A closed-loop outcome-driven feedback system over one artifact class (saved results/Q&A): an
agent stamps each saved result with an outcome (`useful | dead_end | corrected`), and a
deterministic aggregation pass folds those outcomes into a single `LESSONS` file using a SIGNED,
recency-decayed score (configurable half-life). A node is promoted to PREFERRED only once
corroborated by >=N distinct results, otherwise TENTATIVE, with mixed-signal nodes rendered as
CONTESTED (recency-wins). The lessons file is auto-loaded at session start and auto-refreshed.
**Assembly/integration gap, not from-scratch**: OSB already owns negative knowledge
(`src/core/brain/dead-ends.ts`, bounded active set N=100), positive knowledge (preferences with
confidence band + `retired` state via the dream pass), AND a signed recency-decay scorer
(`src/core/brain/continuity/usage-signal.ts` `decayWeight()`/`rankByUsageDecay()`, exponential
half-life default 30 days). The delta is (1) collapsing the two registries into one
outcome-tagged corpus, (2) reusing usage-signal-style scoring as the promotion signal with an
explicit corroboration threshold, (3) a single auto-loaded/auto-refreshed lessons digest. Watch
for overlap with the existing dream pass (repeat signals -> rules, retire stale) - the
improvement should extend that machinery (signed + corroboration-gated tiers) rather than
introduce a parallel loop. Auto-load maps onto OSB's existing `active.md`/SessionStart-hook
surface and the Hermes cron (dream runs on cron), not git hooks.

### Card C (t_e163feb2, p3) - Epistemic provenance markers on recalled/packed items
Attach an epistemic status (`Observed | Derived | Hypothesis | Plan | Unknown`) + `evidence_refs`
to each item emitted by `brain_context_pack` (and recall results). Today `brain_truth` /
`brain_derive_fact` exist but "derived" means preference keys (`normalizeDerivedKeys`), not an
epistemic status on context items. `evidence_ref` = 0 hits, `epistemic` = 0 hits in src.
`brain_context_pack` / `brain_context_receipts` emit structured context without a per-item
epistemic status. Derive the status from existing graph metadata (source-backed vs inferred vs
preference/hypothesis tiers) - no manual tagging. Lets downstream reasoning (and the
recall-adequacy gate, Card D) distinguish grounded facts from conjecture, cutting confident
fabrication. Pairs with Card D.

### Card D (t_b8f66fec, p3) - Recall adequacy verdict with explicit low-adequacy actions (abstain / re-recall / escalate)
On top of the existing gate telemetry (`brain_recall_gate` + `src/core/brain/gate-telemetry.ts`
emit gate/relevance scores; `brain_recall_telemetry` / `brain_recall_feedback` exist), classify
each recall result (`sufficient | weak | insufficient`) and wire explicit outcomes:
- `sufficient` -> proceed
- `weak` -> automatic re-recall via an alternate strategy (broaden scope / different path)
  before answering
- `insufficient` -> **abstain** (return an explicit "insufficient grounding" signal rather than a
  low-confidence answer) and/or **escalate** (flag for review / surface to operator)
Expose the verdict in `brain_recall_gate` output and `brain_context_receipts` so callers can
branch on it. **Scope guardrail**: reuse existing telemetry scores; thresholds configurable. Do
NOT build a separate "attention organ" - this is a thin verdict + action layer over what already
exists. Complements Card C (that feeds this gate).

### Card E (t_97091fff, p3) - Cross-query demand log surfacing queries that are asked often but recall poorly
Log every recall query against the vault together with a deterministic satisfaction signal
(result count + the IDF-weighted coverage score already computed per query in
`src/core/search/coverage.ts`), then aggregate over time to surface queries that recur
frequently but consistently return weak/empty results. This is a cross-query *demand* signal -
"what do operators keep asking that the Brain can't answer" - distinct from OSB's existing
structural gaps (dangling wikilink targets, `deep-synthesis.ts:407` iterates `report.gaps`) and
from its in-the-moment per-query coverage check (`coverage.ts:141` `planTargetedRetry`, scoped to
the current query, not persisted/aggregated). **Keep it LLM-free and deterministic**: append each
recall to a rolling log under `Brain/` (query text or normalized terms + timestamp + result count
+ coverage score), then provide an aggregation (a `knowledge_gaps`-style read tool / CLI) that
buckets by normalized query and ranks by frequency x low-satisfaction. **Watch privacy/size**:
queries may contain sensitive text - normalize/redact and cap/rotate the log. Reuse the existing
coverage score as the "answered poorly" axis rather than inventing a new metric.

## Key existing files / surfaces (read-only references)

- `src/core/search/fusion.ts` - rank-fusion (`linear` weighted-sum + `rrf` reciprocal-rank),
  min-max-normalised fused relevance on [0,1] composing with downstream boosts.
- `src/core/search/ranker.ts` - primary scorer (BM25 + cosine + intent multipliers + boosts).
- `src/core/search/enrich.ts` - heuristic reranks: `rerankByRelevance` (core textual relevance =
  keyword + semantic lane contributions, ignoring recency/usage/link boosts); `deriveTrust`
  (age_days, superseded, conflict).
- `src/core/search/coverage.ts` - single source of truth for query-term verification:
  `significantTerms` (no stopword list, language-agnostic), `idfForTerm` (smoothed IDF:
  `ln(1 + N/(1+df))`), `isRareTerm`, `buildCoverageReport`, `planTargetedRetry` (deterministic
  follow-up over uncovered RARE terms, pure verdict over an already-built report).
- `src/core/search/embeddings/` - provider pattern to mirror for the cross-encoder:
  - `registry.ts`: named provider profiles persisted to `Brain/search/embedding-providers.json`
    (CLI-added, fail-soft load), stores only env-key NAMES never secret values, safe to sync.
  - `openai-compat.ts`: OpenAI-compatible `/v1/embeddings` provider (base_url + model +
    env-resolved api key, fail-closed validation when semantic enabled, HTTP client with caching).
  - `provider.ts` / `registry.ts`: `expandRegisteredProvider` resolves a registered name to
    `openai-compat` config at config-resolution time, after built-ins.
- `src/core/search/profiles.ts` - search profiles ("thorough" etc.); cross-encoder most valuable
  for the thorough profile where recall quality matters most.
- `src/core/brain/dead-ends.ts` - negative-knowledge class: one `.md` note under
  `Brain/dead-ends/` (approach + why-failed + context), bounded active set N=100, overflow
  archives oldest to `Brain/dead-ends/archive/`. `sanitiseTextField`, `writeFrontmatterAtomic`.
- `src/core/brain/preference.ts` + `src/core/brain/apply-evidence.ts` - positive knowledge:
  signals -> rules via the dream pass, confidence/confidence_value band, `last_evidence_at`,
  `retired` state (`Brain/retired/`).
- `src/core/brain/continuity/usage-signal.ts` - SIGNED recency-decay scorer: `decayWeight()`
  (exponential half-life, `DEFAULT_HALF_LIFE_DAYS = 30`, configurable), frequency gain,
  `rankByUsageDecay()`. Currently over continuity records ranked by recall telemetry, NOT over
  an outcome-tagged corpus.
- `src/core/brain/context-pack.ts` - `packContext()` emits `ContextPackItem[]` with `tier`
  (core/supporting/peripheral), bounded-token vault slice. Each item extends
  `ContextTransformAnnotations`.
- `src/core/brain/context-receipts.ts` - `emitContextReceipt` / `listContextReceipts` /
  `summarizeContextReceipt` over continuity records.
- `src/core/brain/gate-telemetry.ts` - `emitGateTelemetry` (records every automatic-recall gate
  decision as a `gate_telemetry` continuity record; never stores raw prompt, only SHA-256 prefix
  + length; default OFF behind `recall_gate_telemetry` config key).
- `src/core/brain/deep-synthesis.ts` - `report.gaps` iterates dangling-wikilink targets
  (structural gaps only); corroboration concept appears only narratively at line 171.
- `src/core/brain/active.ts` - `Brain/active.md` auto-loaded at session start via SessionStart
  hook; auto-generated by `dream`. (Reusable surface for a lessons digest auto-load.)
- `src/core/brain/dream.ts` / `dream-refresh.ts` / `dream-stage.ts` - the deterministic dream
  pass (repeat signals -> rules, retire stale) that runs on the Hermes cron.

## Git log (last 20, most recent first) - shows the one-PR-themed-suite cadence

```
4281605 feat(brain): integrity & safety hardening suite (1.21.0) (#115)
313d061 feat: configurable skills_dir + trigger-keyword auto-attach scoring (#114)
a3ea315 fix: v1.19.1 - cross-vault cards, event-trace exit codes, registry-guard hygiene (#113)
bb5f320 feat(brain): session-boundary capture durability and post-compaction pinned-anchor survival audit (v1.19.0) (#112)
c5e30b8 fix: cross-vault chain-stop reads the max normalized score (v1.18.1) (#111)
33b4fba feat: recall precision, coverage, and provenance hardening (v1.18.0) (#110)
254b580 feat: codegraph link-graph depth and MCP exposure (v1.17.0) (#108)
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
7cdbfc0 feat: Indexer Durability & Resilience Suite - cooperative abort, graceful watch shutdown, resumable reindex (v1.8.0) (#97)
8b679fe feat: Knowledge Provenance Suite - ingest, research, NER, derived facts, owner-scope, standing-query (v1.7.0) (#96)
6e59a42 feat: Vault Integrity & Trust Suite - untrusted-source containment, NFC identity, watch-sync, O(1) graph, agent-scope (v1.6.0) (#95)
```

## What to design

An architecture that lands all five cards as one themed suite on the shared branch, each behind
its own explicit default-off switch whose off-branch is bit-identical to today, driven one at a
time in a non-conflicting order, honoring every invariant above. Identify the real cross-card
collision points (e.g. Card C and Card D both touch `context-pack.ts`/`context-receipts.ts`
output shape; Card A and the existing heuristic reranks both touch the reader tail;
Cards B/E both add new persistence under `Brain/`; Card D re-uses Card C's status and
`gate-telemetry`/`coverage` scores) and say how each variant resolves them. Weigh: blast radius,
per-card bit-identity verifiability, LLM-free-kernel preservation, reuse of existing
scoring/telemetry/coverage primitives, and fit with the demonstrated multi-card-suite release
cadence.
