### Variant 1: Provider choke point
- **Approach**: Move every query-embed rule into the embedding provider layer: `embed(texts, { kind, reach })` performs the reach-and-price gate, the window truncation (it already knows the prefix it prepends) and the extra-body merge, so `belief-semantic.ts` drops its inline check and `runSemanticPhase` only threads `transportReach` through. Compare-before-write lands as a new `expectBefore` option on `atomicWriteFileSync` in `fs-atomic.ts` with a tri-state expectation (absent, or exact bytes), and `applyUpgrade` passes each row's `before` through it.
- **Trade-offs**:
  - Pro: literally one place; impossible to add a query surface that bypasses the rule.
  - Pro: truncation sees the real prefix and model window, no mirrored estimate needed.
  - Con: the provider also serves index-side passage embeds, so the gate must be keyed on `kind` and reach must be invented for the indexer; cost policy and transport reach leak into a transport adapter.
  - Con: refusal surfaces as a provider error that `semantic-phase` must map back onto its explicit/implicit arms and `brain_context_pack` onto `EMBEDDING_COST_UNPRICED`, so the typed-code mapping is duplicated anyway.
  - Con: `query_tokens` disclosure and `truncated` flag have to travel back up through a result shape change on `embed()`.
- **Complexity**: large
- **Risk**: medium

### Variant 2: Query-embed gateway module plus drift-checked writes
- **Approach**: Add one module (`src/core/search/embeddings/query-embed.ts`) exporting `prepareQueryEmbed({ query, reach, model, config })` that returns either a typed refusal (`EMBEDDING_COST_UNPRICED`) or a prepared input (`text`, `truncated`, `estimatedTokens` using the ceiling estimator minus a `queryPrefixSentByProvider` twin of the passage-prefix helper; no declared window means no truncation). `belief-semantic.ts` and `runSemanticPhase` both call it, with `search()` threading `transportReach` into `runSemanticLane`; the explicit arm throws, the implicit arm records the existing `RETRIEVAL_DEGRADATION` member, and `brain_recall_feedback` inherits the behaviour unchanged. Extra body is one flat key `embedding_request_extra` holding a JSON object string with env twin, validated against a `RESERVED_EMBEDDING_BODY_KEYS` const, excluded from index identity. `applyUpgrade(vault, plan?)` accepts the plan the caller already showed, snapshots, then writes each row through a new `expectBefore` option on `atomicWriteFileSync` (tri-state: `null` for absent) and raises `BrainUpgradeError` `UPGRADE_DRIFT` naming the files whose bytes moved.
- **Trade-offs**:
  - Pro: one rule in one named module, but the module stays query-specific so the indexer is untouched.
  - Pro: refusal codes, truncation disclosure and reach resolution are computed once and returned as data, so the two call sites only differ in how they surface them.
  - Pro: `expectBefore` is a reusable compare-and-swap primitive that mirrors `writePreferenceTxn` expectRevision and can be reused by other managed writers later.
  - Con: `before: ""` must become `before: string | null` in plan rows, a type change across planner, CLI renderer and self-heal worker.
  - Con: `embedding_request_extra` as a JSON string in flat YAML is a new value shape for the hand parser and its error message must name the key.
- **Complexity**: medium
- **Risk**: low

### Variant 3: Policy resolved at the entry points, plan-digest guarded upgrade
- **Approach**: `search()` and `brain_context_pack` each build a resolved `QueryEmbedPolicy` value (reach, price known, window or null) and pass it down; `runSemanticPhase` and `belief-semantic.ts` consume it through a small pure `applyQueryBudget(policy, query)` in `search/query-budget.ts`. Extra body fields use a flat prefix convention `embedding_body_<field>: value` with env twins, each scalar passed through as typed YAML, reserved names refused. `applyUpgrade(vault, sealedDigest)` keeps re-planning but seals the plan (digest over every row's path and `before`) like note revert, and refuses with `UPGRADE_PLAN_DRIFT` when the fresh plan's digest disagrees with the one the CLI or self-heal worker computed.
- **Trade-offs**:
  - Pro: smallest diff on the semantic lane; hooks and MCP callers need no change since reach resolution already happens in `search()`.
  - Pro: prefix keys fit the existing flat config vocabulary without a new value shape.
  - Con: the policy is assembled in two places, so the "one rule" is enforced by convention, not by a single function, and a new entry point can forget it.
  - Con: a plan digest guards the window between show-and-apply but not the window between re-plan and write, so a hand edit landing during the tar+zstd snapshot is still overwritten.
  - Con: prefix keys cannot express nested or array values, and the hand parser's unknown-key validation must learn a wildcard.
- **Complexity**: small
- **Risk**: medium

### Recommended: Variant 2
**Rationale**: The task's spine is "one rule on every surface", and only a query-specific gateway module makes that rule a single function both callers must go through without dragging cost policy into the provider adapter that also serves indexing. Its `expectBefore` write primitive closes the actual drift window at the moment of the write, which Variant 3's plan digest does not, and it follows the repo's existing expectRevision and sealed-digest precedents. The one JSON-object config key keeps the extra body expressive without a new wildcard key family in the hand-written YAML parser, and keeping it out of the index identity matches the v1.72.0 pricing precedent.
