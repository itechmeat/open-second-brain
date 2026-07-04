# Plan - retrieval-precision-quality-loop

Branch: `feat/retrieval-precision-quality-loop`
Slug: `retrieval-precision-quality-loop`
Combined design: `docs/brainstorm/retrieval-precision-quality-loop/design.md`
Drive order: **A → C → D → E → B** (blast-radius order; each later card extends an already-merged
seam). Cards are driven ONE AT A TIME on the shared branch. Each worker builds on the commits the
previously-driven in-scope cards already landed and must not duplicate or conflict with sibling
tasks.

Global conventions for every card:

- TDD: write the failing test first, then implement until it passes. Run `bun run validate`
  (typecheck + lint + test) before claiming the card done.
- Default-off switch per card (one config key), off-branch byte-identical to today.
- Telemetry via `emitGatedTelemetry`, fail-open.
- Kernel calls no LLM. The cross-encoder (A) is an opt-in external service call.
- No TypeScript cast crutches; build correct shapes with conditional spreads / narrowing.
- English-only strings in code; logic is language-agnostic (no hardcoded NL word lists).

In-scope cards shipping together in this one release:

| id | card | one-line title |
|---|---|---|
| `t_110867f5` | A | Optional pluggable cross-encoder rerank stage for the search reader |
| `t_e163feb2` | C | Epistemic provenance markers on recalled/packed items |
| `t_b8f66fec` | D | Recall adequacy verdict with explicit low-adequacy actions |
| `t_97091fff` | E | Cross-query demand log surfacing queries asked often but recall poorly |
| `t_62363378` | B | Outcome-tagged, recency-scored lessons loop unifying dead-ends and preferences with corroboration tiering |

---

## A (t_110867f5) - Optional pluggable cross-encoder rerank stage

### Files
- `src/core/search/rerank/cross-encoder.ts` - the rerank provider (OpenAI-compatible endpoint:
  base_url + model + env-resolved api key, re-scores top-K query/doc pairs).
- `src/core/search/rerank/registry.ts` - named-provider registry persisted to
  `Brain/search/rerank-providers.json` (env-key NAMES only, fail-soft load), mirroring
  `embeddings/registry.ts`.
- `src/core/search/rerank/provider.ts` - provider interface + built-in/default resolution.
- `src/core/search/rerank/index.ts` - `applyCrossEncoderRerank(results, query, config)` final
  reader step; returns input unchanged when disabled or on endpoint error.
- config keys threaded through `resolveSearchConfig`: `search_rerank_enabled` (default false),
  `search_rerank_model`, `search_rerank_base_url`, `search_rerank_env_key`, `search_rerank_top_k`,
  `search_rerank_min_score`, with env parity + validation.
- one guarded call site in the reader tail (after `enrich.ts` heuristic reranks).
- MCP/CLI exposure for provider registration (mirror the embedding registry CLI verbs).
- tests under the module's sibling `.test.ts` (follow repo convention).

### Acceptance (a passing test)
- Disabled (default): the reader tail output is byte-identical to the pre-feature baseline for
  the same query/results (snapshot/diff equality asserted in a test).
- Enabled + endpoint unconfigured: validation fails closed with a clear error (mirrors
  `openai-compat.ts` when semantic is enabled without base_url/model).
- Enabled + endpoint returns scores: top-K are re-ordered by the cross-encoder scores; a doc the
  heuristic ranker placed 3rd but the cross-encoder scored highest lands 1st.
- Enabled + endpoint errors: stage degrades to the heuristic-ordered input (no throw into the
  hot path) and emits one fail-open telemetry record.

### Depends on
- None. Lands first (pure search-side, no vault writes, lowest blast radius, seeds the
  provider-registry pattern). Must not touch `context-pack.ts`, `context-receipts.ts`, or any
  brain/ persistence.

---

## C (t_e163feb2) - Epistemic provenance markers

### Files
- `src/core/brain/provenance/epistemic-status.ts` - pure derivation:
  `deriveEpistemicStatus(meta)` -> `EpistemicStatus`
  (`observed | derived | hypothesis | plan | unknown`) + `evidence_refs`, from existing graph
  metadata (source-backed vs inferred vs preference/hypothesis vs intended vs gap). Language
  agnostic, no manual tagging.
- optional fields `epistemic_status` and `evidence_refs` added to `ContextPackItem` and the
  recall result type (absent by default).
- derivation wired into `context-pack.ts` and recall result rendering behind a feature flag.
- `src/mcp/brain/*` (or the pack/recall surface) so the field surfaces in
  `brain_context_pack` / `brain_context_receipts` output when enabled.

### Acceptance (a passing test)
- Flag off: `brain_context_pack` and recall output is byte-identical to the pre-feature baseline
  (the new fields are absent, not present-with-empty).
- Flag on: a source-backed note item is tagged `observed` with the source wikilink as
  `evidence_refs`; an inferred/derived-fact item is `derived` with its basis linked; a
  preference-tier item is `hypothesis`; an intended/not-yet-true item is `plan`; an
  acknowledged gap is `unknown`.
- Derivation is deterministic across two runs on the same input (Syncthing-peer safe).

### Depends on
- A landed (so the branch is stable at the reader tail). Establishes the item-shape seam D
  extends. Must not collide with `context-receipts.ts` summary shape beyond adding optional
  fields.

---

## D (t_b8f66fec) - Recall adequacy verdict with explicit low-adequacy actions

### Files
- `src/core/brain/recall/adequacy.ts` - pure verdict:
  `classifyAdequacy(gateScores, coverageReport, epistemicMix, thresholds)` ->
  `{ verdict: sufficient|weak|insufficient, action: proceed|re_recall|abstain|escalate }`.
  Reuses `gate-telemetry` relevance scores, `coverage.ts` IDF-weighted coverage, and C's
  epistemic mix; thresholds configurable.
- verdict + action exposed in `brain_recall_gate` output and `context-receipts` summary.
- `weak` action: trigger an alternate-strategy re-recall (broaden scope / different path) via
  existing recall machinery, behind the feature flag.
- `insufficient` action: abstain signal ("insufficient grounding") and/or escalate flag, behind
  the feature flag.

### Acceptance (a passing test)
- Flag off: `brain_recall_gate` output and `context-receipts` summary are byte-identical to the
  pre-feature baseline.
- Flag on, high-coverage + mostly-`observed` recall: verdict `sufficient`, action `proceed`.
- Flag on, partial coverage / mixed `hypothesis`-heavy recall: verdict `weak`, action `re_recall`
  (one alternate-strategy re-recall fires, deterministic).
- Flag on, near-zero coverage / mostly `unknown`: verdict `insufficient`, action `abstain`
  (explicit "insufficient grounding" signal returned, not a low-confidence answer) and/or
  `escalate`.
- Verdict is deterministic over the same scores.

### Depends on
- C landed (D extends C's merged item shape with the verdict; D reads C's epistemic mix). Reuses
  existing `gate-telemetry.ts` and `coverage.ts` scores - must NOT introduce a new score or a
  separate attention organ (card guardrail).

---

## E (t_97091fff) - Cross-query demand log surfacing weak-recall queries

### Files
- `src/core/brain/recall/demand-log.ts` - append + rotate/cap + redact: each recall appends
  (normalized terms or redacted query form + timestamp + result count + the coverage score
  already computed per query in `coverage.ts`) to a rolling, size-capped
  `Brain/recall/demand-log.jsonl`. Query normalized/redacted before append; log capped/rotated.
- aggregation reader (a `knowledge_gaps`-style read tool / CLI) bucketing by normalized query
  and ranking by frequency x low-satisfaction, reusing the existing coverage score as the
  "answered poorly" axis.
- append wired at the recall seam D opened, behind a feature flag.

### Acceptance (a passing test)
- Flag off: no file is written under `Brain/`, recall path byte-identical to baseline.
- Flag on: three recalls of the same normalized query that each return low coverage produce one
  bucket ranked by frequency x low-satisfaction; a different query asked once with good coverage
  ranks far lower.
- Privacy: the on-disk log contains the normalized/redacted form, never the raw sensitive query
  (asserted by inspecting the written file in the test).
- Size cap: after N appends the oldest entries are rotated out; the file never grows unbounded.
- Aggregation is deterministic across two runs on the same log (Syncthing-peer safe).

### Depends on
- D landed (E appends at the recall seam D opened and reuses the coverage score D surfaces).
  Independent persistence directory `Brain/recall/` - must not share a writer with B's
  `Brain/lessons/`.

---

## B (t_62363378) - Outcome-tagged, recency-scored lessons loop with corroboration tiering

### Files
- `src/core/brain/lessons/outcome-corpus.ts` - unify `dead-ends.ts` (negative) and
  `preference.ts`/`apply-evidence.ts` (positive) into one outcome-tagged corpus
  (`useful | dead_end | corrected`).
- `src/core/brain/lessons/score.ts` - signed recency-decayed score reusing
  `usage-signal.ts` `decayWeight()` (configurable half-life) as the promotion signal.
- `src/core/brain/lessons/digest.ts` - corroboration-gated aggregation: a node is `PREFERRED`
  only once corroborated by >=N distinct results (configurable N), else `TENTATIVE`;
  mixed-signal nodes render `CONTESTED` (recency-wins). Folds the corpus into a single
  `Brain/lessons/LESSONS.md`.
- `active.ts` / `dream-refresh.ts` extension for auto-load (SessionStart) + auto-refresh (dream
  cron) of the digest.
- dream-pass extension (`dream.ts`/`dream-stage.ts`) adding signed + corroboration-gated tiers,
  behind a feature flag.

### Acceptance (a passing test)
- Flag off: dream pass and `active.md` byte-identical to baseline; no `Brain/lessons/` written.
- Flag on: a node corroborated by <N distinct results is `TENTATIVE`; once >=N distinct results
  corroborate it, it promotes to `PREFERRED`; a fresh `dead_end` outcome outweighs a stale
  `useful` on the same node (recency + sign), rendering it `CONTESTED` when mixed.
- A one-off outcome does NOT promote to `PREFERRED` (corroboration threshold prevents it).
- The `LESSONS.md` digest is deterministic across two runs on the same corpus (stable sort keys,
  stable slugs; Syncthing-peer safe).
- Auto-load: the digest surface is reachable via the existing `active.ts`/SessionStart path; no
  git-hook dependency.

### Depends on
- A, C, D, E landed (B is the capstone assembly over a fully-merged branch; it must not force a
  rebase of the recall/telemetry surfaces). Extends the dream pass rather than running a parallel
  aggregation; does not rewrite or delete the source dead-ends/preference notes.
