# Design - semantic-retrieval-precision

Branch: `feat/semantic-retrieval-precision`
Slug: `semantic-retrieval-precision`
Cards: parent `t_47fd9523` (semantic entity dedup), child `t_110867f5` (cross-encoder rerank)

## Problem

The v1.22.0 `retrieval-precision-quality-loop` suite shipped five cards but explicitly deferred
Card A (cross-encoder rerank, `t_110867f5`) because its parent — semantic entity dedup
(`t_47fd9523`) — was out of scope. This release completes that half-shipped loop by landing the
two remaining p4 cards from the same upstream (HyAtlas-Memory), one direction: learned-model
retrieval precision that PRESERVES OSB's deterministic core by being opt-in / proposal-only.

Two concrete gaps remain:

1. **Entity identity is purely lexical.** OSB's entity dedup is deterministic
   string-normalization only: `normalizeEntityName` (NFC, lowercase, collapse whitespace) +
   `entityIdentityKey` (`<category>:<name>`) in `src/core/brain/entities/canonical.ts`. OSB
   ingests entities from multiple sources and agents that name the same real-world entity
   differently ("Google LLC" vs "Google Inc", "OpenAI" vs "Open AI"); the deterministic key
   silently treats these as distinct records, fragmenting the knowledge graph. No cosine /
   embedding-similarity dedup path exists, so near-duplicate entities are never surfaced.
2. **No learned re-scoring pass in search.** OSB has hybrid rank-fusion (`fusion.ts` scored in
   `ranker.ts`) and several heuristic rerank stages (relevance `enrich.ts`, entity boost, MMR
   `mmr.ts`, usage/activation decay) but no learned cross-encoder that jointly re-scores
   query/document pairs. Precision-at-top is therefore bounded by what lexical + cosine
   heuristics can express — most keenly on the "thorough" search profile where recall quality
   matters most.

## Scope

Both cards ship in this release, driven one at a time on the shared branch in dependency order so
the child extends an already-merged seam rather than colliding:

- **parent** `t_47fd9523` - optional, opt-in semantic (embedding cosine) entity dedup that
  surfaces lexical variants as alias-merge CANDIDATES (into doctor lints / registry alias
  resolution), never silently rewriting the deterministic identity key; optional `identity_type`
  tagging and evolution-chain tracking. Mirrors the proven
  `src/core/brain/hygiene/detectors/dedup.ts` pattern (cosine layer + clearly-labeled lexical
  fallback, nominates pairs only) for ENTITIES.
- **child** `t_110867f5` - optional, opt-in cross-encoder rerank stage (OpenAI-compatible /
  pluggable endpoint) that re-scores the top-K fused candidates as a final reader step, appended
  after the existing heuristic reranks in `search.ts`. Mirrors the `openai-compat.ts`
  fail-closed-validation + graceful-no-op pattern.

**Drive order:** parent → child (`t_47fd9523` → `t_110867f5`). The parent establishes a thin
provider-resolution/no-op helper that the child reuses; their substantive edits live in different
subtrees (`brain/entities` + `brain/hygiene` vs `search`) and never overlap.

## Out of scope

- A learned model living inside the kernel. The semantic-dedup cosine uses the existing embedding
  provider; the cross-encoder is an opt-in external service call. Both are graceful no-ops when
  unconfigured and the kernel still calls no LLM.
- Any change to default ranking/score/output when a feature is off. Each card is a single guarded
  call site whose off-branch is byte-identical to today.
- Auto-merging entities. The semantic-dedup pass is PROPOSAL-ONLY: it surfaces alias-merge
  candidates; the deterministic core (registry `upsertEntity` alias resolution + doctor lints)
  owns the actual merge, preserving audit-friendliness.
- Company-suffix / legal-form stripping or any natural-language word list for entity similarity.
  The cosine uses the embedder; `identity_type` derives from frontmatter / structural signals
  only (language-agnostic, invariant #4).
- A new embedding dependency or a parallel provider registry that diverges from
  `embeddings/registry.ts`. The existing `EmbeddingProvider` abstraction is reused.
- A web dashboard. New surfaces ship as CLI / MCP readers or plain Markdown / JSON under `Brain/`.
- The other (already-shipped) cards of the `retrieval-precision-quality-loop` suite.

## Chosen approach

**Variant 2 - each card independently mirrors an already-proven pattern and touches a different
subtree, sharing only one small new seam (a thin provider-resolution/no-op helper the parent lands
and the child extends).**

Both cards default-off with byte-identical off-branches (a single guarded call site each — the
easiest property to verify per invariant #2). The parent's semantic-dedup pass is proposal-only
(invariant #8): it feeds alias-merge candidates into doctor lints / registry alias resolution and
never touches the deterministic `entityIdentityKey`. The child's cross-encoder is a graceful
no-op when unconfigured and fail-open on endpoint error. This is the only variant whose collision
structure is resolved by the cheapest sufficient mechanism — the parent lands a small helper as its
seam and the child extends the already-merged helper, while their substantive edits never overlap —
so the one-PR-many-cards-one-at-a-time cadence holds without a premature super-abstraction
(Variant 1) or a shared persisted registry schema that both cards must edit (Variant 3).

- **parent → helper**: the parent extracts a thin provider-resolution/no-op guard (mirroring
  `openai-compat.ts` validation discipline) while landing the entity semantic-dedup detector.
- **child → helper**: the child's cross-encoder imports the parent's helper for its
  provider-resolution, then adds its isolated final reader stage.

Telemetry on the child routes through `emitGatedTelemetry` and stays fail-open. The kernel calls
no LLM.

## Design decisions

### parent (t_47fd9523) - semantic entity dedup (proposal-only candidate surfacing)

A new entity semantic-dedup pass modeled directly on the proven
`src/core/brain/hygiene/detectors/dedup.ts`: an embedding-cosine layer over the canonical entity
registry (configurable threshold, default high to surface only near-duplicates) with a
clearly-labeled `method: "lexical"` fallback (the shared `findMergeCandidates` jaccard detector
over entity names) when vectors are unavailable. It NOMINATES alias-merge candidate pairs only —
never rewrites the deterministic `entityIdentityKey` in `canonical.ts`. Candidates surface into the
existing doctor-lint / registry alias-resolution seam (`registry.ts` `upsertEntity` already resolves
through names AND aliases), so a human-or-apply plan decides the merge, preserving audit-friendliness.

Optional `identity_type` tagging (e.g. person / org / concept / product) is derived from
frontmatter / structural signals, NOT a natural-language word list — language-agnostic by
construction (invariant #4). Optional evolution-chain tracking records the alias-merge history so
a later operator can see how a name evolved. Reuses the EXISTING embedding provider
(`local-provider.ts` / `openai-compat.ts` via `makeProvider`) rather than a new dependency. While
landing this, the parent extracts a thin provider-resolution/no-op helper (mirroring
`openai-compat.ts`'s fail-closed-validation + graceful-no-op discipline) that the child reuses.

Config surface resolves through the existing config path with default-off keys
(`entity_semantic_dedup_*`); the detector is off by default, so registry/search behavior is
byte-identical until opted in.

### child (t_110867f5) - cross-encoder rerank (search-side, no vault writes)

A `rerank/` module under `src/core/search` with an OpenAI-compatible cross-encoder provider
(base_url + model + env-resolved api key, re-scoring top-K query/doc pairs), mirroring the
`openai-compat.ts` fail-closed-validation + retry/timeout discipline and reusing the parent's
provider-resolution helper. The stage re-scores the top-K fused candidates as a final reader step
appended after the existing heuristic reranks in `search.ts` (~after `rerankByRelevance`). Config
surface (`search_rerank_*` keys: enabled, model, base_url, env_key, top_k, min_score) resolves
through `resolveSearchConfig` (config + env + validation), and is most valuable on the "thorough"
search profile. When disabled (the default), the stage returns its input unchanged — bit-identical
ordering, zero HTTP cost. On endpoint error it degrades gracefully to the heuristic-ordered input
and logs via `emitGatedTelemetry` (fail-open), never throwing into the hot path.

## File changes (per card, indicative)

- **parent**: new `src/core/brain/entities/semantic-dedup.ts` (cosine + labeled lexical fallback,
  nominates alias-merge candidate pairs); optional `identity_type` derivation + evolution-chain
  tracking helpers; a thin `src/core/search/embeddings/provider-resolve.ts` (or inline helper)
  provider-resolution/no-op guard; default-off config keys threaded through the existing config
  path; candidate surfacing wired into doctor lints / `registry.ts` alias resolution behind a
  feature flag; tests under the module's sibling `.test.ts`.
- **child**: new `src/core/search/rerank/cross-encoder.ts` (the rerank provider: OpenAI-compatible
  endpoint, base_url + model + env-resolved api key, re-scores top-K query/doc pairs); config keys
  `search_rerank_*` via `resolveSearchConfig`; one guarded call site in the reader tail of
  `search.ts` (after `rerankByRelevance`); tests under the module's sibling `.test.ts`.

## Risks

- **Per-card bit-identity (two guarded call sites).** Mitigated by each card having exactly one
  guarded call site whose off-branch returns its input unchanged / emits no candidates; acceptance
  tests assert off-branch output equality against the pre-feature baseline.
- **Semantic-dedup false-positive candidates.** Mitigated by a high default cosine threshold
  (surfacing only near-duplicates) AND proposal-only semantics — a candidate never silently merges;
  the deterministic core + a human/apply plan own the actual merge. The lexical fallback is always
  labeled with its `method` so a report never passes lexical similarity off as semantic.
- **Cross-encoder latency/availability leaking into the hot path.** Mitigated by default-off, a
  strict timeout, and fail-open degradation to heuristic-ordered input on endpoint error; zero HTTP
  cost when unconfigured.
- **Provider-reuse drift between the two cards.** Mitigated by the parent landing the
  provider-resolution helper as its seam and the child extending the already-merged helper (single
  validation-discipline source), rather than each card re-implementing provider resolution.
- **Syncthing-peer determinism (evolution-chain / candidate files).** Mitigated by stable sort
  keys, stable slugs, and deterministic candidate emission (no wall-clock-only tiebreaks) in any
  vault write.
