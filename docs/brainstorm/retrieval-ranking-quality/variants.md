# Retrieval & Ranking Quality - Architectural Variants

**Status:** draft
**Author:** feature-release-playbook
**Audience:** implementation

This release bundles nine leaf tasks under one theme: make Open Second Brain's
retrieval demonstrably better AND measurable. The tasks span four layers -
embedding-layer robustness, candidate retrieval, reranking, and outcome-learned
ranking signals - plus a named benchmark to score the whole. The question these
variants answer is not "which features" (scope is locked) but **how to structure,
sequence, and integrate them** so nine features land as one coherent release
without destabilizing the core query path.

Three cross-cutting architectures were considered.

---

## Variant 1 - Additive, opt-in, byte-identical-when-off

**Approach.** Each feature ships as a new, independently gated stage or module
that defaults OFF and preserves byte-identical behavior when disabled, matching
the repo's existing "disabled -> identical reference" discipline (rerank
`rerank/index.ts:104-105`, ranker neutral multipliers, default-off telemetry
gates). Concretely:

- **Embedding robustness** widens `ProviderProfile.envKey` into an ordered probe
  list (backward-compatible single string still accepted), adds a static preset
  catalog consulted only at CLI registration time, and adds a native ZeroEntropy
  provider as a new closed-union branch alongside `openai-compat`.
- **Candidate retrieval** adds a trigram prefilter as a *strict superset* stage
  ahead of full scoring (falls back to full scan for short/CJK/low-selectivity
  queries) and a graph-index BFS pre-pass producing a `should_read` shortlist
  with an `index_only` short-circuit - both new, both gated.
- **Reranking** adds a bundled offline cross-encoder behind the existing
  `RerankProvider` interface (new provider kind, no network) plus a per-store
  eval gate built on the existing recall-benchmark runner.
- **Outcome signals** add a session-end observed-use verdict (new continuity
  kind + MCP write tool mirroring `brain_apply_evidence`) folded into an
  additive capped ranker boost, and additive success/failure counters on
  procedural entries with success-rate ranking.
- **Benchmark** adds a LoCoMo loader emitting the existing `BenchFixture` shape
  into the unchanged staged harness, named as a parallel suite.

**Trade-offs.** Maximum safety and testability: every feature is isolated,
individually revertable, and provable against the pre-existing exhaustive path.
The cost is less cross-feature cohesion - the trigram prefilter, BFS pre-pass,
and reranker remain three separate stages rather than one planner, so a future
"unified retrieval planner" refactor is deferred (but not blocked).

**Complexity:** medium. **Risk:** low.

---

## Variant 2 - Unified retrieval-planner rework

**Approach.** Introduce a single new "retrieval planning" layer that subsumes the
trigram prefilter, the graph-index BFS pre-pass, and reranker selection into one
coordinated candidate-planning stage inserted into `search()`. The planner owns
candidate narrowing (trigram), candidate expansion (BFS), and candidate
re-ordering (rerank) as phases of one pipeline object, with the embedding and
outcome-signal features feeding it as inputs.

**Trade-offs.** Highest cohesion and the cleanest long-term architecture: one
place decides *which* candidates survive and *how* they are ordered. But it
rewrites the core `search()` candidate-union region (`search.ts:414-492,
834-988`), risking the repo-wide byte-identical-when-off invariant and the query
cache fingerprint contract (`search.ts:110-137`). It also couples nine
independent tasks into one large change, making TDD-per-task and per-feature
revert far harder, and inflates review surface. The benchmark and embedding
tasks gain nothing from the coupling.

**Complexity:** large. **Risk:** high.

---

## Variant 3 - Signal-fold-first (outcome-centric)

**Approach.** Build a shared "signal fold" substrate first - a generic
one-file-per-signal append + pure-fold aggregate (the pattern already used by
`activation/store.ts`, `feedback.ts`, `reinforce.ts`) - then express the
observed-use verdict, the procedural success rate, and the per-store reranker
eval gate as three consumers of that substrate. Retrieval features layer on top
consuming the learned signals.

**Trade-offs.** Elegant for the three learning features and would reduce
duplication among them. But four of the nine tasks (multi-key fallback, preset
catalog, ZeroEntropy, LoCoMo) have nothing to do with signal folds, so the
architecture only covers part of the release and forces an artificial "phase 0
substrate" that delays the independently-shippable embedding work. The existing
fold helpers are already reusable directly, so a new generic substrate is
speculative abstraction (YAGNI) ahead of a second real consumer.

**Complexity:** medium-large. **Risk:** medium.

---

## Recommended: Variant 1 - Additive, opt-in, byte-identical-when-off

Variant 1 is the only architecture that fits all nine tasks equally, honors the
repo's load-bearing invariants (byte-identical-when-disabled, default-off gates,
pure disposable folds, closed provider union, no-LLM kernel), and keeps each task
independently test-driven and revertable. It matches every upstream task's own
additive framing and the plan's sequence hint (embeddings -> retrieval ->
reranking -> outcome signals -> benchmark last), and it lets the LoCoMo suite
measure the improved-but-optional stack without any feature being on by default.

Variant 2's unified planner is the right *eventual* shape but is out of scope
here: coupling nine tasks into a core-path rewrite trades this release's low risk
for cohesion the tasks do not yet need. Variant 3's substrate is premature
abstraction over three consumers when the existing fold helpers already serve.

Variant 1 does not preclude a later planner refactor - each stage lands behind a
clean seam that a future unification can absorb.
