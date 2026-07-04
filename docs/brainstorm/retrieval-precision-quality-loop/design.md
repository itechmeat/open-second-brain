# Design - retrieval-precision-quality-loop

Branch: `feat/retrieval-precision-quality-loop`
Slug: `retrieval-precision-quality-loop`
Cards: A `t_110867f5`, B `t_62363378`, C `t_e163feb2`, D `t_b8f66fec`, E `t_97091fff`

## Problem

Open Second Brain's recall/search pipeline is rich (hybrid rank-fusion, heuristic reranks,
IDF-weighted coverage, gate telemetry, continuity records, dream-promoted preferences,
dead-ends) but the full quality loop is not yet closed. Five concrete gaps leave recall less
precise, less honest about its own grounding, and less able to turn observed failures into
improvements:

1. **No learned re-scoring pass.** Heuristic reranks (relevance, entity boost, MMR, usage
   decay) order the top-K, but no cross-encoder jointly re-scores query/document pairs, so
   precision-at-top stays bounded by what lexical + cosine heuristics can express.
2. **Context items have no epistemic status.** `brain_context_pack` / `brain_context_receipts`
   emit structured context but the consuming model cannot tell a source-backed fact from a
   conjecture or a plan, so it reasons over all of it with the same confidence.
3. **No adequacy verdict that drives behavior.** Gate telemetry emits scores, but there is no
   classification that says "this recall is too weak to answer from" and then abstains or
   re-recalls; the system hands top-K to the model regardless of fitness.
4. **No cross-query demand signal.** Per-query coverage and structural dangling-link gaps
   exist, but nothing persists or aggregates which queries recur yet consistently answer
   poorly, so the operator never sees the prioritized backlog of "what to write next".
5. **Lessons are split across two registries.** Negative knowledge (dead-ends) and positive
   knowledge (dream-promoted preferences) are separate registries with a coarse confidence
   band and no signed recency-decayed scoring or corroboration gate over a single outcome
   corpus, so a fresh dead-end does not outweigh a stale "useful", and a one-off outcome can
   become a rule.

## Scope

All five cards ship in this release, driven one at a time on the shared branch in blast-radius
order so each later card extends an already-merged seam rather than colliding:

- **A** `t_110867f5` - optional, opt-in cross-encoder rerank stage (OpenAI-compatible / pluggable
  endpoint) re-scoring the top-K fused candidates as a final reader step.
- **C** `t_e163feb2` - epistemic provenance markers (`Observed | Derived | Hypothesis | Plan |
  Unknown` + `evidence_refs`) on each item emitted by `brain_context_pack` and recall results.
- **D** `t_b8f66fec` - recall adequacy verdict (`sufficient | weak | insufficient`) with explicit
  low-adequacy actions (proceed / re-recall / abstain / escalate), a thin layer over existing
  telemetry + coverage scores plus C's epistemic mix.
- **E** `t_97091fff` - persisted cross-query demand log + aggregation reader surfacing queries
  asked often but answered poorly, reusing the existing coverage score as the satisfaction axis.
- **B** `t_62363378` - outcome-tagged, recency-scored lessons loop unifying dead-ends and
  preferences with corroboration tiering, reusing the `usage-signal.ts` decay scorer and the
  dream pass.

**Drive order:** A → C → D → E → B.

## Out of scope

- A learned model living inside the kernel. The cross-encoder is an opt-in external service
  call, graceful no-op when unconfigured; every other decision (adequacy verdict, corroboration
  tier, demand aggregation, epistemic derivation) stays deterministic and LLM-free.
- Any change to default ranking/score/output when a feature is off. Each card is a single
  guarded call site whose off-branch is byte-identical to today.
- A web dashboard. Every new surface ships as CLI / MCP reader or as plain Markdown under
  `Brain/`.
- Manual epistemic tagging. C derives status from existing graph metadata only.
- A separate "attention organ" for adequacy. D is a thin verdict + action layer over what
  already exists, per its own scope guardrail.
- Migrating or rewriting the existing dead-ends or preference registries. B collapses them into
  one outcome-tagged view and extends the dream pass; it does not delete or rewrite the source
  notes.
- HyDE-style generative query rewriting or learned query expansion. D's re-recall uses the
  existing deterministic expansion / alternate-strategy machinery.

## Chosen approach

**Variant 2 - each card a self-contained stage behind its own default-off switch, ordered so the
later card extends an already-merged seam (A → C → D → E → B).**

Every card lands as its own module with its own config key and exactly one guarded call site
whose off-branch is provably bit-identical to today. This is the only variant whose off-branch
state is verifiable the way the project demands (a single guarded call site per card, not a
shared mutable struct or a shared emission bus that turns bit-identity into a whole-subsystem
property). Cross-card collisions are resolved by the cheapest sufficient mechanism - ordering -
rather than by a speculative up-front abstraction:

- **A → heuristic reranks** (both touch the reader tail): A appends after the existing heuristic
  reranks as an isolated final stage; it does not alter them.
- **C → D** (both touch `context-pack.ts` / `context-receipts.ts` output shape): C establishes
  the epistemic field on context items; D extends C's now-merged item shape with the verdict
  instead of colliding on the same files.
- **D → E** (both touch the recall path): D opens the recall seam with its verdict + action
  layer; E appends its demand-log instrumentation at that seam, reusing the coverage score D
  already surfaces.
- **B ↔ E** (both add persistence under `Brain/`): independent directories
  (`Brain/lessons/*` vs `Brain/recall/demand-log*`), no shared writer; B lands last over a
  fully-merged branch so a later shift to the recall/telemetry surfaces never forces a rebase.

Telemetry on every card routes through `emitGatedTelemetry` and stays fail-open. The kernel
calls no LLM.

## Design decisions

### A - cross-encoder rerank (search-side, no vault writes)

Mirror the existing embedding-provider pattern (`src/core/search/embeddings/registry.ts` +
`openai-compat.ts`): a `rerank/` module with a named-provider registry persisted to
`Brain/search/rerank-providers.json` (env-key NAMES only, fail-soft load) and an
OpenAI-compatible rerank provider (base_url + model + env-resolved api key, fail-closed
validation when enabled-but-unconfigured). The stage re-scores the top-K fused candidates as a
final reader step appended after the heuristic reranks. Config surface (`search_rerank_*`
keys: enabled, model, base_url, env_key, top_k, min_score) resolves through
`resolveSearchConfig` (config + env, with validation), and is most valuable on the "thorough"
search profile. When disabled (the default), the stage returns its input unchanged - bit
identical ordering, zero HTTP cost. On endpoint error it degrades gracefully to the
heuristic-ordered input and logs via `emitGatedTelemetry` (fail-open), never throwing into the
hot path.

### C - epistemic provenance (read-time derivation, optional fields)

A pure `epistemic-status.ts` under `src/core/brain/provenance/` derives an `EpistemicStatus`
(`observed | derived | hypothesis | plan | unknown`) plus `evidence_refs` from existing graph
metadata: a source-backed note/wikilink -> `observed` (carry the source as evidence_ref); an
inferred/derived fact -> `derived` (link the basis); a preference/hypothesis tier ->
`hypothesis`; an intended/not-yet-true item -> `plan`; an acknowledged gap -> `unknown`. No
manual tagging and no natural-language word lists (language-agnostic by construction). The
fields are added to `ContextPackItem` and recall results as **optional** absent-by-default
fields, so the off-branch (feature flag off) produces byte-identical pack/receipt output. D
reads this status.

### D - adequacy verdict (thin layer over existing scores)

A pure `adequacy.ts` under `src/core/brain/recall/` classifies each recall into
`sufficient | weak | insufficient` and emits a recommended action
(`proceed | re_recall | abstain | escalate`), reusing the existing `gate-telemetry` relevance
scores, the `coverage.ts` IDF-weighted coverage, and C's epistemic mix (a recall that is mostly
`hypothesis`/`unknown` scores lower fitness than one grounded in `observed` facts). Thresholds
are configurable. The verdict + action are exposed in `brain_recall_gate` output and the
`context-receipts` summary so callers can branch on them. `weak` triggers an alternate-strategy
re-recall (broaden scope / different path) via existing recall machinery; `insufficient`
returns an explicit "insufficient grounding" abstain signal and/or an escalate flag instead of
a low-confidence answer. This honors the card's guardrail: reuse existing telemetry, do NOT
build a separate attention organ.

### E - cross-query demand log (LLM-free, privacy-capped persistence)

A `demand-log.ts` under `src/core/brain/recall/` appends each recall (normalized terms or a
redacted query form + timestamp + result count + the coverage score already computed per query
in `coverage.ts`) to a rolling, size-capped log under `Brain/recall/demand-log.jsonl`.
Privacy/size discipline: queries may contain sensitive text, so the query is normalized/redacted
before append and the log is capped/rotated. An aggregation reader (a `knowledge_gaps`-style
read tool / CLI) buckets by normalized query and ranks by frequency x low-satisfaction,
reusing the existing coverage score as the "answered poorly" axis rather than inventing a new
metric. Appends at the recall seam D has already opened. Deterministic across Syncthing peers.

### B - outcome-tagged lessons loop (assembly over existing primitives)

A `lessons/` module under `src/core/brain/` unifies `dead-ends.ts` (negative outcomes) and
`preference.ts`/`apply-evidence.ts` (positive outcomes) into one outcome-tagged corpus
(`useful | dead_end | corrected`), reusing `usage-signal.ts` `decayWeight()` (configurable
half-life, signed) as the promotion signal with an explicit corroboration threshold: a node is
`PREFERRED` only once corroborated by >=N distinct results, otherwise `TENTATIVE`, with
mixed-signal nodes rendered `CONTESTED` (recency-wins). A deterministic aggregation pass
folds the corpus into a single `Brain/lessons/LESSONS.md` digest that is auto-loaded at session
start (extending the existing `active.ts` / SessionStart-hook surface) and auto-refreshed by
the dream cron (extending `dream-refresh.ts`). This extends the dream pass with signed +
corroboration-gated tiers rather than introducing a parallel loop. It lands last over a
fully-merged branch because it is the heaviest assembly and depends on the recall/telemetry
surfaces not shifting underneath it.

## File changes (per card, indicative)

- **A**: new `src/core/search/rerank/{cross-encoder,registry,provider}.ts`; config keys via
  `resolveSearchConfig`; one guarded call site in the reader tail; MCP/CLI exposure for provider
  registration (mirror embedding registry).
- **C**: new `src/core/brain/provenance/epistemic-status.ts`; optional `epistemic_status` +
  `evidence_refs` fields on `ContextPackItem` and recall result type; derivation wired into
  `context-pack.ts` / recall rendering behind a feature flag.
- **D**: new `src/core/brain/recall/adequacy.ts`; verdict + action added to `brain_recall_gate`
  output and `context-receipts` summary; re-recall trigger and abstain/escalate paths behind a
  feature flag.
- **E**: new `src/core/brain/recall/demand-log.ts` (append + rotate/cap + redact) and an
  aggregation reader (CLI/MCP); append wired at the recall seam behind a feature flag.
- **B**: new `src/core/brain/lessons/{outcome-corpus,score,digest}.ts`; `active.ts` /
  `dream-refresh.ts` extension for auto-load + auto-refresh; corroboration-tiered dream pass
  extension behind a feature flag.

## Risks

- **Per-card bit-identity under shared output shapes (C/D).** Mitigated by landing C before D so
  D extends a merged shape, and by making every new field optional/absent-by-default so the
  off-branch is byte-identical. Acceptance tests assert off-branch output equality.
- **Cross-encoder latency/availability leaking into the hot path (A).** Mitigated by default-off,
  a strict timeout, and fail-open degradation to heuristic-ordered input on endpoint error; zero
  HTTP cost when unconfigured.
- **Demand-log privacy growth (E).** Mitigated by query normalization/redaction before append
  and size cap/rotation; the log is operator-inspectable Markdown/JSONL so it can be audited.
- **Lessons loop double-counting the dream pass (B).** Mitigated by extending the dream pass
  (signed + corroboration-gated) rather than running a parallel aggregation; the corroboration
  threshold (>=N distinct results) prevents one-off outcomes from promoting.
- **Syncthing-peer determinism (B, E).** Mitigated by stable sort keys, stable slugs, and
  deterministic aggregation (no wall-clock-only tiebreaks) in every vault write.
