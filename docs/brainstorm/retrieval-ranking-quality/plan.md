# Retrieval & Ranking Quality - Implementation Plan

**Status:** draft
**Author:** feature-release-playbook
**Audience:** implementation

Per-task implementation plan. Implement in the order below (the release sequence
hint): embeddings robustness -> candidate retrieval -> reranking -> outcome
signals -> benchmark last. Every task is TDD (failing test first), gated
default-OFF where it changes behavior, and adds zero npm dependencies.

Legend: **Files** = code + test touch-points; **Acceptance** = the concrete test
that proves the task; **Depends on** = ordering constraint within this branch.

---

## 1. t_2f99725a - Multi-key fallback for the embeddings API key

- **Files:**
  - `src/core/search/embeddings/registry.ts` - `ProviderProfile.envKey` accepts
    `string | readonly string[]`; `isProfile`/`validateProfile` accept both;
    `expandRegisteredProvider` resolves the first present, non-empty env var and
    records which key won.
  - `src/core/search/embeddings/provider-resolve.ts` - `resolveOpenAiCompatEndpoint`
    gains an ordered-probe path (first non-empty wins, else throw the existing
    `EMBEDDING_KEY_MISSING`).
  - `src/core/search/index.ts` - config plumbing preserves single-key precedence.
  - Tests: `tests/core/search/embeddings.registry.test.ts`,
    `tests/core/search/embeddings.provider-resolve.test.ts`.
- **Acceptance:** given a profile whose `envKey` is `["A","B"]` with `A` unset and
  `B` set, `expandRegisteredProvider` resolves `B`'s value; with a single-string
  `envKey` behavior is byte-identical to today; with none set it throws
  `EMBEDDING_KEY_MISSING`.
- **Depends on:** none (first task).

## 2. t_33f30fdc - Curated embedding-model presets + recommended default

- **Files:**
  - new `src/core/search/embeddings/presets.ts` - `EMBEDDING_MODEL_PRESETS`
    (curated multilingual-first entries: id, label, dimension, note) +
    `RECOMMENDED_EMBEDDING_MODEL`.
  - `src/cli/search.ts` - `provider add` resolves `--model` against presets,
    defaults to the recommended model when omitted, and supports
    `--list-presets`; custom `--model` still accepted verbatim.
  - Tests: `tests/core/search/embeddings.presets.test.ts`,
    `tests/cli/search-provider-cli.test.ts`.
- **Acceptance:** `o2b search provider add p --base-url U --env-key K` with no
  `--model` persists the recommended default; `--list-presets` prints the catalog;
  a custom `--model foo/bar` persists verbatim; presets carry stable dimensions.
- **Depends on:** none (independent; touches registration UX only).

## 3. t_8d49f059 - Native ZeroEntropy embedding provider

- **Files:**
  - new `src/core/search/embeddings/zeroentropy.ts` - `ZeroEntropyProvider`
    implements `EmbeddingProvider` (`embed`, `ping`, `consumeRetryCount`) over the
    ZeroEntropy embed API via `fetch`; retry/backoff mirrors openai-compat.
  - `src/core/search/embeddings/provider.ts` - `makeProvider` branch for
    `"zeroentropy"`.
  - `src/core/search/types.ts` - add `"zeroentropy"` to the resolved provider
    union.
  - `src/core/search/index.ts` - `parseProvider` + `BUILTIN_PROVIDERS`.
  - `src/core/search/embeddings/registry.ts` - reserve name.
  - Tests: `tests/core/search/embeddings.zeroentropy.test.ts` (fake-http helper).
- **Acceptance:** with `provider: "zeroentropy"` configured, `embed` returns
  correctly-shaped vectors from a fake ZeroEntropy endpoint, `ping` reports the
  dimension, auth/absent-key errors map to the existing `SearchError` codes; the
  provider union stays closed (invalid provider still throws `INVALID_INPUT`).
- **Depends on:** none (parallel to 1-2, shares embeddings surface; sequence after
  1-2 to avoid registry merge churn).

## 4. t_4a672b84 - Trigram candidate prefilter for large-vault search

- **Files:**
  - new `src/core/search/trigram-prefilter.ts` - deterministic trigram candidate
    producer (extract query trigrams; select candidate chunkIds by trigram
    overlap); short/CJK/low-selectivity detection triggers full-scan fallback.
  - `src/core/search/search.ts` - wire as an additional candidate source into the
    union (never removes candidates); default-off.
  - `src/core/search/index.ts` - `search_trigram_prefilter*` config keys
    (enabled, min corpus size, selectivity threshold), default off.
  - `src/core/search/search.ts` `configFingerprint` / `query-cache.ts` - fold the
    knobs into the cache key.
  - Tests: `tests/core/search/trigram-prefilter.test.ts`, superset assertion in a
    search-level test.
- **Acceptance:** on a fixture vault, the prefiltered candidate set is a strict
  superset of the exhaustive scorer's candidate set for normal queries; short
  (< 3 chars), CJK, and low-selectivity queries fall back to full scan (identical
  results); enabling/disabling changes the cache key.
- **Depends on:** none code-wise; sequence after embeddings so retrieval work is
  contiguous.

## 5. t_59ae326f - Graph-index BFS query pre-pass + should-read + index-only

- **Files:**
  - new `src/core/search/graph-prepass.ts` - rank candidate notes by
    title/tag/summary match + wikilink degree + tier; multi-hop BFS over the link
    graph (reuse `src/core/brain/link-graph/graph-index.ts` snapshot; BFS modeled
    on `src/core/search/traversal.ts:expandByTraversal`); emit `should_read`
    shortlist; `index_only` mode answers from index metadata with zero bodies.
  - `src/core/search/search.ts` - opt-in pre-pass mode; default path unchanged.
  - Tests: `tests/core/search/graph-prepass.test.ts`.
- **Acceptance:** on a linked fixture vault, the pre-pass returns a `should_read`
  shortlist ordered by the combined signal; a 2-hop question surfaces a note
  reachable only via multi-hop BFS that the 1-hop boost misses; `index_only`
  returns an answer with zero note bodies hydrated (assert no body reads).
- **Depends on:** 4 (retrieval-stage cohesion; independent modules).

## 6. t_9f95ebb6 - Bundled offline reranker + per-store reranker eval gate

- **Files:**
  - new `src/core/search/rerank/local.ts` - `LocalRerankProvider` implements
    `RerankProvider` with a deterministic pure-TS cross-encoder-shaped scorer
    (term overlap, phrase proximity, coverage, position signals). No network, no
    dependency.
  - `src/core/search/rerank/provider.ts` - `makeRerankProvider` branch on a new
    `kind`/`provider` field.
  - `src/core/search/rerank/index.ts` + `src/core/search/types.ts` - add the
    provider-kind field to `ResolvedRerankConfig`; select local vs openai-compat.
  - new `src/core/search/rerank-eval-gate.ts` - run `runRecallBenchmark` with
    rerank off vs on and compare metric families against thresholds -> enable/keep
    decision per store.
  - Tests: `tests/core/search/rerank.local.test.ts`,
    `tests/core/search/rerank-eval-gate.test.ts`.
- **Acceptance:** `LocalRerankProvider.rerank(query, docs)` returns order-aligned
  scores, higher for a doc that better matches the query, fully offline and
  deterministic; wired via config `kind: "local"` it reorders results in an
  end-to-end search with no network; the eval gate returns `improves: true` when
  rerank raises hit@k/MRR on a fixture and `improves: false` when it does not.
- **Depends on:** 4-5 (reranking sits after candidate retrieval).

## 7. t_65588d8b - Session-end observed-use verdict feeding recall ranking

- **Files:**
  - new `src/core/brain/observed-use.ts` - deterministic verdict computation
    (match injected-memory anchors/content against later transcript spans; reuse
    `deriveNoteStance` for CONTRADICTED) AND acceptance of a host-supplied verdict;
    fold observed records into a per-artifact reuse rate.
  - `src/core/brain/continuity/types.ts` - add `recall_observed_use` kind.
  - `src/mcp/brain/feedback-tools.ts` - new write tool mirroring
    `brain_apply_evidence` (enum-validated verdict, role gate, typed errors).
  - `src/core/search/ranker.ts` - new `reuseRateByDoc?` input (capped boost /
    preferred signal with importance as fallback prior).
  - `src/core/search/search.ts` - populate `reuseRateByDoc` from folded records.
  - `src/core/brain/recall-telemetry.ts` - surface the blend so it is inspectable.
  - Tests: `tests/core/brain.observed-use.test.ts`,
    `tests/mcp/observed-use-tool.test.ts`, ranker input test.
- **Acceptance:** given injected memories and a transcript, USED/IGNORED are
  classified deterministically and a CONTRADICTED case routes via
  `deriveNoteStance`; the host tool records a verdict per injected memory
  (enum-validated, idempotent); a memory with a high observed-reuse rate ranks
  above an equally-relevant memory with none; kernel calls no LLM. Outcome-free
  vaults stay byte-identical.
- **Depends on:** none code-wise; sequence after retrieval so the ranker input is
  added once the retrieval stages are stable.

## 8. t_703f7b18 - Outcome-validated procedural recall ranked by success rate

- **Files:**
  - `src/core/brain/procedural-memory.ts` - add `successCount`/`failureCount`
    (derived `successRate`) to `ProceduralMemoryEntry` and the `usage.jsonl`
    sidecar (additive; old lines parse); `recordProceduralOutcome(vault, id,
    success|failure, {now})` mirrors `markProceduralMemoryUsed`; recall ranks by
    `successRate` primary, usage/recency fallback prior.
  - `src/mcp/brain/procedure-tools.ts` - `mark_outcome` operation mirroring
    `mark_used`.
  - Tests: `tests/core/brain.procedural-outcome.test.ts`,
    `tests/mcp/procedural-learning-tools.test.ts`.
- **Acceptance:** recording success/failure updates counters (order-insensitive
  fold); a procedure with a high success rate outranks a more-used but
  lower-success-rate procedure; entries without outcomes rank by the existing
  usage prior (byte-identical for outcome-free vaults); ranking is deterministic,
  no LLM.
- **Depends on:** 7 (both are outcome-signal features; independent modules).

## 9. t_8dabe2b0 - LoCoMo benchmark suite over the existing bench harness

- **Files:**
  - new `src/core/bench/locomo.ts` - loader converting the LoCoMo dataset
    (sessions + QA) into `BenchFixture`(s) named `locomo-*` (dialogue turns ->
    `session_turn` continuity and/or synthesized notes; QA -> `BenchQuestion`
    with existing categories + `expected_text`/`expected_paths`).
  - `src/cli/brain/verbs/bench.ts` - `--suite locomo` resolution branch.
  - new fixture `tests/fixtures/bench/locomo-sample.json` - small, deterministic,
    self-contained LoCoMo-shaped sample.
  - Tests: `tests/core/bench/locomo.test.ts`.
- **Acceptance:** the loader emits a valid `BenchFixture` (passes
  `parseBenchFixture`); `runMemoryBench` over the LoCoMo fixture produces an
  `o2b.bench.v1` report named `locomo-*` deterministically and network-free;
  OSB's six categories remain canonical (unchanged core-recall run); the optional
  judge stage stays opt-in and defaults to `skipped`.
- **Depends on:** 1-8 (benchmark last so it can score the improved stack).

---

## Cross-cutting acceptance (Phase 7 QA)

- `bun run validate` green, zero warnings.
- `bun run check:paths:strict` clean.
- Every "disabled" feature proven byte-identical to pre-branch behavior.
- Query-cache invalidation proven for every ranking-affecting knob.
- No new entry in `package.json` `dependencies`/`optionalDependencies`.
