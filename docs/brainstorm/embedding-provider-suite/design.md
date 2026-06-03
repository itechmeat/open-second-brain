# Embedding Provider Suite - shared signature kernel, local embedder, provider registry, RRF fusion

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain's semantic layer has one real embedding provider (`openai-compat`, remote HTTP) and one null provider. There is no offline/local-first embedder, no runtime way to register providers without editing config, no cost visibility or spend gate before a large embedding run, and exactly one rank-fusion mode (weighted linear sum of min-max-normalised BM25 and cosine). Four triage tasks (t_9d24c9fd p4, t_d1fbfeee p3, t_f42f1b69 p2, t_4796dff3 p2) all extend this one subsystem and share provider-identity logic.

## Scope

- **Unit 1 - Hybrid RRF fusion (t_9d24c9fd):** add Reciprocal Rank Fusion as an alternative to linear fusion of the sparse (BM25) and dense (cosine) lanes. Opt-in via `search_fusion_mode`; default `linear` keeps ranking bit-identical. No cloud vector DB - storage stays SQLite + sqlite-vec + FTS5.
- **Unit 2 - Local embedder (t_d1fbfeee):** add a `local` provider that produces deterministic embeddings with no cloud call, no API key, and no model download - a character n-gram feature-hashing embedder. Predictable dimension, stable model signature, clear diagnostics.
- **Unit 3 - Provider registry (t_f42f1b69):** CLI verbs (`o2b search provider add/list/show/remove`) that persist named provider profiles (base-url, default-model, env-key) to a vault-local registry file. A registered name resolves to an `openai-compat` config at config-resolution time; built-ins are never shadowed.
- **Unit 4 - Cost model + signatures (t_4796dff3):** one signature kernel that canonicalises `{provider, model, dimension}`, a model-aware price-per-million-tokens table, a token/cost estimator, signature-based stale reporting in status/check, and a cost gate that blocks an embedding run whose estimated spend exceeds a configurable threshold.

## Out of scope

- Cloud/hosted vector databases (Qdrant/Milvus/Weaviate/TCVDB) - explicitly deferred.
- A heavy bundled transformer model. The local embedder is dependency-free; opting into a larger local model is future work.
- Per-token exact billing reconciliation against a provider invoice - we estimate, we do not reconcile.
- Replacing the closed provider union with a descriptor/plugin spine (consultant Variant 3) - rejected as over-built.

## Chosen approach

Consultant **Variant 2 - shared signature/provenance kernel + registry module**. Two focused new domain modules carry the logic Units 2/3/4 share, and a small fusion strategy module carries Unit 1:

- `embeddings/signature.ts` - canonicalise `{provider, model, dimension}` to a stable signature string; hold the per-model pricing table; estimate tokens and cost; decide staleness by comparing an active signature with a stored one. The single source of provider-identity truth, consumed by the factory, indexer, store, and CLI rather than re-derived per call site.
- `embeddings/registry.ts` - load/persist provider profiles from `Brain/search/embedding-providers.json`; expand a registered name into `openai-compat` config fields during `resolveSearchConfig`, after built-ins so a configured built-in key is never shadowed. Fail-soft: an absent or malformed registry resolves to no extra providers.
- `embeddings/local-provider.ts` - `LocalProvider implements EmbeddingProvider`: deterministic character n-gram feature hashing into a fixed-dimension unit-normalised vector. No network, no key, no download.
- `search/fusion.ts` - pure `linearFusion` and `rrfFusion(lanes, k)` helpers split out of `ranker.ts`; the ranker calls the selected strategy and keeps every existing boost (link/tag/recency/entity/tier/session-focus) unchanged.

## Design decisions

- **Closed union stays closed.** The only new resolved provider member is `local`. Registry entries are config-time indirection that resolve to `provider: "openai-compat"`, so `ResolvedEmbeddingConfig.provider` remains `"openai-compat" | "disabled" | "local"` and `parseProvider` keeps validating a closed set. Registry expansion happens before `parseProvider` so a registered name never reaches the validator.
- **Local embedder = feature hashing, not a model.** A character n-gram (n=3, plus token unigrams) hashing trick gives an offline, deterministic, zero-dependency baseline that works the instant the package installs - matching the upstream "tiny default embedder, no model download" intent. Vectors are unit-normalised so the existing cosine-from-L2 ranker math is unchanged. Quality limits are documented; the design leaves room for a future opt-in transformer.
- **Signature is the one fingerprint.** `embeddingSignature(provider, model, dimension)` is reused by `corpusGeneration()` (cache invalidation), per-run stale reporting, and the cost estimate, so the four units cannot drift on what "the same embedding configuration" means. The store keeps its existing clear-on-model/dimension-change safety; the signature adds finer-grained reporting and gating on top, it does not replace the clear.
- **Cost gate is off by default.** `embedding_cost_gate_usd` defaults to `0` (disabled). When positive and a run's estimated spend exceeds it, the indexer throws `EMBEDDING_COST_GATE` carrying the estimate; an explicit override (`--force-cost` / config) proceeds. The local provider prices at `0`, so it is never gated.
- **RRF is off by default.** `search_fusion_mode` defaults to `linear`; with it the ranker output is byte-for-byte the current behaviour. `rrf` mode fuses lane ranks with `1 / (rrf_k + rank)` (`search_rrf_k` default 60, the canonical RRF constant) and adds an `rrf:` reason; boosts still compose on top.
- **Every knob follows the house pattern:** a YAML key, an `OPEN_SECOND_BRAIN_*` env override, a `DEFAULTS` entry, and range validation.
- **Fail-soft everywhere:** a bad registry, an unavailable local runtime, or an unknown pricing entry degrades to current behaviour or a clear diagnostic, never an exception in the hot path.

## File changes

New source:
- `src/core/search/embeddings/signature.ts`
- `src/core/search/embeddings/registry.ts`
- `src/core/search/embeddings/local-provider.ts`
- `src/core/search/fusion.ts`

Modified source:
- `src/core/search/embeddings/provider.ts` - `makeProvider` `local` branch.
- `src/core/search/types.ts` - provider union `+ "local"`; `fusionMode`, `rrfK`, `costGateUsd` on resolved config; signature + estimated-refresh-cost fields on the status snapshot.
- `src/core/search/index.ts` - `parseProvider` local; registry expansion; fusion/rrf/cost-gate config parsing; `DEFAULTS`.
- `src/core/search/indexer.ts` - cost gate + estimate in `populateEmbeddings`; signature + refresh-cost in `indexStatus`.
- `src/core/search/store.ts` - signature helpers / signature-based stale count; `corpusGeneration` reuses the kernel.
- `src/core/search/ranker.ts` - delegate relevance fusion to `fusion.ts`; rrf path; `rrf` reason.
- `src/cli/search.ts` - `provider` subverbs; cost-gate flag on reindex.
- `src/cli/command-manifest.ts`, `src/cli/help-text.ts`, `src/cli/completions.ts` - register and document the new verbs.

New tests (one focused suite per unit + integration):
- `tests/embeddings.local-provider.test.ts`, `tests/embeddings.signature.test.ts`, `tests/embeddings.registry.test.ts`, `tests/search.fusion-rrf.test.ts`, `tests/indexer.cost-gate.test.ts`, `tests/search-provider.cli.test.ts`, `tests/search-config.embedding-suite.test.ts`, plus an e2e search slice exercising rrf + local provider.

Docs:
- `README.md`, `CHANGELOG.md`, `docs/cli-reference.md`, `docs/how-it-works.md`.

## Risks and open questions

- **Local embedder quality.** Feature hashing is lexical, not semantic; near-synonyms it cannot match. Mitigation: document it as a no-cloud baseline, keep `openai-compat` the recommended path for semantic depth, and leave the dimension configurable.
- **RRF re-baselining.** RRF changes scores when enabled, so e2e ranking fixtures must assert `linear` (default) stays bit-identical and add separate `rrf` fixtures. Mitigation: gate behind the off-by-default switch and test both modes.
- **Pricing table staleness.** Hardcoded per-model prices drift as providers change rates. Mitigation: treat unknown models as price `0` (never falsely gate), document the table as best-effort, and allow a per-model override via config.
- **Registry file and Syncthing.** The registry stores env-key *names*, never secret values, so it is safe to sync across devices. Confirmed no secret material lands on disk.
