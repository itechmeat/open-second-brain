# Retrieval & Ranking Quality - Design

**Status:** draft
**Author:** feature-release-playbook
**Audience:** implementation

## Problem statement

Open Second Brain retrieves and ranks well for small vaults but has four
structural gaps that limit retrieval quality and, critically, our ability to
*measure* it:

1. **Embedding-layer fragility.** The opt-in semantic layer resolves exactly one
   API key and hard-fails (`EMBEDDING_KEY_MISSING`) if it is absent or invalid;
   users get no guidance on which model to register; and only OpenAI-compatible
   endpoints are supported, so specialized providers require an extra HTTP hop.
2. **Candidate retrieval does not scale or plan.** Every query hydrates and
   scores the FTS union vector union pool with no cheap narrowing stage for large
   vaults, and there is no read-planning pre-pass that decides *which* notes are
   worth opening or answers from index metadata alone. Link reasoning is 1-hop.
3. **Reranking requires the network.** The only reranker
   (`CrossEncoderRerankProvider`) needs a configured remote endpoint, so recall
   quality degrades to zero-rerank for offline/local-only vaults, and nothing
   verifies that reranking actually helps a given store before enabling it.
4. **Ranking has no outcome signal.** Recall ranking is predicted-importance and
   recency driven; procedural memory ranks by raw usage count. Neither knows
   whether an injected memory was actually *used* or whether a procedure actually
   *worked*, so memories that are repeatedly injected but never used keep
   floating up, and a runbook that reliably fails cannot sink.

And spanning all of it: OSB's staged bench harness is MemoryBench-inspired with
its own categories, not aligned to any named, published benchmark, so its numbers
are not comparable to the memory-agent literature.

## Scope

Nine leaf tasks, implemented on one branch (`feat/retrieval-ranking-quality`):

- `t_2f99725a` - multi-key fallback for the embeddings API key.
- `t_33f30fdc` - curated embedding-model presets + recommended default.
- `t_8d49f059` - native ZeroEntropy embedding provider.
- `t_4a672b84` - trigram candidate prefilter for large-vault search.
- `t_59ae326f` - graph-index BFS query pre-pass + should-read shortlist + index-only.
- `t_9f95ebb6` - bundled offline reranker + per-store reranker eval gate.
- `t_65588d8b` - session-end observed-use verdict feeding recall ranking.
- `t_703f7b18` - outcome-validated procedural recall ranked by success rate.
- `t_8dabe2b0` - LoCoMo benchmark suite over the existing bench harness.

## Out of scope

- Any core-path rewrite / unified retrieval planner (Variant 2). Each feature is
  an isolated, gated stage.
- Rebuilding the bench harness. LoCoMo is an additive loader over the unchanged
  staged pipeline.
- Pulling the children of in-scope parents: `t_267f3b4c` (reranker fit-check),
  `t_7d5a3589` (tombstone/usage slices) stay out.
- `HYATLAS_HOME`-style runtime-root consolidation - OSB is state-in-vault by
  design.
- On-chain / Solana anchoring - never in scope for this project.
- Making an LLM judge the canonical bench score. The judge stays advisory and
  fail-open; default runs are deterministic and network-free.

## Hard invariant: zero new dependencies, no heavy runtime

**This release adds NO new npm dependencies and NO ML runtime.** The core today
has exactly one runtime dependency (`proper-lockfile`) and no model runtime
(no `onnxruntime`, `transformers.js`/`@xenova`, `torch`, `tokenizers`). Every
feature here is implementable in pure TypeScript over the standard library plus
the existing optional native deps.

The one task whose upstream framing implies a heavy dependency is the offline
reranker (`t_9f95ebb6`, upstream: "ms-marco-MiniLM-L6 cross-encoder"). A real
neural cross-encoder would require a model runtime and a bundled model file
(tens to hundreds of MB, native binaries). We do NOT take that path. Instead,
mirroring the existing local embedder (`local-provider.ts`, a pure
feature-hashing character-trigram embedder with no model and no dependency), the
bundled offline reranker is a **deterministic pure-TypeScript reranker**: a
cross-encoder-shaped scorer built from lexical/structural query-document features
(term overlap, phrase proximity, coverage, field/position signals) behind the
existing `RerankProvider` interface. This is exactly the "no external dependency
in the core" ethos the task itself cites, and the per-store eval gate exists
precisely to prove the reranker helps a given store before it is enabled.

ZeroEntropy is a native HTTP provider (uses `fetch`, no SDK). Trigram prefilter,
BFS pre-pass, LoCoMo loader, multi-key, presets, and the outcome-signal features
are all pure TypeScript. If any implementation appears to need a heavy
dependency, the feature is redesigned in the OSB idiom, not the dependency added.

## Chosen approach

**Variant 1 - additive, opt-in, byte-identical-when-off** (see `variants.md`).
Every feature is a new stage or module that defaults OFF and, when disabled,
leaves existing behavior byte-identical (the repo-wide "disabled -> identical
reference" discipline). Implementation follows the sequence hint so later work
builds on earlier: embeddings -> candidate retrieval -> reranking -> outcome
signals -> benchmark last (so LoCoMo scores the improved-but-optional stack).

## Design decisions

- **Multi-key as an ordered probe list, backward-compatible.**
  `ProviderProfile.envKey` accepts either the existing single string or an
  ordered list; `expandRegisteredProvider` resolves the first env var that is
  present and non-empty. The explicit
  `OPEN_SECOND_BRAIN_EMBEDDING_KEY`/`embedding_api_key` path still wins first.
  Probing is lazy (resolve the first present key; validation happens on first
  real embed call via the existing `ping`/retry path) to avoid a startup auth
  storm. Single-key configs stay byte-identical. Scope stays strictly in the
  embeddings layer; the LLM-free kernel is untouched.

- **Presets as a static, advisory catalog consulted at registration.** A
  shippable `EMBEDDING_MODEL_PRESETS` list (curated multilingual-first models +
  a recommended default) lives beside the existing pricing/identity table in
  `embeddings/`. The CLI `provider add` flow gains `--model` preset resolution
  and a `--list-presets` affordance; custom `--model` entry remains first-class.
  No server, no network, no new subsystem.

- **ZeroEntropy as a native closed-union provider.** Add `"zeroentropy"` to the
  `EmbeddingProvider` factory, the resolved-config provider union, and
  `parseProvider`/`BUILTIN_PROVIDERS`, with a native provider class calling the
  ZeroEntropy embed API over `fetch` (no SDK). It reuses the retry/backoff and
  `ping` contract of the interface. Reserve the name in
  `RESERVED_PROVIDER_NAMES`.

- **Trigram prefilter as a strict-superset narrowing stage.** A new in-memory /
  fts5-trigram candidate producer runs ahead of full scoring for large vaults,
  contributing to (never subtracting from) the candidate pool, with automatic
  fallback to the full scan for short, CJK, or low-selectivity queries. Acceptance
  proves set-containment: the prefiltered candidate set is a superset of what the
  exhaustive scorer would surface on fixtures. Gated behind a default-off
  `search_trigram_prefilter*` config key; folded into the query-cache fingerprint.

- **Graph-index BFS pre-pass reuses existing graph primitives.** A new pre-pass
  ranks candidate notes by title/tag/summary match + wikilink degree + tier,
  connects top candidates via multi-hop BFS over the link graph
  (`link-graph/graph-index.ts` snapshot + a BFS modeled on
  `search/traversal.ts:expandByTraversal`), and returns a `should_read` shortlist.
  An `index_only` mode answers from index metadata (title/tag/summary/degree) with
  zero note bodies read. Exposed as an opt-in mode; the default query path is
  unchanged.

- **Offline reranker + per-store eval gate.** New `LocalRerankProvider`
  (pure-TS, deterministic) selected via a new `kind`/`provider` field on
  `ResolvedRerankConfig` so `makeRerankProvider` can branch to it with no network.
  The per-store eval gate is a small new module that runs the existing
  `runRecallBenchmark` twice (rerank off vs on) and compares metric families
  against thresholds to decide whether reranking helps that store - reusing the
  benchmark runner rather than extending gate-telemetry.

- **Observed-use verdict as a new continuity kind + host-supplied MCP tool.**
  No-LLM kernel: the verdict (USED / IGNORED / CONTRADICTED) is either computed
  deterministically (match injected-memory anchors/content against later
  transcript spans, reusing `deriveNoteStance` for CONTRADICTED) or accepted from
  the host via a new MCP write tool mirroring `brain_apply_evidence`. Persisted as
  a new `recall_observed_use` continuity kind correlated by `session_id`/`turn_id`
  to the existing `recall_telemetry` rows. The aggregated observed-reuse rate
  becomes the preferred recall-ranking signal (a capped ranker input,
  `reuseRateByDoc`), with predicted importance as the fallback prior. The blend is
  inspectable via `brain_recall_telemetry`. CONTRADICTED routes into the existing
  contradiction/declared-thesis path.

- **Procedural success-rate ranking as additive counters.** Add
  `successCount`/`failureCount` (derived `successRate`) to
  `ProceduralMemoryEntry` and the `usage.jsonl` sidecar (additive; old lines
  parse). A `recordProceduralOutcome(vault, id, success|failure)` (host-supplied
  enum, deterministic) mirrors `markProceduralMemoryUsed`; a
  `brain_procedural_memory` `mark_outcome` operation mirrors `mark_used`. Recall
  ranks by `successRate` primary with usage/recency as the fallback prior. No LLM.

- **LoCoMo as an additive named suite.** A LoCoMo loader converts the LoCoMo
  dataset (conversation sessions + QA) into the existing `BenchFixture` shape
  (dialogue turns -> `session_turn` continuity and/or synthesized notes; QA ->
  `BenchQuestion` in existing categories with `expected_text`/`expected_paths`),
  fed to the unchanged `runMemoryBench`, emitting `o2b.bench.v1` named
  `locomo-*`. OSB's six categories stay canonical. The dataset ships as a small,
  committed, deterministic fixture (network-free); the optional judge stage
  remains opt-in for richer answer grading.

## File changes (by task, incremental)

- **t_2f99725a:** `src/core/search/embeddings/registry.ts` (widen `envKey` to
  ordered list + `isProfile`/`validateProfile`), `.../provider-resolve.ts`
  (probe-list resolution), `src/core/search/index.ts` (config plumbing);
  tests under `tests/core/search/embeddings.registry.test.ts`,
  `embeddings.provider-resolve.test.ts`.
- **t_33f30fdc:** new `src/core/search/embeddings/presets.ts`,
  `src/cli/search.ts` (registration flow + `--list-presets`); tests
  `tests/core/search/embeddings.presets.test.ts`,
  `tests/cli/search-provider-cli.test.ts`.
- **t_8d49f059:** new `src/core/search/embeddings/zeroentropy.ts`,
  `.../provider.ts` (factory branch), `src/core/search/types.ts` (union),
  `src/core/search/index.ts` (`parseProvider`/`BUILTIN_PROVIDERS`),
  `.../registry.ts` (reserved name); tests `tests/core/search/embeddings.zeroentropy.test.ts`.
- **t_4a672b84:** new `src/core/search/trigram-prefilter.ts`,
  `src/core/search/search.ts` (candidate-source wiring),
  `.../index.ts` (config), `.../query-cache.ts`/fingerprint; tests
  `tests/core/search/trigram-prefilter.test.ts`, superset assertion in
  `tests/core/search/search.*.test.ts`.
- **t_59ae326f:** new `src/core/search/graph-prepass.ts`,
  `src/core/search/search.ts` (opt-in mode), reuse
  `src/core/brain/link-graph/graph-index.ts`; tests
  `tests/core/search/graph-prepass.test.ts`.
- **t_9f95ebb6:** new `src/core/search/rerank/local.ts`,
  `.../rerank/provider.ts` (factory branch), `.../rerank/index.ts` + `types.ts`
  (config kind), new `src/core/search/rerank-eval-gate.ts`; tests
  `tests/core/search/rerank.local.test.ts`, `rerank-eval-gate.test.ts`.
- **t_65588d8b:** new `src/core/brain/observed-use.ts`,
  `src/core/brain/continuity/types.ts` (new kind), `src/mcp/brain/feedback-tools.ts`
  (new write tool), `src/core/search/ranker.ts` (`reuseRateByDoc` input) +
  `search.ts` (populate), `src/core/brain/recall-telemetry.ts` (blend surface);
  tests `tests/core/brain.observed-use.test.ts`, `tests/mcp/observed-use-tool.test.ts`.
- **t_703f7b18:** `src/core/brain/procedural-memory.ts` (counters + outcome fn),
  `src/mcp/brain/procedure-tools.ts` (`mark_outcome`); tests
  `tests/core/brain.procedural-outcome.test.ts`,
  `tests/mcp/procedural-learning-tools.test.ts`.
- **t_8dabe2b0:** new `src/core/bench/locomo.ts` (loader),
  `src/cli/brain/verbs/bench.ts` (`--suite locomo`), fixture under
  `tests/fixtures/bench/locomo-*.json`; tests `tests/core/bench/locomo.test.ts`.

## Risks

- **Query-cache staleness.** Any ranking-affecting stage (trigram, BFS,
  observed-reuse) must extend `configFingerprint`/`buildCacheKey` or it will serve
  stale cached rows within TTL. Mitigation: fold every new knob into the
  fingerprint; test cache invalidation.
- **Strict-superset correctness for the trigram prefilter.** A prefilter that
  drops a result the exhaustive scorer would keep is a silent recall regression.
  Mitigation: acceptance test asserts set-containment on fixtures incl.
  short/CJK/low-selectivity fallback; fall back to full scan on any doubt.
- **Byte-identical drift.** A new default-on behavior would break existing
  snapshot/determinism tests. Mitigation: all features default OFF; assert
  disabled == identical reference.
- **No-LLM kernel violation.** Observed-use and procedural outcome must never
  infer via an LLM in the kernel. Mitigation: deterministic-structural or
  host-supplied enum only, mirroring `brain_apply_evidence`.
- **LoCoMo dataset licensing/size.** Ship a small, self-contained, deterministic
  fixture rather than the full external dataset; document how to point the loader
  at a full local copy. No network by default.
- **Heavy-dependency temptation** (offline reranker). Mitigation: pure-TS
  deterministic reranker; the eval gate justifies enabling it per store. Hard
  invariant above.
