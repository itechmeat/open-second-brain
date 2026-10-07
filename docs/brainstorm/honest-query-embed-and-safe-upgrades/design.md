# Honest Query Embed and Safe Upgrades - one rule for every paid query embed, and upgrades that write only what the plan read

**Status:** draft
**Author:** Open Second Brain maintainers (via feature-release-playbook)
**Audience:** implementation
**Target version:** 1.73.0 (minor: new config keys, new refusal on a search path, new degradation codes)

## Problem statement

In v1.72.0, `brain_context_pack` refuses a remote caller's query embed when the model has no known price and `embedding_cost_gate_usd` is positive. The search semantic lane embeds every query with no reach check and no price check. Six MCP tools (`brain_search`, `brain_recall_feedback`, `brain_file_context`, `brain_eval`, `brain_benchmark`, `brain_tune`) and two hooks therefore let a remote caller spend the operator's money on an unpriced model, despite the positive gate. The v1.72.0 release notes document this asymmetry.

The query is also sent at any length. A model with a 512-token window, served by an OpenAI-compatible stack, either silently describes a prefix of the query or refuses the request. The request body is fixed, so an endpoint that needs an extra field (Matryoshka `dimensions`, gateway metadata) cannot be used.

On the write side, `applyUpgrade` re-plans, takes a slow snapshot, then overwrites each managed file with bytes computed from what it read before the snapshot. A hand edit that lands in that window is silently lost.

## Premise verdicts (authoritative for scope)

Every claim was checked against the live source at `2b424d9a` (v1.72.0) before the brainstorm, using the zg index and direct reads. No card is refused. Each one is confirmed, and four claims needed correcting.

| Item | Verdict | Corrections and what is built |
|---|---|---|
| Follow-up: reach for `brain_search` and `brain_recall_feedback` (no card) | confirmed, widened | (1) The ungated site is one function, `runSemanticPhase` (`src/core/search/semantic-phase.ts:133-140`). It is reached by six MCP tools and the `recall-inject` and `gap-promote` hooks, not two tools. (2) `brain_recall_feedback` already passes the caller's reach into `search()` (`src/mcp/search-tools.ts:1502`). The gap is downstream: `search.ts` builds `semanticLaneInput` without reach, and neither `runSemanticLane` nor `runSemanticPhase` accepts one. (3) `belief-semantic.ts:224` resolves an omitted reach to local, while the rest of the tree (`resolvedTransportReach`) resolves it to remote. (4) The docblock at `src/core/search/types.ts:904-907` claims that recall feedback passes local reach, which is stale. Built: one shared gate that both query-embed sites call, with reach threaded into the lane. |
| Follow-up: compare-before-write in `applyUpgrade` (no card) | confirmed, extended | (1) `applyUpgrade` re-plans internally (`src/core/brain/upgrade.ts:139`), so the plan the CLI shows for confirmation, and the plan the self-heal worker computes, are not the plan applied. (2) Plan rows record `before: ""` for both an absent file and an empty file (`upgrade.ts:226`, `:257`). (3) The upgrade's preference repair does not take the per-file sync lock that `writePreferenceTxn` uses. Built: the applied plan is the caller's plan, every `update` row is checked against the disk before the first write and again right before its own rename, and drift is refused by name. |
| t_ddbfed93 truncate over-long queries | confirmed, corrected | (1) The validator anchor `semantic-phase.ts:135` is the `makeProvider` line; the embed is at `:136`. (2) "No per-input max-token configuration exists" is true for operator config, but a declared per-model window exists: `EmbeddingModelPreset.inputWindowTokens`, read by `declaredInputWindowTokens` (`presets.ts:37-53`, `:166-169`). Today only the index-side census reads it. (3) "The failure is already loud" holds only for serving stacks that refuse over-long input. The presets docblock (`presets.ts:37-46`) records that OpenAI-compatible stacks usually truncate silently and report nothing. The change therefore turns a silent server-side cut into a disclosed client-side cut, and a refusal into a working semantic lane. (4) A second query-embed site, `belief-semantic.ts:272`, must share the fit. Its disclosed `query_tokens` (`:273`) leaves out the instruction prefix the provider sends. (5) The 2000-code-point MCP cap already exceeds the 512-token e5-small window, so the problem is reachable over MCP today. Built: query fit to an effective window, with an operator key to declare the window of an uncurated model. |
| t_ebaac93f extra request body fields | confirmed, anchor corrected | (1) The validator anchor `openai-compat.ts:457` is the `authorization` header; the body is at `:459-463`. (2) No passthrough exists in any provider (`rg extraBody\|extra_body` over `src` finds nothing). (3) The config file cannot hold a nested map (`parseSimpleYaml`, `src/core/config.ts:146-170`), so the value is a JSON object in one flat key. Built for `openai-compat` only. ZeroEntropy is not an OpenAI-compatible endpoint, and the card names the rerank twin only as optional; both are deferred. |

## Scope

- **One query-embed gateway.** This is a new module, `src/core/search/embeddings/query-embed.ts`. `prepareQueryEmbed(config, query, reach)` returns a discriminated result:
  - `{ kind: "refused", code: "EMBEDDING_COST_UNPRICED", model }` when all three hold: reach is not local, `semantic.costGateUsd > 0`, and `activeSpendQuote(config).quote.source` is `unknown`.
  - Otherwise `{ kind: "ready", text, truncated, sentTokens, windowTokens, quote, model }`.

  The gate keeps v1.72.0's rule exactly (the unpriced arm only, never over-cap). It is now the one place that rule lives.
- **Reach threaded into the semantic lane.** `search()` passes the resolved `transportReach` into `SemanticLaneInput`, then into the `runSemanticPhase` options. The phase calls `prepareQueryEmbed` after the capability guard and before `makeProvider`. A refusal follows the phase's existing two arms:
  - explicit (`semantic: true`): throws `SearchError("EMBEDDING_COST_UNPRICED", ...)`, whose message names the model, `embedding_cost_gate_usd` and the price pair;
  - implicit: a warning plus the new `RETRIEVAL_DEGRADATION.semanticCostUnpriced`. The lane is not attempted, so `hybridDegraded` fires on its own.

  A query-cache hit still returns before any lane, and still spends nothing.
- **Query fit (t_ddbfed93).** The effective window is the operator key `embedding_input_window_tokens` when set, otherwise `declaredInputWindowTokens(model)`, otherwise unknown. When the window is known:
  - the budget is the window minus the ceiling estimate of the prefix the backend actually sends (`queryPrefixSentByProvider`, an exhaustive twin of `passagePrefixSentByProvider`);
  - the query is cut to the longest code-point prefix whose `tokenEstimateCeiling` fits the budget.

  An unknown window means no cut and no new warning, which is byte-identical to today. A cut search reports the warning plus `RETRIEVAL_DEGRADATION.semanticQueryTruncated` (`detail.windowTokens`). The lane still runs, so `hybridDegraded` does not fire.
- **Effective window feeds the census too.** `censusChunkWindow` reads the same resolver, so an operator-declared window also enables the oversize-chunk census for an uncurated model. One resolver means one answer.
- **Semantic belief order adopts the gateway.** `loadBeliefSemanticRelevance` replaces its inline gate with `prepareQueryEmbed`. An omitted reach now resolves through `resolvedTransportReach`, as everywhere else. The only production caller already passes reach. The embed sends the fitted text. The disclosed `query_tokens` is the estimate for the text actually sent, prefix included. A cut adds a warning to the existing `warnings` array.
- **Recall feedback discloses a gated re-run.** `captureRecallFeedback` returns the re-run's degradation codes, and the `brain_recall_feedback` response gains an additive `degraded` array. The recorded contributions still describe the ranking the caller's own search produces under the same rule. Neither the recording nor the fold changes.
- **Hook refusals become visible.** The recall retrievers carry the search trail's degradation codes into their result. `recall-inject` writes them to its local audit line, so a gated or degraded semantic lane at the hook is no longer silent. `plugins/hermes/_schemas.py` vendors no `brain_recall_feedback` response shape (verified), so it is untouched.
- **Hooks keep their reach.** `recall-inject` and `gap-promote` pass no reach today, so they resolve to remote, which also keeps reserved pages out of injected context. They are not widened. Under a positive gate with an unpriced model, their semantic lane therefore degrades by name. That is the gate doing its job on the most frequent embed in the system. The fix for a self-hosted model is to declare its price (0 for free), documented in `docs/updating.md`.
- **Extra request body (t_ebaac93f).** A new optional key, `embedding_extra_body`, with env twin `OPEN_SECOND_BRAIN_EMBEDDING_EXTRA_BODY`, holds a JSON object as a string.
  - Resolution refuses each of these with `INVALID_INPUT`, naming the key (and the env variable when it is the source): a blank value, invalid JSON, a non-object, and any key in `RESERVED_EMBEDDING_BODY_KEYS` (`model`, `input`, `encoding_format`). A reserved key is matched after the same normalisation `reach-refusal.ts` uses (NFC, lower case, `_` and `-` dropped), and the refusal lists the offending spellings.
  - `OpenAICompatProvider` spreads the fields into the request body before the owned fields, so the owned fields win structurally as well.
  - The fields are not part of the embedding identity, following the v1.72.0 price precedent. A width change caused by `dimensions` is caught by the existing response and index dimension checks, and a test pins that.
  - The egress row for `search-embedding-openai-compat` gains one sentence.
- **Compare-before-write upgrades.**
  - Plan rows record `before: string | null`, with null for an absent file. The JSON plan render keeps `before_size`, reporting 0 for null.
  - `fs-atomic.ts` gains the `expectBefore?: string | null` option on `atomicWriteFileSync`. It re-reads the target right before the rename and throws `FileDriftError` (with an `isFileDrift` guard), naming the path, when the target's state differs: present versus absent, or different bytes.
  - `applyUpgrade(vault, { plan? })` applies the caller's plan when given and plans itself otherwise. The CLI passes the plan it showed and the self-heal worker passes the plan it computed, which also removes the worker's double plan.
  - Before the snapshot, every `update` row is checked against the disk. Any drift refuses the whole run with `BrainUpgradeError`, with `runId` null, a `drifted` path list, and a message naming each path plus the re-run command. Nothing is written and no snapshot is taken.
  - Each write then passes `expectBefore: file.before`. A drift detected after earlier rows were written reuses the mid-apply message, which carries the rollback command.

## Out of scope

- An over-cap arm on the query gate. One query embed against a per-run spend cap is not a meaningful comparison, and v1.72.0 gates only the unpriced arm. Unchanged.
- Widening hook reach to local. It would leak reserved pages into injected context.
- A real tokenizer per provider (no new dependency). The ceiling estimate over-cuts non-ASCII text. That is the safe direction, and it is documented.
- Cutting at grapheme or word boundaries. The cut is at a code-point boundary, which is language-agnostic and never splits a surrogate pair.
- Extra body for ZeroEntropy, the rerank endpoint and the decision model. Extra headers are also out.
- An extra body per registry profile.
- Taking the self-heal worker lock in CLI `--apply`, and taking the per-file preference sync lock inside the upgrade. Compare-before-write turns both races from silent loss into a named refusal. The remaining window, between the final read and the rename, is the same advisory window `skipIfUnchanged` has, and it is documented.
- The hygiene dedup and entity alias detectors' live embeds. They still have no production caller, as v1.72.0 noted.

## Chosen approach

This is consultant Variant 2, "Query-embed gateway module plus drift-checked writes", accepted with three overrides.

**Override 1: key name `embedding_extra_body`, not `embedding_request_extra`.** The card, and the OpenAI client libraries operators already know, call this `extra_body`. The name says what it is.

**Override 2: an operator-declared window key.** The consultant left truncation to the curated preset table, which would cut queries for six local models only. An operator on any other model would have no way to declare a window, the same gap that v1.72.0 closed for prices with the price pair. `embedding_input_window_tokens` is a declared value with no default. Absent means unknown, and unknown means no cut.

**Override 3: drift is checked before the snapshot as well as at each write.** The per-write `expectBefore` alone would detect drift only after the slow snapshot and possibly after earlier rows were rewritten. A pre-flight pass refuses a run that is already stale, with nothing written and no snapshot to roll back.

Variant 1 (rules inside the provider) was rejected because it leaks cost and reach policy into the adapter that also serves indexing. Variant 3 (a policy assembled at each entry point, plus a plan digest) was rejected because it enforces the rule by convention and leaves the snapshot window open.

## Design decisions

- **A discriminated result, not a thrown refusal, from the gateway.** The two callers surface a refusal differently: the search lane has explicit and implicit arms, while the context pack always refuses. Returning data keeps one computation and lets each caller decide how to report it, without catch-by-code.
- **Reach and price only, not "remote" as a proxy for "paid".** The local hashing embedder is priced at 0 (`builtin`), so it is never refused. An Ollama or LM Studio model is unpriced until the operator declares it, as in v1.72.0.
- **Ceiling estimate for the cut, floor estimate for spend.** The cut must never send more than the window, so it uses the bound that cannot under-count. Spend disclosure keeps the shared `estimateTokens` the rest of the spend plan uses, so the receipts stay comparable.
- **A cut is reported as a degradation.** The lane ran on a prefix of what the caller sent. The trail vocabulary exists to say why recall narrowed, and the rule that `detail` carries integers only holds (`windowTokens`).
- **Extra-body fields are spread first, owned fields last.** Refusal is the primary guard, and the ordering is defence in depth, so a future reserved key cannot be overridden by accident.
- **`expectBefore` lives in `fs-atomic.ts`.** It is a reusable compare-and-swap primitive next to `skipIfUnchanged`, named like `FileAlreadyExistsError`, and other managed writers can adopt it later without a second implementation.
- **The applied plan is the shown plan.** The operator confirmed specific paths and diffs. Applying a re-plan could write something they never saw.

## File changes

New:
- `src/core/search/embeddings/query-embed.ts`: `prepareQueryEmbed`, `fitQueryToWindow` and the result types.
- `tests/core/search/query-embed.test.ts`, `tests/core/search/semantic-phase-spend-gate.test.ts`, `tests/core/search/embeddings.extra-body.test.ts`, `tests/core/search/embeddings.input-window.test.ts`, `tests/core/brain/upgrade-drift.test.ts`.

Modified:
- Search lane: `src/core/search/semantic-phase.ts`, `src/core/search/pipeline/semantic-lane.ts`, `src/core/search/search.ts`, `src/core/search/types.ts` (the reach docblock, `inputWindowTokens?`, `extraBody?`), `src/core/search/retrieval-trail.ts` (two members, closed list, sentences).
- Embedding configuration: `src/core/search/index.ts` (two keys, validation), `src/core/search/embeddings/presets.ts` (`queryPrefixSentByProvider`, `effectiveInputWindowTokens`), `src/core/search/embeddings/openai-compat.ts`, `src/core/search/indexer.ts` (census via the resolver).
- Readers: `src/core/brain/belief-semantic.ts`, `src/core/search/feedback.ts`, `src/mcp/search-tools.ts` (additive `degraded`), `src/core/brain/recall-inject.ts` and `src/core/brain/gaps/gap-recall.ts` (carry the trail codes to the local audit).
- Upgrade: `src/core/fs-atomic.ts`, `src/core/brain/upgrade.ts`, `src/cli/brain/upgrade-render.ts`, `src/cli/brain/verbs/upgrade.ts`, `src/core/maintenance/self-heal-upgrade.ts`.
- Docs (phase 5): `CHANGELOG.md`, `README.md`, `docs/cli-reference.md`, `docs/how-it-works.md`, `docs/mcp.md`, `docs/updating.md`, `skills/embeddings-setup/SKILL.md` (then `bun run sync-plugin-mirrors`).
- Version manifests via `scripts/sync-version.ts`.

## Risks and open questions

- **Hook behaviour under a positive gate.** Operators who run a positive gate with an unpriced self-hosted model lose the semantic lane of recall injection until they declare a price. This is intended, but it is visible, so it gets its own `docs/updating.md` section. Spec review confirmed that `defaultRecallRetriever` (`src/core/brain/recall-inject.ts:1122-1160`) maps only `outcome.results` and drops `warnings` and the retrieval trail. Every semantic degradation is already silent at the hook today, so the new refusal would be too. This PR carries the trail codes into `RecallResultSet` and onto the local audit line `recallInjectAuditDetails` (`:1053-1077`), next to the decision-model degrade reason. Codes only; the synced telemetry record stays unchanged.
- **Tests that pin the old asymmetry.** `tests/core/brain/belief-semantic.test.ts:464` and `tests/mcp/context-pack-tool.test.ts:875-910` pin "local caller ungated". That stays true, so they should stay green. Tests that call `loadBeliefSemanticRelevance` with no reach under a positive gate change meaning, and must be audited and pass reach explicitly.
- **MCP harness tests without reach.** `tests/mcp/embedding-abi-visibility.test.ts` uses an unpriced `fake-model` with no reach (so remote) and gate 0. It stays green because the gate is off. Any test combining a positive gate with an unpriced model and no reach will change meaning.
- **`dimensions` in the extra body.** It must be verified that a width differing from the stored index surfaces as a named error and not as an empty result. If it does not, `dimensions` that disagrees with `embedding_dimension` is refused at config resolution.
- **Non-atomic compare and rename.** A write landing between the final re-read and `rename(2)` is still lost. Closing that needs an OS-level lock that the vault's sync tools do not honour, so it is documented, not solved.
- **`before: null` type change.** It touches the planner, the renderer, the worker and the tests. The JSON contract keeps `before_size`, so no consumer breaks.
