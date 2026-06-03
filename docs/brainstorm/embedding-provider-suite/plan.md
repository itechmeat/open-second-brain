# Embedding Provider Suite - implementation plan

Implementation order follows the dependency graph: the shared kernel first (Unit 4's signature/pricing is depended on by Units 2 and 3), then the local provider, then the registry, then RRF (independent). Each task is one atomic conventional commit on `feat/embedding-provider-suite`, fmt+lint green before commit.

## Tasks

### Task 1: Signature + cost kernel (Unit 4 foundation)
- **Files**: `src/core/search/embeddings/signature.ts` (new); `tests/embeddings.signature.test.ts` (new).
- **What**: `embeddingSignature(provider, model, dimension)` -> canonical `provider:model:dim` string; `EMBEDDING_PRICING` table (per-model USD/Mtok, unknown -> 0); `estimateTokens(texts)` (chars/4 heuristic); `estimateCostUsd(tokens, model)`; `isStaleSignature(active, stored)`.
- **Acceptance**: unit tests cover canonicalisation (case/whitespace/null model), known + unknown pricing, token + cost estimate, stale comparison. No I/O.
- **Depends on**: none.

### Task 2: Local embedder provider (Unit 2)
- **Files**: `src/core/search/embeddings/local-provider.ts` (new); `src/core/search/embeddings/provider.ts` (makeProvider `local` branch); `src/core/search/types.ts` (provider union `+ "local"`); `src/core/search/index.ts` (`parseProvider` accepts `local`, default model/dimension for local); `tests/embeddings.local-provider.test.ts` (new).
- **What**: `LocalProvider` - deterministic character-trigram + token-unigram feature hashing into a configurable fixed dimension (default 256), unit-normalised; `name="local"`, `model="hashing-ngram-v1"`, `ping()` always ok with the configured dimension; no network, no key.
- **Acceptance**: identical text -> identical vector; different text -> different vector; vectors unit-normalised; dimension honoured; `makeProvider({provider:"local"})` returns a `LocalProvider`; `parseProvider("local")` ok.
- **Depends on**: Task 1 (pricing entry for the local model = 0).

### Task 3: Provider registry + CLI (Unit 3)
- **Files**: `src/core/search/embeddings/registry.ts` (new); `src/core/search/index.ts` (registry expansion before `parseProvider`); `src/cli/search.ts` (`provider add/list/show/remove`); `src/cli/command-manifest.ts`, `src/cli/help-text.ts`, `src/cli/completions.ts`; `tests/embeddings.registry.test.ts` (new); `tests/search-provider.cli.test.ts` (new).
- **What**: load/persist `Brain/search/embedding-providers.json` (`{name, baseUrl, defaultModel, envKey}[]`); `expandRegisteredProvider(name, registry, env)` -> openai-compat fields; CLI verbs to add/list/show/remove with validation (reserved names `openai-compat`/`disabled`/`local` refused). Fail-soft on absent/malformed file.
- **Acceptance**: round-trip add->list->show->remove; registered name resolves to openai-compat config with apiKey from `env[envKey]`; built-in names cannot be registered; malformed JSON -> empty registry + warning, never throw.
- **Depends on**: Task 1 (signature reused in show output).

### Task 4: Cost gate + signature reporting in indexer/store (Unit 4)
- **Files**: `src/core/search/indexer.ts` (estimate + gate in `populateEmbeddings`; signature + estimatedRefreshCostUsd in `indexStatus`); `src/core/search/store.ts` (signature-based stale helper; `corpusGeneration` reuses kernel); `src/core/search/types.ts` (`costGateUsd` on resolved config; signature + cost fields on status snapshot); `src/core/search/index.ts` (`embedding_cost_gate_usd` parse + default 0); `src/cli/search.ts` (`--force-cost` flag on reindex); `tests/indexer.cost-gate.test.ts` (new).
- **What**: before embedding a batch set, estimate tokens+cost; if `costGateUsd > 0` and estimate exceeds it and not overridden, throw `EMBEDDING_COST_GATE` with the estimate; surface active signature + refresh cost in status. Local provider (price 0) never gated.
- **Acceptance**: gate blocks an over-threshold run and the message carries the estimate; `--force-cost` proceeds; gate `0` (default) never blocks; status reports the signature; `corpusGeneration` unchanged output for unchanged config.
- **Depends on**: Tasks 1, 2.

### Task 5: RRF fusion mode (Unit 1)
- **Files**: `src/core/search/fusion.ts` (new); `src/core/search/ranker.ts` (delegate relevance fusion; rrf path; `rrf` reason); `src/core/search/types.ts` (`fusionMode`, `rrfK` on resolved config); `src/core/search/index.ts` (`search_fusion_mode` + `search_rrf_k` parse, defaults `linear`/60); `tests/search.fusion-rrf.test.ts` (new).
- **What**: `linearFusion(kw, sem, kwWeight, semWeight)` (current math) and `rrfFusion(laneRanks, k)`; ranker selects by `fusionMode`; `linear` byte-identical to today; `rrf` fuses lane ranks, adds `rrf:` reason, boosts still compose.
- **Acceptance**: `linear` mode reproduces current ranking fixtures exactly; `rrf` mode orders by reciprocal-rank sum on a constructed two-lane fixture; invalid mode rejected by config parse.
- **Depends on**: none (independent; sequenced last to isolate ranking re-baseline).

### Task 6: Integration + docs
- **Files**: e2e search slice (rrf + local provider) in an existing or new e2e test; `README.md`; `CHANGELOG.md` (v0.36.0); `docs/cli-reference.md`; `docs/how-it-works.md`.
- **Acceptance**: full `bun test` green; new capabilities documented capability-first; CHANGELOG single v0.36.0 entry bundling all four units.
- **Depends on**: Tasks 1-5.
