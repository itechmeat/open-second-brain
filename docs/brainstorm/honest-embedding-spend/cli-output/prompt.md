You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

Ship one release of Open Second Brain whose argument is "honest embedding spend": every path that spends money on embeddings states what it costs, where the price came from and what it covers, and no path assumes a benign answer it cannot prove. Three tracker cards feed it. Reconnaissance against the live source has already been done and is summarised below as fact, not conjecture; do not re-litigate whether these findings are true.

**Card A (t_0bed79f3) - operator-configurable embedding pricing with fail-closed cost caps.**
`src/core/search/embeddings/signature.ts` holds a frozen four-entry `EMBEDDING_PRICING` table (local hashing embedder at 0, three hosted OpenAI models). `pricePerMillionTokens(model)` returns 0 for every model the table does not list, and the docblock states the deliberate polarity: "the cost gate must never falsely block on a model whose rate we do not know". `evaluateCostGate` blocks only when `gateUsd > 0 && !forced && estimatedUsd > gateUsd`, so a paid model outside the table (the built-in paid `zeroentropy` provider, every `o2b search provider add` registry profile, every curated preset - none of them carries a price field) is estimated at 0 and never blocked, even under an explicit positive `embedding_cost_gate_usd`. The gate defaults to 0 (off). The enforcement point is `runEmbeddingPhase` in `src/core/search/indexer.ts`; three other places price spend and must agree with it: `estimatePendingEmbeddingSpend` (maintenance preview), `planVectorBackfill` (dry run, reports `costKnown: false` already), and the `search status` refresh estimate. The maintenance banner prints `estimated $0.0000` for an unpriced model, and the spend receipt (`MaintenanceSpendReceipt {model, tokens, estimatedUsd, forced}`, persisted to a JSONL journal and a `maintenance_spend` metric) cannot distinguish "free" from "price unknown". Price is NOT part of `embeddingSignature` (provider:model:dimension), so a price change must never mark vectors stale. Config is a flat `key: value` file split on the FIRST colon (env overrides config overrides default); model ids such as `nomic-embed-text:latest` therefore cannot appear in a key, only in a value. A precedent for an operator price key exists in the decision-model subsystem (`decision_model_input_price_usd_per_mtok`, with a `cost_source: unknown` record and a diagnostics warning). The `_brain.yaml` embeddings block deliberately binds a fact about one model as a named pair (`sunset_model` + `sunset_at`, both or neither) so that switching models never silently retargets the fact. There is no "implicit default cap" in this codebase: the two real states are "gate off" and "gate explicitly positive". The upstream card also mentions conversation-facts extraction; that path does not exist on the embedding kernel here (decision models have their own per-day gate), so scope is embeddings only. The operator picked this release scope knowing it inverts the unknown-is-free polarity under an explicit cap.

**Card B (t_82c3b275) - automated model refresh and recall tooling.**
The card's strongest upstream evidence is a design with (a) key-aware tier defaults, (b) latest-model discovery from the operator's account (`GET /v1/models`, priced-only, 24 h cache, fail-open), (c) keyless honesty, (d) vectors that survive a re-index only when content hash and model provenance match, (e) a guarded embedding migration. Verified here:
- (b) contradicts a documented stance in `src/core/search/embeddings/sunset.ts`: "This project takes no unrequested outbound call for a fact like this ... an unreachable one is a third state to design for"; every outbound sender is also declared in an egress census test. It is refused, as is automatic switching of the configured model (a model switch invalidates every vector, so an automatic upgrade is an unrequested paid re-embed).
- (a) `resolveSemanticCapability` is documented as derived "from the resolved config alone - never from process.env", so key presence cannot enter the tier. Registry profiles already carry an ordered env-key list (first present wins, rest kept as failover). When the tier is `credential-missing`, `o2b search check` emits one generic label; it does not name which credential sources were consulted (`OPEN_SECOND_BRAIN_EMBEDDING_KEY` / `embedding_api_key`, or the active profile's env-key names) nor which other registered profiles have a key present.
- (c) keyless tiering itself already ships.
- (d) Vectors do not survive an edit: a changed document goes through `replaceChunks` (`src/core/search/store/chunks.ts`), which purges every vector row of the document and deletes every chunk before reinserting, so unchanged chunks of an edited note are re-embedded and re-paid on the next embedding pass. `chunks.content_hash` is `sha256(content)` and the embedded text is exactly `content`; per-row `embeddings.model` and `dimension` are stored; query and passage prefixes are store-level (`index_state`), and any prefix, model or dimension change already clears the whole vector table through `ensureEmbeddingModel`. Vector rows live in a `vec0` virtual table reached through `chunk_vec_map(chunk_id -> vec_rowid)`.
- (e) A guarded migration verb does not exist; `restamp.ts` names it as deferred. Recall tooling (benchmark, rerank-eval, check, doctor) already exists.

**Card C (t_0431f64d) - semantic retrieval over beliefs.**
The card says beliefs (preference notes under `Brain/preferences/` and `Brain/retired/`) have no embeddings. That is refuted: they are ordinary indexed documents and their chunks get vectors on any embedding pass; `surprisal.ts` already reads stored vectors of a note through `getDocumentIdByPath -> chunksForDocument -> embeddingForChunk`. What is true: the belief-specific reader `brain_context_pack` (`src/core/brain/context-pack.ts`, synchronous `packContext`, called from the MCP tool, a CLI verb, the bench, the retrieval planner and the anticipatory cache) offers `query_mode` `substring | ranked`, where `ranked` is Jaccard token overlap and is documented as "no model, no embedding". Its pipeline is: collect candidates, prefer supersession-chain tips, apply the caller's reach filter (`visible`), then sort by tier, focus, relevance, density, recency. Routing beliefs through `search(pathPrefix)` inherits a post-KNN prefix filter (global top `limit*4` neighbours, then drop rows outside the prefix), which silently under-returns in large vaults. Separately, the only way to pay for missing vectors is a whole-vault `o2b search vector-backfill` (dry run by default, `--apply` spends behind the cost gate); its pending census `findChunksWithoutEmbeddings` takes no path scope, so "embed my beliefs" cannot be previewed or paid on its own. The same census must feed the estimate, the gate and the receipt, or the announced and the spent figures disagree.

# Project context

Open Second Brain: a local-first agent memory system. TypeScript on Bun, about 900 modules under `src/`, 1100+ test files, plus a Python plugin under `plugins/hermes/`. Surfaces: an MCP server, an `o2b` CLI, and an OpenClaw bundle.

Recent commits on the default branch:

```
2353cb1e feat: recall injection that arrives once and survives compaction (v1.71.0) (#232)
39c2f225 feat: scoped operator rules per project, harness and host, per-profile Hermes settings on a multiplexed gateway and readers that answer at the caller's reach (v1.70.0) (#229)
d49c4697 feat: ingest that reads CSV, TSV and HTML into table and parts sections, names the formats it skips and previews with o2b brain extract (v1.69.0) (#228)
f5c46615 feat: dependency facts from project manifests, Terraform seeds in the pre-extractor and readers that answer at the caller's reach (v1.68.0) (#227)
400b20ea feat: distillation pages that prove what they quote and say how much of their source the vault holds (v1.67.0)
3ec2334a feat: stable error codes on the MCP wire, typed rerank degradation and a rerank doctor check (v1.66.0) (#225)
a1ecfe7b feat: unattended maintenance recipes, install-owned lane tasks and an MCP fault guard (v1.65.0) (#224)
```

Related files: `src/core/search/embeddings/signature.ts`, `src/core/search/indexer.ts`, `src/core/search/index.ts`, `src/core/search/types.ts`, `src/core/search/search-error.ts`, `src/core/search/vector-backfill.ts`, `src/core/search/store/chunks.ts`, `src/core/search/store/vectors.ts`, `src/core/search/capability-tier.ts`, `src/core/search/embeddings/registry.ts`, `src/core/brain/maintenance/journal.ts`, `src/core/brain/maintenance/reindex-task.ts`, `src/cli/brain/verbs/maintenance.ts`, `src/cli/search/verbs/check.ts`, `src/cli/search/verbs/vector-backfill.ts`, `src/core/brain/context-pack.ts`, `src/mcp/brain/pack-tools.ts`.

Conventions that constrain any design:

- Closed vocabularies are a four-piece idiom enforced by a census test: a frozen object with camelCase keys and snake_case values, a derived union type, a members array, and a type guard over `unknown`. Values that leave TypeScript (MCP schema enums, JSON payloads, persisted records) must be registered.
- Spend runs only behind an explicit apply step: dry run by default, `--apply` to spend, `--force-cost` to pass a refused gate, and a receipt of what was spent.
- Errors are `SearchError` with a registered code; a refusal names the key or flag that resolves it.
- Architecture census tests enforce acyclic imports, the egress census, progress-stage and terminal-state vocabularies, CLI help-surface parity, MCP surface parity and version sync across manifests.
- Persisted records only gain optional fields; old rows must read as "unrecorded", never as a known value.

Constraints:

- No stubs and no placeholder implementations.
- No fallback that silently does nothing or produces a misleading success. A verdict that cannot be reached must say so rather than default to the benign answer.
- No hardcoded natural-language word lists in any language, and no hardcoded vendor list for key detection: only operator-declared names (config keys, registry profiles) count.
- No unrequested network call; no new outbound sender.
- Do not change existing public MCP tool names; additive schema changes only.
- No new external runtime dependencies.
- Byte-identical output when a new feature is absent or inactive.

# Required output format

Produce exactly 3 distinct architectural variants. For each variant:

### Variant N: <short name>
- **Approach**: 2-3 sentences describing the variant.
- **Trade-offs**: bullet list of pros and cons.
- **Complexity**: small | medium | large
- **Risk**: low | medium | high

After the three variants, add exactly one recommendation:

### Recommended: Variant N
**Rationale**: 2-3 sentences explaining why this variant over the others, considering the project context and constraints above.

Output nothing outside of these sections.
