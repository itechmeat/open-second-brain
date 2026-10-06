You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

One release of Open Second Brain with four units that share one spine: every surface that turns a caller's query into a paid embedding obeys one rule, and managed-file upgrades write only bytes that still match what the plan read.

1. Reach and price gate on every query embed (follow-up from v1.72.0, no card). `brain_context_pack` semantic mode refuses a remote caller's query embed with `EMBEDDING_COST_UNPRICED` when `embedding_cost_gate_usd` is positive and the active embedding model has no known price (inline check in `src/core/brain/belief-semantic.ts:256-270`, which defaults an omitted reach to local). The search semantic lane (`src/core/search/semantic-phase.ts:133-140`, `runSemanticPhase`) embeds the query with no reach and no price check. It is reached by MCP `brain_search`, `brain_recall_feedback`, `brain_file_context`, `brain_eval`, `brain_benchmark`, `brain_tune`, and the `recall-inject` and `gap-promote` hooks (which pass no reach; `search()` resolves an omitted reach to remote via `resolvedTransportReach`). `SearchOptions.transportReach` already reaches `search()` but is not threaded into `runSemanticLane` / `runSemanticPhase`. The semantic phase has an explicit arm (caller asked for semantic: typed `SearchError`) and an implicit arm (warn + typed `RETRIEVAL_DEGRADATION` member, served keyword-only). `brain_recall_feedback` re-runs `search()` implicitly and records per-layer contributions into a learned-weight fold.

2. Compare-before-write in `applyUpgrade` (follow-up, no card). `src/core/brain/upgrade.ts:133-208`: `applyUpgrade(vault)` re-plans from scratch (the CLI already showed the operator its own plan; the self-heal worker planned too), takes a slow tar+zstd snapshot, then `atomicWriteFileSync(path, file.after)` for each `update` row with no check that disk still holds `file.before`. A hand edit to `_brain.yaml`, `_BRAIN.md` or a `Brain/preferences/*.md` file landing in that window is silently overwritten. Plan rows carry the full `before` string, but `before: ""` conflates an absent file with an empty one. Precedents for refusing on drift exist: note revert sealed plan digest (`notes/revert.ts:620-646`), migrate rollback digest mismatch, `writePreferenceTxn` expectRevision. `fs-atomic.ts` only offers `skipIfUnchanged` (compare against the NEW contents).

3. Card t_ddbfed93: truncate over-long search queries to the embedding input limit before embedding. No truncation exists on any query path. A declared per-model window exists: `EmbeddingModelPreset.inputWindowTokens` read by `declaredInputWindowTokens(model)` (null = unknown, never "fits"), used today only by the index-side oversize-chunk census, which subtracts the passage prefix the backend actually sends (`passagePrefixSentByProvider`). Token estimators: chars/4 floor (`estimateTokens`) and a two-sided ceiling (`tokenEstimateCeiling`) because chars/4 under-reports Han text about fourfold. No real tokenizer per provider. The query instruction prefix (`EmbedKind "query"`, e5 `"query: "`) is prepended inside `OpenAICompatProvider.embed`. MCP queries are capped at 2000 code points, which already exceeds the 512-token e5-small window. Most OpenAI-compatible serving stacks silently truncate over-long input; some refuse with HTTP 4xx (then explicit search throws, implicit degrades). The `brain_context_pack` semantic mode embeds a query too and discloses `query_tokens` without the prefix.

4. Card t_ebaac93f: configurable extra request body fields for OpenAI-compatible embedding endpoints. The body is fixed `{ model, input, encoding_format: "float" }` (`openai-compat.ts:459-463`). Config is a flat `key: value` YAML subset (no nested maps) parsed by hand, with env twins `OPEN_SECOND_BRAIN_EMBEDDING_<X>` and typed validators that fail with `INVALID_INPUT` naming the key. Identity of the vector index is `<provider>:<model>:<dimension>`; v1.72.0 precedent: a price is not part of the identity. Reserved-key refusal precedents: `RESERVED_UPDATE_FRONTMATTER_KEYS`, `RESERVED_REACH_ARGUMENTS` (normalised names).

# Project context

Open Second Brain: TypeScript on Bun, an MCP server + CLI over an Obsidian-compatible Markdown vault, SQLite + sqlite-vec search index. Current version 1.72.0.
Recent commits:
2b424d9a feat: honest embedding spend and a semantic belief order (v1.72.0) (#234)
2353cb1e feat: recall injection that arrives once and survives compaction (v1.71.0) (#232)
39c2f225 feat: scoped operator rules per project, harness and host, per-profile Hermes settings on a multiplexed gateway and readers that answer at the caller's reach (v1.70.0) (#229)
d49c4697 feat: ingest that reads CSV, TSV and HTML into table and parts sections, names the formats it skips and previews with o2b brain extract (v1.69.0) (#228)
f5c46615 feat: dependency facts from project manifests, Terraform seeds in the pre-extractor and readers that answer at the caller's reach (v1.68.0) (#227)
400b20ea feat: distillation pages that prove what they quote and say how much of their source the vault holds (v1.67.0)
3ec2334a feat: stable error codes on the MCP wire, typed rerank degradation and a rerank doctor check (v1.66.0) (#225)
a1ecfe7b feat: unattended maintenance recipes, install-owned lane tasks and an MCP fault guard (v1.65.0) (#224)
4499698c feat: search that honours pins and event time, diagnostics that prove action, writes that name their residue (v1.64.0) (#223)
a0b3c2e0 feat: exactly-one binding for mentions and imports, once-only write receipts, selectable search breadth and per-device ledgers (v1.63.0) (#222)
f4f9e3e6 feat: silent failures surface by name in redaction, receipts, ingest, search store, doctor (v1.62.0) (#220)
eb3c4c85 docs: concise README, ZCode client page, CLI reference and safety notes moved to child pages (#219)
f22df2c5 chore(apb): zg search, code-ranker and OpenCodeReview before push, scope-scan hardening (#218)
83979b9d fix: MCP startup off the upgrade path, fair ingest locks, inline plugin MCP manifest, inbox archive (v1.61.0) (#217)
3e59f319 feat: decision-model uses, adapters and setup skill (v1.60.0) (#215)
eacad953 feat: optional decision-model core and decision-model rerank kind (v1.59.0) (#214)
0afa0c5a chore(deps): bump the bun-minor-and-patch group with 5 updates (#201)
f6212cd2 fix: quiet one-line Stop reminder via Claude Code feedback channel (v1.58.2) (#202)
534befdb chore(deps): bump the github-actions group with 3 updates (#200)
5c550263 fix: session capture off the hook path, registry scanner hygiene (v1.58.1) (#199)
Related files:
src/core/search/semantic-phase.ts, src/core/search/pipeline/semantic-lane.ts, src/core/search/search.ts, src/core/search/types.ts, src/core/search/feedback.ts, src/core/search/embedding-spend.ts, src/core/search/retrieval-trail.ts, src/core/brain/belief-semantic.ts, src/core/brain/recall-inject.ts, src/core/brain/gaps/gap-recall.ts, src/core/search/embeddings/{openai-compat,presets,signature,pricing,contract}.ts, src/core/search/index.ts (config resolution), src/core/search/indexer.ts (census), src/core/brain/upgrade.ts, src/core/maintenance/self-heal-upgrade.ts, src/cli/brain/verbs/upgrade.ts, src/core/fs-atomic.ts
Conventions:
- SOLID, KISS, DRY; repeated literals hoisted into named constants; closed vocabularies registered as const objects.
- Errors surface explicitly by name (typed SearchError codes, BrainUpgradeError); no silent fallbacks; unknown reads as unknown, never as "fits" or "free".
- No hardcoded natural-language phrases beyond English messages; other languages handled abstractly (no per-language tables).
- Every release documents behaviour changes in CHANGELOG, docs/cli-reference.md, docs/how-it-works.md, docs/mcp.md, docs/updating.md.
- Config keys are flat `embedding_<noun>` with env twin; absent key = byte-identical old behaviour.
Constraints:
- No new external dependencies (no tokenizer libraries).
- Do not widen visibility: hooks keep their resolved reach (remote by default) because reach also filters reserved pages.
- Do not change existing public MCP argument names; additive response fields only.
- The extra body must never override `model`, `input` or `encoding_format`.
- Truncation never guesses a window: a model with no declared window is not truncated.

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
