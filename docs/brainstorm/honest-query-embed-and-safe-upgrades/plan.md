# Honest Query Embed and Safe Upgrades - implementation plan

Every task is TDD: write the failing test, watch it fail for the expected reason, implement, refactor green. Run the formatter and linter before every commit (`bun run fmt`, `bun run lint`, `bun run typecheck`). One conventional commit per task.

## Tasks

### Task 1: Effective input window and the query prefix the backend sends
- **Files**: `src/core/search/types.ts` (`inputWindowTokens?` on `ResolvedEmbeddingConfig`), `src/core/search/index.ts` (key `embedding_input_window_tokens` / env `OPEN_SECOND_BRAIN_EMBEDDING_INPUT_WINDOW_TOKENS`, `parseInteger(raw, 0, key, { min: 1 })`, and post-merge validation in `validateResolvedConfig`), `src/core/search/embeddings/presets.ts` (`effectiveInputWindowTokens(semantic)`: operator key, then `declaredInputWindowTokens(model)`, then null; `queryPrefixSentByProvider(provider, configuredQueryPrefix)` as an exhaustive switch), `src/core/search/indexer.ts` (`censusChunkWindow` reads `effectiveInputWindowTokens`), `tests/core/search/embeddings.input-window.test.ts`.
- **Acceptance**:
  - absent key: the field stays absent and the `Object.keys(semantic)` pin in `embeddings.batch-tokens.test.ts` is unchanged;
  - config and env both set the key;
  - 0, a fraction and a blank value are refused with `INVALID_INPUT` naming the key, both from the string and from an override;
  - the operator key beats the preset window, the preset window applies when the key is absent, and an unknown model with no key resolves to null;
  - `queryPrefixSentByProvider` returns the configured query prefix only for `openai-compat`;
  - the census reports an over-window chunk for an uncurated model once the key is set.
- **Depends on**: none

### Task 2: Query fit to the window
- **Files**: `src/core/search/embeddings/query-embed.ts` (`fitQueryToWindow(query, prefix, windowTokens | null)` returning `{ text, truncated, sentTokens }`), `tests/core/search/query-embed.test.ts`.
- **Acceptance**:
  - a null window returns the query unchanged with `truncated: false`;
  - an ASCII query over the window is cut so that `tokenEstimateCeiling(prefix + text) <= window`, and one more code point would exceed it;
  - a Han query is cut under the ceiling bound, never the floor;
  - a cut never splits a surrogate pair (an astral-plane character at the boundary);
  - a prefix that alone fills the window gives an empty text with `truncated: true`, and the caller treats that as a degradation, not an embed;
  - `sentTokens` counts the prefix.
- **Depends on**: Task 1

### Task 3: The query-embed gateway (reach and price gate)
- **Files**: `src/core/search/embeddings/query-embed.ts` (`prepareQueryEmbed(config, query, reach)` returning `refused | ready`, using `activeSpendQuote`, `COST_GATE_KEY`, `EMBEDDING_PRICE_SOURCE`, `TRANSPORT_REACH`), `tests/core/search/query-embed.test.ts`.
- **Acceptance**:
  - remote + positive gate + unpriced: `refused`, carrying the model;
  - local + positive gate + unpriced: `ready`;
  - remote + gate 0: `ready`;
  - remote + positive gate + operator-priced: `ready`;
  - the local provider: `ready` (builtin price 0);
  - the `ready` result carries the fitted text from Task 2 and the quote;
  - no provider is constructed by the gateway (it is pure over config).
- **Depends on**: Task 2

### Task 4: Reach threaded into the semantic lane, gated and fitted
- **Files**: `src/core/search/search.ts` (pass the resolved reach into `semanticLaneInput`), `src/core/search/pipeline/semantic-lane.ts` (`SemanticLaneInput.transportReach`, forwarded), `src/core/search/semantic-phase.ts` (reach in opts, `prepareQueryEmbed` after the capability guard, the explicit arm throws `EMBEDDING_COST_UNPRICED` naming the model, the gate key and the price pair, the implicit arm warns plus `semanticCostUnpriced`, a cut warns plus `semanticQueryTruncated { windowTokens }`, the fitted text is embedded), `src/core/search/retrieval-trail.ts` (two members, the closed list, the sentence switch), `src/core/search/types.ts` (fix the stale reach docblock at `:904-907`), `tests/core/search/semantic-phase-spend-gate.test.ts`.
- **Acceptance**, using `startFakeHttp` and `callCount()`:
  - remote implicit search under a positive gate and an unpriced model sends no embed, returns keyword results, and the trail carries `semantic-cost-unpriced` and `hybrid-degraded`;
  - remote explicit search throws `EMBEDDING_COST_UNPRICED` with `callCount() === 0`;
  - local search embeds once;
  - an MCP `brain_search` over `MCPServer({..},{ reach: "remote" })` refuses before the embed, and a local server embeds once;
  - an over-window query with a declared window embeds the cut text (the captured `input` length is checked) and the trail carries `semantic-query-truncated` without `hybrid-degraded`;
  - the existing `semantic-degrade-quota`, `semantic-explicit-blocked`, `capability-tier` and `hybrid-deadline` tests stay green.
- **Depends on**: Task 3

### Task 5: The semantic belief order adopts the gateway
- **Files**: `src/core/brain/belief-semantic.ts` (replace the inline gate with `prepareQueryEmbed`, resolve an omitted reach with `resolvedTransportReach`, embed the fitted text, `queryTokens` from the gateway, a cut warning in `warnings`, fix the docblocks at `:85-86` and `:257-260`), `tests/core/brain/belief-semantic.test.ts`, `tests/mcp/context-pack-tool.test.ts`.
- **Acceptance**:
  - the existing remote refusal (`:449`) and local embed (`:464`) tests stay green;
  - a call with no reach under a positive gate and an unpriced model is now refused;
  - the disclosed `query_tokens` includes the instruction prefix for an e5 model;
  - an over-window query is embedded cut, with one warning;
  - the wire test `:875` stays green.
- **Depends on**: Task 3

### Task 6: Recall feedback discloses the gated re-run
- **Files**: `src/core/search/feedback.ts` (the outcome gains `degraded: ReadonlyArray<RetrievalDegradationCode>` from the re-run trail), `src/mcp/search-tools.ts` (additive `degraded` in the `brain_recall_feedback` response), `tests/mcp/recall-feedback-tool.test.ts`.
- **Acceptance**:
  - a remote feedback call under a positive gate and an unpriced model sends no embed, records the event, and returns `degraded` containing `semantic-cost-unpriced`;
  - a local call embeds once and returns an empty `degraded`;
  - the CLI twin `learned-weights` is unchanged.
- **Depends on**: Task 4

### Task 7: Hook refusals become visible
- **Files**: `src/core/brain/recall-inject.ts` (`RecallResultSet.degraded`, filled from `outcome.retrievalTrail?.degraded` in `defaultRecallRetriever`; the codes are carried onto `recallInjectAuditDetails`), `src/core/brain/gaps/gap-recall.ts` (the same codes on `gapScopedRecallRetriever`'s result), `tests/core/brain/recall-inject*.test.ts`, `tests/core/brain/gaps/*.test.ts`.
- **Acceptance**:
  - the recall-inject retriever under a positive gate and an unpriced model sends no embed, returns keyword candidates, and its result carries `semantic-cost-unpriced`;
  - the local audit details carry the codes;
  - the synced telemetry metadata (`recallInjectTelemetryMetadata`) is unchanged;
  - no hook passes local reach (the reserved-page filter is unchanged);
  - existing recall-inject and gap-promote tests stay green.
- **Depends on**: Task 4

### Task 8: Extra request body for OpenAI-compatible endpoints
- **Files**: `src/core/search/types.ts` (`extraBody?: Readonly<Record<string, unknown>>`), `src/core/search/index.ts` (key `embedding_extra_body` / env `OPEN_SECOND_BRAIN_EMBEDDING_EXTRA_BODY`, JSON object parse, `RESERVED_EMBEDDING_BODY_KEYS` with normalised matching, `INVALID_INPUT` naming the key or env variable and the refused spellings), `src/core/search/embeddings/openai-compat.ts` (spread `extraBody` before the owned fields), `tests/core/search/embeddings.extra-body.test.ts`.
- **Acceptance**:
  - absent key: the request body is exactly `{ model, input, encoding_format }` (a new pin via the fake-http handler body);
  - a declared `{ "dimensions": 256, "user": "x" }` arrives in the body next to the owned fields;
  - each of `model`, `Input`, `encoding-format` is refused, naming the spelling;
  - invalid JSON, an array, a scalar and a blank value are each refused, naming the key;
  - an env value beats config;
  - the embedding identity is unchanged by the key (no reindex is required);
  - a response width that differs from the stored index surfaces as a named error, not an empty result (if not, refuse a `dimensions` that disagrees with `embedding_dimension` at resolution and pin that instead).
- **Depends on**: none

### Task 9: Compare-before-write primitive
- **Files**: `src/core/fs-atomic.ts` (`AtomicWriteOptions.expectBefore?: string | null`, `FileDriftError`, `isFileDrift`), `tests/core/fs-atomic.test.ts`.
- **Acceptance**:
  - matching bytes write;
  - different bytes throw `FileDriftError` naming the path and leave the target untouched;
  - `null` with an absent target writes, and `null` with a present target throws;
  - a string expectation with an absent target throws;
  - the option composes with `skipIfUnchanged`;
  - no temp file is left after a refusal.
- **Depends on**: none

### Task 10: Upgrades apply the shown plan and refuse drift
- **Files**: `src/core/brain/upgrade.ts` (`before: string | null`, `applyUpgrade(vault, { plan?, agent?, now? })`, a pre-snapshot drift pass, `expectBefore` per write, `BrainUpgradeError.drifted`), `src/cli/brain/upgrade-render.ts` (null-safe `before_size` and diff), `src/cli/brain/verbs/upgrade.ts` (pass the shown plan), `src/core/maintenance/self-heal-upgrade.ts` (pass its plan; drop the double plan), `tests/core/brain/upgrade-drift.test.ts`, `tests/core/brain/upgrade.test.ts`, `tests/core/maintenance/self-heal-upgrade.test.ts`, `tests/cli/brain-upgrade.test.ts`.
- **Acceptance**:
  - a missing `_brain.yaml` plans `before: null`, and an empty one plans `before: ""`;
  - a hand edit made after the plan and before the apply refuses with `drifted` naming the path, no snapshot is created, and the edit survives;
  - an edit injected between the snapshot and the write (via a spy on `createSnapshot`) refuses at that row with the rollback command, and the edit survives;
  - a clean apply is unchanged (snapshot, log row, idempotent re-run);
  - the CLI `--apply --yes` applies the plan it printed;
  - the worker calls `planUpgrade` once per attempt;
  - all existing upgrade, self-heal and CLI tests stay green.
- **Depends on**: Task 9

### Task 11: Docs, CHANGELOG and version 1.73.0 (phase 5, in osb-pr-prepare)
- **Files**: `CHANGELOG.md` (`## [1.73.0] - YYYY-MM-DD` with the day the PR is prepared and the compare link), `README.md` ("What is new"), `docs/cli-reference.md` (both keys, the query gate, the egress sentence), `docs/how-it-works.md` (the gateway bullet, plus a correction to the 1.72.0 "as for search" sentence in the current-behaviour text), `docs/mcp.md` (the `brain_search` spend refusal, `brain_recall_feedback.degraded`, the two degradation codes), `docs/updating.md` ("Upgrading to 1.73.0": hooks under a positive gate, declare a price for a self-hosted model), `skills/embeddings-setup/SKILL.md`, then `bun run sync-plugin-mirrors`, the `package.json` bump plus `bun run scripts/sync-version.ts`.
- **Acceptance**: `bun run sync-version:check` and `bun run sync-plugin-mirrors:check` pass; every key, code and command named in the docs exists in the source.
- **Depends on**: Tasks 1-10
