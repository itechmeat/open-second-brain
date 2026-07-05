# Plan - semantic-retrieval-precision

Branch: `feat/semantic-retrieval-precision`
Slug: `semantic-retrieval-precision`
Combined design: `docs/brainstorm/semantic-retrieval-precision/design.md`
Drive order: **parent → child** (`t_47fd9523` → `t_110867f5`) in dependency order; the parent
lands a thin provider-resolution/no-op helper that the child reuses. Cards are driven ONE AT A
TIME on the shared branch. Each worker builds on the commits the previously-driven in-scope
cards already landed and must not duplicate or conflict with sibling tasks.

Global conventions for every card:

- TDD: write the failing test first, then implement until it passes. Run `bun run validate`
  (typecheck + lint + test) before claiming the card done.
- Default-off switch per card (one config key), off-branch byte-identical to today.
- Telemetry via `emitGatedTelemetry`, fail-open.
- Kernel calls no LLM. Both the semantic-dedup cosine and the cross-encoder reuse the existing
  embedding-provider abstraction / an external endpoint, and are graceful no-ops when unconfigured.
- No TypeScript cast crutches; build correct shapes with conditional spreads / narrowing.
- English-only strings in code; logic is language-agnostic (no hardcoded NL word lists).
- Proposal-only for identity-affecting writes (parent): surfaces candidates, never silently
  rewrites the deterministic `entityIdentityKey`.

In-scope cards shipping together in this one release:

| id | card | one-line title |
|---|---|---|
| `t_47fd9523` | parent | Semantic (embedding cosine) entity dedup surfacing lexical variants as alias-merge candidates |
| `t_110867f5` | child | Optional pluggable cross-encoder rerank stage for the search reader |

---

## parent (t_47fd9523) - Semantic (embedding cosine) entity dedup

### Files
- `src/core/brain/entities/semantic-dedup.ts` - the entity semantic-dedup pass modeled on
  `src/core/brain/hygiene/detectors/dedup.ts`: an embedding-cosine layer over the canonical entity
  registry (configurable threshold, default high to surface only near-duplicates) plus a
  clearly-labeled `method: "lexical"` fallback (the shared `findMergeCandidates` jaccard detector
  over entity names) when vectors are unavailable. NOMINATES alias-merge candidate pairs only —
  never rewrites `entityIdentityKey` in `canonical.ts`.
- optional helpers for `identity_type` tagging (derived from frontmatter / structural signals,
  not NL keywords) and evolution-chain tracking of alias-merge history.
- a thin provider-resolution/no-op helper (e.g.
  `src/core/search/embeddings/provider-resolve.ts`) mirroring `openai-compat.ts`
  fail-closed-validation + graceful-no-op discipline — THIS IS THE SEAM THE CHILD REUSES.
- default-off config keys (`entity_semantic_dedup_*`: enabled, threshold, lexical_threshold) via
  the existing config path.
- candidate surfacing wired into doctor lints / `registry.ts` alias resolution behind the feature
  flag.
- tests under the module's sibling `.test.ts` (follow repo convention).

### Acceptance (a passing test)
- Disabled (default): the canonical registry, doctor lints, and search behavior are byte-identical
  to the pre-feature baseline; no candidate is emitted.
- Enabled + embedding provider available: two entities with the same deterministic key as nothing
  but lexical variants ("Google LLC" vs "Google Inc") are surfaced as an alias-merge CANDIDATE
  pair with `method: "embedding"`; the deterministic `entityIdentityKey` is NOT rewritten (assert
  the key is unchanged after the pass).
- Enabled + no vectors available: the lexical fallback surfaces a candidate pair with
  `method: "lexical"` — clearly labeled, never passed off as semantic.
- Proposal-only: a candidate never auto-merges; it only feeds into the existing doctor-lint /
  registry alias-resolution seam (assert no entity file is rewritten by the pass).
- `identity_type` (when present) derives from frontmatter/structural signals, not NL keywords;
  absent by default.
- Cosine ranking / candidate emission is deterministic across two runs on the same registry
  (Syncthing-peer safe; stable sort keys, no wall-clock-only tiebreaks).

### Depends on
- None. Lands first (establishes the provider-resolution/no-op helper seam + the entity
  candidate-surfacing pattern). Must not touch the deterministic `canonical.ts` key computation,
  the search reader tail, or any `src/core/search/rerank/*` path.

---

## child (t_110867f5) - Optional pluggable cross-encoder rerank stage

### Files
- `src/core/search/rerank/cross-encoder.ts` - the rerank provider (OpenAI-compatible endpoint:
  base_url + model + env-resolved api key, re-scores top-K query/doc pairs). Mirrors
  `openai-compat.ts` fail-closed-validation + retry/timeout discipline; REUSES the parent's
  provider-resolution helper (do not re-implement provider resolution).
- config keys threaded through `resolveSearchConfig` in `src/core/search/index.ts`:
  `search_rerank_enabled` (default false), `search_rerank_model`, `search_rerank_base_url`,
  `search_rerank_env_key`, `search_rerank_top_k`, `search_rerank_min_score`, with env parity +
  validation.
- one guarded call site in the reader tail of `src/core/search/search.ts` (appended AFTER the
  existing heuristic reranks — after `mmrRerank` and `rerankByRelevance`, ~lines 838-846).
- tests under the module's sibling `.test.ts`.

### Acceptance (a passing test)
- Disabled (default): the reader tail output is byte-identical to the pre-feature baseline for the
  same query/results (snapshot/diff equality asserted in a test).
- Enabled + endpoint unconfigured: validation fails closed with a clear error (mirrors
  `openai-compat.ts` when semantic is enabled without base_url/model).
- Enabled + endpoint returns scores: top-K are re-ordered by the cross-encoder scores; a doc the
  heuristic ranker placed 3rd but the cross-encoder scored highest lands 1st.
- Enabled + endpoint errors: stage degrades to the heuristic-ordered input (no throw into the hot
  path) and emits one fail-open telemetry record via `emitGatedTelemetry`.

### Depends on
- parent `t_47fd9523` landed (so the provider-resolution/no-op helper seam exists and the branch
  is stable at the search reader tail). Must not touch `brain/entities`, `canonical.ts`,
  `brain/hygiene`, or any vault persistence — pure search-side, no vault writes.
