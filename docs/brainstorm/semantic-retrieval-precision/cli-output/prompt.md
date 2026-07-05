# Architecture consultation - semantic-retrieval-precision

You are a senior software architect advising on the design of a focused 2-card feature scope
for an existing TypeScript project. Produce **exactly 3 distinct architectural variants** and
then **exactly one recommendation**. Variants and recommendation only - no code, nothing
outside those sections.

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

- **Name**: Open Second Brain (package `open-second-brain`, v1.22.0).
- **Language/runtime**: TypeScript (strict), runs on Bun. Obsidian-native second-brain memory
  layer for AI agents. Plain Markdown vault under `Brain/`. Ships a deterministic CLI (`o2b`),
  an MCP server, and native plugins (Hermes/Claude Code/Codex/OpenClaw/opencode/Grok).
- **Invariants you MUST honor** (load-bearing conventions; violating any breaks the release):
  1. **The kernel calls no LLM.** Every decision in search/recall/ranking/entity logic is
     deterministic. Optional learned-model surfaces (cross-encoder rerank, an embedding provider
     for candidate scoring) are external service calls, not in-kernel models - they must be
     opt-in and a graceful no-op / fail-open when unconfigured.
  2. **Default-off switches are bit-identical to today.** Any ranking/score/output change must
     produce byte-identical results when the new path is off. The easiest property to verify is
     a single guarded call site whose off-branch is unchanged, and optional fields absent by
     default rather than present-with-empty.
  3. **Telemetry is fail-open** via `emitGatedTelemetry` - never throws into the hot path.
  4. **Language-agnostic.** No hardcoded natural-language word lists (stopwords, keywords,
     negations, company-suffix stripping) in any language. Use structural signals, frontmatter
     fields, corpus document frequency / IDF, or explicit agent/LLM extraction.
  5. **Syncthing-peer determinism.** Anything written to the vault is deterministic across
     machines (stable sort keys, stable slugs, no wall-clock-only tiebreaks).
  6. **One release = one PR = many cards, driven ONE AT A TIME on a shared branch.** Each card
     builds on commits the previous cards already landed. Non-conflict is achieved by ordering
     the real collision pairs so the later card extends an already-merged seam.
  7. **Markdown-first / file-first persistence.** New durable state is plain `.md` / `.json`
     under `Brain/`, never a hidden black box; a registered provider profile stores env-key
     NAMES only, never secret values.
  8. **Proposal-only writes that touch identity.** Anything that could collapse two distinct
     records (entity alias-merge, fact conflict resolution) must SURFACE candidates and never
     silently rewrite; the deterministic core owns the actual merge.
- **Engineering rules**: SOLID / KISS / DRY; no misleading fallbacks (a lexical heuristic must
  never be passed off as semantic - it must be labeled with its `method`); no hardcoding;
  English-only strings in code while logic stays abstract/multi-language.

## Scope: this release ships exactly TWO cards together on one shared branch
`feat/semantic-retrieval-precision`, driven one at a time. This scope completes the previously
half-shipped retrieval-precision-quality-loop: Card A (cross-encoder rerank) was deferred from
v1.22.0 because its dependency (semantic entity dedup) was out of scope then. Both remaining p4
cards are dependency-closed now and share the same upstream provenance and direction: learned-model
retrieval precision that PRESERVES the deterministic core by being opt-in / proposal-only.

### Card 1 (parent) - t_47fd9523 - Semantic (embedding cosine) entity dedup

OSB's entity dedup is purely deterministic string-normalization: `normalizeEntityName` (NFC,
lowercase, collapse whitespace) + `entityIdentityKey` (`<category>:<name>`) in
`src/core/brain/entities/canonical.ts`. Add an OPTIONAL semantic dedup pass (embedding cosine
similarity) that surfaces lexical variants the deterministic key cannot catch (e.g. "Google LLC"
vs "Google Inc", "OpenAI" vs "Open AI") as alias-merge CANDIDATES, plus optional identity_type
tagging and evolution-chain tracking.

- **Why useful**: OSB ingests entities from multiple sources/agents that name the same
  real-world entity differently; the deterministic key silently treats these as distinct records,
  fragmenting the knowledge graph. A cosine-similarity candidate pass (surfaced to doctor lints /
  registry alias resolution, NOT auto-merged) would catch these near-duplicates while preserving
  OSB's deterministic, LLM-free, audit-friendly core (semantic step is opt-in and only proposes,
  never silently rewrites).
- **Constraint**: keep semantic merge opt-in and proposal-only to preserve deterministic-core
  guarantees; reuse the EXISTING embedding provider
  (`src/core/search/embeddings/local-provider.ts`, `openai-compat.ts`, the `provider.ts`
  abstraction and `registry.ts`) rather than a new dependency.
- **Existing seams that already do adjacent work**: `src/core/brain/hygiene/detectors/dedup.ts`
  ALREADY runs an embedding-cosine layer over PREFERENCES (threshold 0.97) with a clearly-labeled
  `method: "lexical"` jaccard fallback, and only nominates pairs (merging happens through the
  hygiene apply plan). That detector is the proven pattern to mirror for ENTITIES. The canonical
  kernel (`canonical.ts`) is consumed by the registry duplicate-refusal/alias resolution
  (`registry.ts`), doctor lints, search alias expansion (`entity-alias.ts`), and the
  fact-extraction router.

### Card 2 (child) - t_110867f5 - Optional pluggable cross-encoder rerank stage

OSB has hybrid search (rank-fusion of semantic + keyword in `src/core/search/fusion.ts`, scored
in `ranker.ts`) and several HEURISTIC rerank stages (relevance rerank `enrich.ts:130`
`rerankByRelevance`, entity-match boost, MMR diversity `mmr.ts`, usage/activation decay) but no
learned cross-encoder re-scoring pass. Add an OPTIONAL, opt-in cross-encoder rerank stage
(OpenAI-compatible / pluggable endpoint) that re-scores the top-K fused candidates as a final
reader step.

- **Why useful**: a learned cross-encoder re-ranks query/document pairs jointly, improving
  precision-at-top beyond what heuristic scoring achieves - most valuable for the "thorough"
  search profile where recall quality matters most. Making it opt-in and endpoint-pluggable keeps
  OSB's deterministic core intact (default behavior unchanged when no rerank endpoint is
  configured).
- **Constraint**: mirror the EXISTING embedding-provider config pattern (key + endpoint + env-key
  registry, graceful no-op when unset) so the stage is zero-cost when disabled. On endpoint error
  it degrades gracefully to the heuristic-ordered input and logs via `emitGatedTelemetry`
  (fail-open), never throwing into the hot path.
- **Where it lands**: the reader tail in `src/core/search/search.ts` (~lines 838-846), appended
  AFTER the existing heuristic reranks (MMR `mmrRerank`, then `rerankByRelevance`), as an isolated
  final stage. Config resolves through `resolveSearchConfig` in `src/core/search/index.ts`.

### Dependency between the two cards
t_110867f5 is the CHILD of t_47fd9523 (the parent's semantic-dedup pass establishes the
"learned-model retrieval precision that stays opt-in/proposal-only" seam and the provider-reuse
pattern; the child's cross-encoder re-uses the same provider-abstraction discipline). Drive order
is PARENT then CHILD: t_47fd9523 -> t_110867f5.

## Task bodies (verbatim)

### t_47fd9523 (parent)
[upstream:HyAtlas-Memory] Add semantic (embedding cosine) entity dedup to complement
deterministic identity keys.
- Source: HyAtlas-Memory v2.0.0. OSB's entity dedup is purely deterministic string-normalization.
  Add an optional semantic dedup pass (embedding cosine similarity) surfacing lexical variants as
  alias-merge candidates, plus optional identity_type tagging and evolution-chain tracking.
- Verdict in OSB: present_weaker. Codegraph hints: `src/core/brain/entities/canonical.ts`
  (normalizeEntityName, entityIdentityKey - deterministic-only; consumed by registry
  duplicate-refusal/alias resolution, doctor lints, search alias expansion, fact-extraction
  router). No cosine/embedding-similarity dedup path - not found; OSB dedup is
  string-normalization only.
- Notes: keep semantic merge opt-in and proposal-only to preserve deterministic-core guarantees;
  reuse the existing embedding provider rather than a new dependency.

### t_110867f5 (child)
[upstream:HyAtlas-Memory] Optional pluggable cross-encoder rerank stage for the search reader.
- Source: HyAtlas-Memory v2.0.0. OSB has hybrid search + heuristic reranks but no learned
  cross-encoder re-scoring. Add an optional, opt-in cross-encoder rerank stage
  (OpenAI-compatible / pluggable endpoint) that re-scores the top-K fused candidates as a final
  reader step.
- Verdict in OSB: present_weaker. Codegraph hints: hybrid/fusion at `src/core/search/fusion.ts`,
  `src/core/search/ranker.ts`, `src/core/search/types.ts`; heuristic reranks at
  `src/core/search/enrich.ts` (rerankByRelevance), `entities.ts`, `mmr.ts`, `activation/decay.ts`.
  No learned/cross-encoder rerank model - not found; all rerank is heuristic.
- Notes: mirror the existing embedding-provider config pattern (key + endpoint, graceful no-op
  when unset) so the stage is zero-cost when disabled.

## Recent git log (for cadence and seam conventions)

```
b8d709e fix: keep full MCP status output and normalize codegraph paths (#116)
a98bed1 feat(brain): retrieval precision and quality loop (v1.22.0) (#118)
4281605 feat(brain): integrity & safety hardening suite (1.21.0) (#115)
33b4fba feat: recall precision, coverage, and provenance hardening (v1.18.0) (#110)
35b824e feat: Recall & Working-Memory Quality Suite (v1.10.0) (#99)
```

Each suite lands as ONE PR with many cards driven one at a time on a shared branch; the prior
`retrieval-precision-quality-loop` suite (v1.22.0, #118) shipped 5 cards and EXPLICITLY deferred
the cross-encoder card (t_110867f5) as Card A because its parent (semantic entity dedup,
t_47fd9523) was out of scope. This scope completes that half-shipped loop.

## Related files / proven patterns to reuse (not duplicate)

- `src/core/brain/entities/canonical.ts` - the ONE place entity identity is computed
  (`normalizeEntityName`, `entityIdentityKey`); consumed by registry, doctor, search alias,
  fact-extraction. The semantic-dedup pass must NOT alter the deterministic key - it proposes
  candidates that feed INTO alias resolution.
- `src/core/brain/entities/registry.ts` - canonical entity registry; `upsertEntity` resolves
  through names AND aliases before creating, refuses duplicates at the write seam; doctor lints
  catch hand-edited/sync duplicates. Candidate-merge proposals surface here.
- `src/core/brain/hygiene/detectors/dedup.ts` - the PROVEN pattern: embedding-cosine layer over
  preferences (threshold 0.97) + clearly-labeled `method: "lexical"` jaccard fallback; nominates
  pairs only, merging via the hygiene apply plan. Card 1 mirrors this for ENTITIES.
- `src/core/search/embeddings/provider.ts` - the `EmbeddingProvider` abstraction (`makeProvider`).
- `src/core/search/embeddings/local-provider.ts` - dependency-free deterministic hashing-trick
  embedder; the privacy-first no-cloud path.
- `src/core/search/embeddings/openai-compat.ts` - OpenAI-compatible `/v1/embeddings` provider with
  retry/timeout/semaphore; the recommended provider for semantic depth. Its config-validation
  (fail-closed when enabled-but-missing base_url/model/key) is the pattern for the cross-encoder.
- `src/core/search/embeddings/registry.ts` - named-provider registry persisted to
  `Brain/search/embedding-providers.json` (env-key NAMES only, fail-soft load, sorted on write).
- `src/core/search/fusion.ts` - rank-fusion (linear + RRF); the cross-encoder runs AFTER fusion.
- `src/core/search/ranker.ts` - pure scoring function; heuristic reranks compose after it.
- `src/core/search/enrich.ts` - `rerankByRelevance` (deterministic, stable); the cross-encoder
  appends after it in the reader tail.
- `src/core/search/search.ts` - the reader tail (~838-846): MMR, then relevance rerank, then
  property/visibility/agent-scope filters. The cross-encoder is a new isolated final stage here.
- `src/core/search/index.ts` - `resolveSearchConfig` (config + env + validation); the single place
  new `search_rerank_*` keys resolve.

## Constraints & conventions to weigh in the variants

- Both cards must be default-off with byte-identical off-branches (invariant #2). The parent's
  semantic-dedup pass must be PROPOSAL-ONLY (invariant #8): it surfaces alias-merge candidates to
  doctor lints / registry alias resolution and never silently rewrites identity. The child's
  cross-encoder is a graceful no-op when unconfigured and fail-open on endpoint error.
- Reuse, do not duplicate: the embedding-provider abstraction and the hygiene-detector dedup
  pattern are proven. A new embedding dependency or a parallel provider registry that diverges
  from `registry.ts` would violate DRY and the established file-first registry discipline.
- The two cards share a collision surface: BOTH touch the "learned model as an opt-in,
  proposal/no-op layer over the deterministic core" pattern and BOTH reuse the embedding-provider
  abstraction. The variants must address how to order/structure them so the child extends the
  parent's already-merged seam rather than colliding (e.g. parent establishes an entity-candidate
  module + provider-reuse helper; child adds a search-rerank module that reuses the same
  provider-validation discipline).
- Language-agnostic (invariant #4): the semantic-dedup cosine uses the embedder, NOT a
  company-suffix / legal-form word list. identity_type tagging must derive from frontmatter /
  structural signals, not NL keywords.

Now produce the three variants and the single recommendation.
