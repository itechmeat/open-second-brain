# Recall & Ranking Suite - brainstorm variants (audit trail)

Primary consultant: Claude Code CLI (`claude -p`), exit 0, 3 parseable variants.
Fallback (Codex) not run - primary succeeded.
Prompt: `cli-output/prompt.md`. Raw output: `cli-output/claude.md`.

## Variants produced by the consultant (verbatim)

### Variant 1: Localized pure-function extensions + cache wrapper
- **Approach**: Each feature lands as a self-contained change in the module that already owns its concern - Weibull replaces `recencyBoost` in `ranker.ts`, intent classification is a small pure function whose output is a set of weight multipliers consumed inside `rankResults`, synonym expansion augments the FTS candidate set (extra terms -> extra candidates merged before hydrate), and the cache is a thin memoizing wrapper around `search()`. Budgeting (per-memory cap, total cap) is extracted once into a shared `budget` helper reused by `context-pack.ts` and the new `brain_pre_compress_pack`. Corpus generation is read from `index_state` and folded into the cache key.
- **Trade-offs**:
  - Pro: smallest diff, each feature maps to one module -> clean per-commit TDD and trivial no-op gating.
  - Pro: lowest blast radius on the determinism contract; ranker stays pure, only its inputs change.
  - Pro: cache + generation gate is one wrapper, easy to disable wholesale.
  - Con: intent classification and synonym expansion both re-derive the same query signals (entities, quoted phrases, wildcards) independently -> duplicated structural parsing.
  - Con: weight modulation is spread between the classifier and `rankResults`, so "how intent changes ranking" is not in one readable place.
- **Complexity**: small
- **Risk**: low

### Variant 2: Dedicated query-analysis layer (`QueryPlan`)
- **Approach**: Introduce one upstream pure stage that runs before candidate retrieval and produces a `QueryPlan` { intent, expandedTerms, weightProfile } from a single structural pass over the query (reusing `extractEntities`, quote/wildcard/wikilink/digit detection). Features 2 and 6 both read from this shared analysis; the `weightProfile` is threaded into `rankResults` (which keeps Weibull recency as a pure config-driven curve), and `expandedTerms` feed candidate augmentation. The cache sits in front of `search()` keyed by `(normalizedQuery, scope, QueryPlan-hash, corpusGeneration)`; budgeting is a shared primitive consumed by `context-pack` and `pre_compress_pack`.
- **Trade-offs**:
  - Pro: the two language-agnostic features share one signal-extraction seam, so the structural-only constraint is enforced in exactly one auditable place.
  - Pro: "how intent reshapes ranking" lives in one `weightProfile`, and the plan is a clean injectable test fixture (deterministic, no I/O).
  - Pro: cache key naturally incorporates the plan + generation, making invalidation coherent rather than bolted-on.
  - Con: introduces a new orchestration object threaded through `search()` - more upfront design than Variant 1.
  - Con: per-feature commits must land the `QueryPlan` skeleton first, so the first commit is slightly larger / shared across later features.
- **Complexity**: medium
- **Risk**: medium

### Variant 3: Composable pipeline-stage middleware
- **Approach**: Refactor `search.ts` into an ordered list of stages implementing a common `Stage` interface (retrieve -> expand -> rank -> traverse -> diversify -> filter -> scope -> slice), with intent, expansion, cache, and budgeting each registered as pluggable, individually toggleable stages. Generation tracking becomes a cache-stage dependency; budgeting becomes a terminal stage shared with the pack tools via the same stage contract.
- **Trade-offs**:
  - Pro: maximally extensible; future recall layers slot in without touching the orchestrator.
  - Pro: uniform enable/disable and ordering semantics across all stages.
  - Con: large refactor of an already-shipped, determinism-critical pipeline -> high regression risk against the byte-identical Syncthing contract.
  - Con: over-abstracts for 8 features; the stage interface must accommodate very different shapes (pure rank vs. I/O cache vs. budget trim), leaking abstractions.
  - Con: hardest to land incrementally under per-feature TDD; the framework must precede any feature.
- **Complexity**: large
- **Risk**: high

### Consultant recommendation: Variant 2
**Rationale**: The hard language-agnostic constraint couples features 2 and 6 to the same structural signals, so computing them once in a `QueryPlan` removes duplication and gives a single place to audit that no language tables crept in. It keeps the ranker pure and Weibull config-driven while centralizing weight modulation, and the plan-hash + corpus-generation cache key makes feature 5/7 invalidation coherent - without the regression risk of rewriting the shipped, determinism-bound pipeline that Variant 3 demands.

## Orchestrator decision: Variant 2, adopted (with one pragmatic graft from Variant 1)

I agree with the consultant. Variant 2 is the right backbone: a single pure `QueryPlan`
seam is the only honest way to satisfy the non-negotiable language-agnostic constraint for
both intent classification and synonym expansion while keeping the audit surface to one file.
It preserves the determinism-bound, already-shipped pipeline (rejecting Variant 3's high-risk
rewrite) and avoids the duplicated structural parsing of Variant 1.

One graft from Variant 1, which the consultant's own text already endorses: **Weibull recency
decay stays a localized pure replacement inside `ranker.ts`/config and is NOT routed through
`QueryPlan`** - recency does not depend on query analysis, so threading it through the plan
would be artificial coupling.

One concrete decision the consultant left open: **the query cache is persistent
(SQLite-backed, new `query_cache` table, additive migration v4) with a TTL and a
`corpus_generation` column**, not in-memory. Rationale: the `o2b` CLI runs a fresh process per
invocation, so an in-memory cache would never hit there; a persistent cache also makes feature
7 (corpus-generation invalidation) load-bearing rather than decorative. The cache is transparent
(a hit must be byte-identical to a fresh compute - asserted by test) and lives only in the local
`.db` index, which is not Syncthing-replicated, so it does not touch the determinism contract.
