# Honest Embedding Spend - implementation plan

Every task is test-first: write the failing test, run it and see it fail for the expected reason, implement, then run the formatter and linter before the commit. Every new test file opens with a docblock that states the defect it pins and what it deliberately does not cover. Task numbers give a valid order. Tasks 8, 9 and 11 do not depend on the pricing chain and can be done in any order.

## Tasks

### Task 1: Price-source vocabulary and quote resolver
- **Files**: `src/core/search/embeddings/pricing.ts` (new), `src/core/search/embeddings/signature.ts`, `tests/core/search/embeddings.pricing.test.ts` (new), `tests/core/search/embeddings.signature.test.ts`, the vocabulary census registration.
- **Acceptance**:
  - `resolveEmbeddingPrice` returns `{0.02, builtin}` for `text-embedding-3-small` and `{0, builtin}` for the local model.
  - It returns `{null, unknown}` for an unlisted model and for null.
  - It returns `{rate, operator}` when the override model matches after `canonicalToken`. That includes re-pricing a table model and declaring a rate of 0.
  - A non-matching override leaves the table answer unchanged.
  - `EMBEDDING_PRICE_SOURCE` passes the four-piece vocabulary census.
  - `estimateCostUsd` returns null for an unknown quote.
  - The `pricePerMillionTokens` assertions move to the resolver, and the function is deleted once task 5 removes its last caller.
  - The table docblock states the new rule.
- **Depends on**: none

### Task 2: Operator price pair in config
- **Files**: `src/core/search/index.ts`, `src/core/search/types.ts`, `tests/core/search/embeddings.cost-gate.test.ts`.
- **Acceptance**:
  - `embedding_price_model` and `embedding_price_usd_per_mtok` resolve from config, and the env overrides `OPEN_SECOND_BRAIN_EMBEDDING_PRICE_MODEL` and `OPEN_SECOND_BRAIN_EMBEDDING_PRICE_USD_PER_MTOK` win over it.
  - A colon-bearing model id in the value (`nomic-embed-text:latest`) survives the flat parser.
  - A half pair is refused with `SearchError("INVALID_INPUT")`, naming the missing key. So are a negative rate and a non-numeric rate.
  - When both keys are absent, `priceOverride` is absent, and every literal `ResolvedEmbeddingConfig` fixture compiles unchanged.
  - `embeddingSignature` of a model is identical with and without an override (regression test).
- **Depends on**: Task 1

### Task 3: Shared spend plan and scoped pending census
- **Files**: `src/core/search/embedding-spend.ts` (new), `src/core/search/store/chunks.ts`, `src/core/search/store.ts`, `src/core/search/embeddings/signature.ts` (`evaluateCostGate` takes the quote and returns a reason), `tests/core/search/embedding-spend.test.ts` (new), `tests/core/search/pending-vectors.test.ts`.
- **Acceptance**:
  - `planEmbeddingSpend` returns the pending set, model, tokens, quote, nullable estimate and the gate verdict `{blocked, reason}`, with `EMBEDDING_GATE_REASON` registered.
  - Its gate verdicts:
    - gate 0 never blocks;
    - gate > 0 with a known price blocks only over the cap, with reason `over_cap`;
    - gate > 0 with an unknown price and pending chunks blocks with reason `unpriced`;
    - forced never blocks;
    - an empty pending set never blocks;
    - the local model never reads `unpriced`.
  - `findChunksWithoutEmbeddings({ pathPrefixes })` and the count form return only chunks under the prefixes and agree with each other.
  - Without a scope, the SQL and the results are unchanged.
- **Depends on**: Task 2

### Task 4: Phase gate consumes the plan and refuses unpriced spend
- **Files**: `src/core/search/indexer.ts` (`runEmbeddingPhase`), `src/core/search/search-error.ts`, the MCP stable error-code registry, `tests/core/search/embedding-spend-preview.test.ts`, `tests/core/search/indexer.embeddings.test.ts`.
- **Acceptance**:
  - With gate > 0 and an unknown price, `runEmbeddingPhase` throws `EMBEDDING_COST_UNPRICED`. The message names the model, both price keys and `--force-cost`, and the provider is never called (injected throwing provider).
  - With `forceCost` the phase proceeds, and `stats.spend` carries `forced: true`, `priceSource: unknown` and `estimatedUsd: null`.
  - Over-cap behaviour and the `EMBEDDING_COST_GATE` message are unchanged.
  - The new code is registered on the MCP wire.
- **Depends on**: Task 3

### Task 5: Preview, backfill and status read the plan
- **Files**: `src/core/search/indexer.ts` (`estimatePendingEmbeddingSpend`, `indexStatus`), `src/core/search/vector-backfill.ts`, `src/core/search/types.ts`, `tests/core/search/embedding-spend-preview.test.ts`, `tests/cli/search-vector-backfill.test.ts`, the status test that covers `estimatedRefreshCostUsd`.
- **Acceptance**:
  - The preview, the backfill dry run and the status estimate report the same tokens, estimate and source as the phase for one fixture.
  - An unknown price yields `estimatedUsd: null` and `blocked: true` with reason `unpriced` under a positive gate.
  - The backfill reports `costKnown: true` for the local model and for an operator-priced model, and `false` only for `unknown`.
  - The backfill and the status estimate resolve the model as the phase does.
- **Depends on**: Task 4

### Task 6: Receipts, banner and JSON surfaces carry the price source
- **Files**: `src/core/brain/maintenance/journal.ts`, `src/core/brain/maintenance/reindex-task.ts`, `src/cli/brain/verbs/maintenance.ts`, `src/cli/search/verbs/vector-backfill.ts`, `src/cli/search/verbs/status.ts`, `src/core/search/serialize.ts`, `src/mcp/search-tools.ts`, `tests/cli/brain-maintenance.test.ts`, `tests/cli/search-vector-backfill.test.ts`.
- **Acceptance**:
  - The maintenance banner prints `price unknown` for an unknown quote and the dollar figure otherwise.
  - A new receipt and the `maintenance_spend` metric carry `price_source`.
  - A journal row without `price_source` renders as unrecorded, and its numeric estimate is unchanged.
  - The backfill and status text and JSON show `price unknown` or null and never `$0.0000` for an unknown price.
  - Output for a table model with gate 0 is byte-identical to the base.
- **Depends on**: Task 5

### Task 7: Check recommendations for unpriced and stale price declarations
- **Files**: `src/core/search/indexer.ts` (`buildRecommendations`), `src/cli/search/verbs/check.ts`, `tests/cli/search-check-provider.test.ts`.
- **Acceptance**:
  - With semantic configured, the price unknown and the gate at 0, there is one recommendation that names both price keys and states that a positive gate would refuse.
  - With a positive gate, the recommendation states that backfills refuse.
  - A declared pair for a model other than the active one yields one stale-declaration recommendation.
  - Priced and local models produce no new line.
- **Depends on**: Task 5

### Task 8: Credential-source report in search check
- **Files**: `src/core/search/embeddings/credential-report.ts` (new), `src/core/search/indexer.ts` (check result field), `src/cli/search/verbs/check.ts`, `tests/core/search/credential-report.test.ts` (new), `tests/cli/search-check-provider.test.ts`.
- **Acceptance**:
  - For `credential-missing` with explicit config, `consulted` is `embedding_api_key` and `OPEN_SECOND_BRAIN_EMBEDDING_KEY`. For a registry profile, it is the profile's env-key names in probe order.
  - `presentElsewhere` lists the other registered profiles whose env key is non-empty.
  - A test env with secret values proves that no value appears in the text or JSON output.
  - Nothing is reported for a `configured` tier, so that output is byte-identical.
  - `resolveSemanticCapability` is unchanged, and the egress census is unchanged.
- **Depends on**: none

### Task 9: Vector carry-over on edit
- **Files**: `src/core/search/store/chunks.ts` (`replaceChunks`), `src/core/search/store/vectors.ts` (a read helper for the old rows, if needed), `src/core/search/indexer.ts` (`embeddingsReused` tally), `src/core/search/types.ts`, `tests/core/search/vector-carry-over.test.ts` (new).
- **Acceptance**:
  - After editing one paragraph of a three-chunk note, only the changed chunk is pending, the unchanged chunks keep their vectors (same `embedding_hash`), and `embeddingsReused` is 2.
  - A moved paragraph is carried. Duplicated paragraphs carry as a multiset.
  - A row whose model or dimension differs from `index_state` is not carried, and neither is any row when the identity is unrecorded.
  - With vec not loaded, behaviour is unchanged.
  - The embedder record audit passes on carried rows.
  - A semantic query after the edit returns the carried chunk.
- **Depends on**: none

### Task 10: Path-scoped vector backfill
- **Files**: `src/core/search/vector-backfill.ts`, `src/core/search/indexer.ts` (the phase takes its scope through the plan), `src/cli/search/verbs/vector-backfill.ts`, `src/cli/command-manifest.ts`, `src/cli/search.ts`, `tests/cli/search-vector-backfill.test.ts`.
- **Acceptance**:
  - The `--path` flag is repeatable and validated by `assertSafePathPrefix`. An unsafe prefix is refused by name.
  - The dry run with `--path Brain/preferences/` prices only belief chunks.
  - `--apply` embeds only them.
  - A refusal over the cap or for an unpriced model reads the scoped census, and the receipt agrees with the dry run.
  - The progress and terminal-state censuses still pass, and help-surface parity covers the flag.
- **Depends on**: Task 5

### Task 11: Belief vector scorer and loader
- **Files**: `src/core/brain/belief-semantic.ts` (new), `tests/core/brain/belief-semantic.test.ts` (new).
- **Acceptance**:
  - The pure `scoreBeliefsByVector` returns max-cosine per path over the injected vectors, a stable order, `unembedded` paths and the count scored.
  - `loadBeliefSemanticRelevance` reads stored vectors of `Brain/preferences/` and `Brain/retired/` notes from a fixture index.
  - Rows from another model or dimension count as unembedded.
  - The query is embedded once with the `query` prefix (counting provider).
  - A blocked tier and missing vec each refuse with their named code before any query embed (throwing provider). Zero usable vectors returns an empty map, not a refusal: the refusal is decided after the reach filter in task 13.
  - The report carries the model, price source, query tokens and nullable query cost.
- **Depends on**: Task 1

### Task 12: Semantic mode in packContext
- **Files**: `src/core/brain/context-pack.ts`, `tests/core/brain/context-pack-semantic.test.ts` (new), `tests/core/brain/context-pack-ranked-query.test.ts`.
- **Acceptance**:
  - In `semantic` mode with a relevance map, a paraphrased query with zero token overlap orders the closest belief first within its tier.
  - `scored` and `unembedded` are computed after the reach filter, so a withheld page appears in neither.
  - A `semantic` call without a map throws a named error.
  - `substring` and `ranked` output is byte-identical to the base.
  - The bench, planner and anticipatory cache callers compile unchanged.
- **Depends on**: Task 11

### Task 13: MCP surface for the semantic mode
- **Files**: `src/mcp/brain/pack-tools.ts`, `tests/mcp/context-pack-tool.test.ts`, the instruction-body and tool-census fixtures.
- **Acceptance**:
  - The schema enum accepts `semantic` and requires `query`.
  - A blocked tier and missing vec surface their stable codes on the wire.
  - When `semantic.scored` is 0 after the reach filter, the tool refuses with `BELIEF_VECTORS_MISSING`, naming `o2b search vector-backfill --path Brain/preferences/ --apply`. A reach-withheld page never changes that verdict.
  - The response carries the `semantic` report.
  - The surface parity and fixtures are updated by registration, not exclusion.
- **Depends on**: Task 12

### Task 14: Docs and skill
- **Files**: `docs/cli-reference.md`, `docs/how-it-works.md`, `docs/updating.md`, `docs/mcp.md`, `skills/embeddings-setup/SKILL.md`, the mirror under `plugins/codex/` via `bun run sync-plugin-mirrors`.
- **Acceptance**:
  - The docs describe the price pair, the fail-closed rule, `price unknown`, the credential report, vector carry-over, `--path` and the MCP `semantic` query mode.
  - `updating.md` names the behaviour change for gated vaults on unpriced models.
  - The stale "unlisted-model price is 0" sentence is gone.
  - `bun run sync-plugin-mirrors:check` passes.
  - The CHANGELOG entry and version bump are done in PR preparation (minor bump).
- **Depends on**: Tasks 1-13
