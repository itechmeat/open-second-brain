You are brainstorming architectural variants for the following task. Do not write code. Do not write a final design. Only produce variants and a recommendation.

# Task

This is a MULTI-UNIT release wave for the project Open Second Brain: 11 related kanban units under one theme - "memory write-path integrity and store safety". Each unit ships in the same release on one feature branch as an atomic commit. Your variants must address HOW TO ARCHITECT THE WAVE AS A WHOLE (shared abstractions vs per-unit isolated changes, gate composition, error-type design, module layout), not re-litigate whether the units are worth doing.

## Unit t_657b365e (board priority 4): [upstream:signetai] Strip Markdown from entity labels and reject scaffolding names before graph persistence

**Source**: https://github.com/Signet-AI/signetai/releases/tag/v0.147.9
**Repo**: Signet-AI/signetai (183★)
**Released**: v0.147.9 (2026-07-11)

## What
Extend entity-name normalization to strip surrounding Markdown (`**`, `__`, `##`) and punctuation before quality checks, and reject generic scaffolding labels / discourse markers before graph persistence; add an operator-safe prune that removes historical malformed entity nodes without leaving orphaned graph rows. Mirrors Signet's "rejected markdown-polluted entity labels" (#914).

## Why useful for OSB
OSB already normalizes entity names via `normalizeEntityName` but only does NFC + whitespace collapse + lowercase — it does not strip Markdown/punctuation and does not reject junk/scaffolding labels. Downstream consumers (atomic-facts, fact-extract) inherit the limitation, so markdown-polluted or scaffolding entity names can reach graph persistence and fragment entity matching (e.g. `**Foo**` vs `foo` become different entities). Stronger normalization + a junk-label reject + a safe prune improves entity-graph quality and recall consistency.

## Status in OSB
- **Verdict**: present_weaker
- **Codegraph hints**: `src/core/brain/entities/canonical.ts:12-13` — `normalizeEntityName(raw)` = `raw.normalize("NFC").trim().replace(/\s+/g," ").toLowerCase()` only; NO Markdown/punctuation stripping, NO scaffolding/discourse rejection; `src/core/brain/atomic-facts.ts:116-120` and `src/core/brain/fact-extract.ts:206-210` reuse normalizeEntityName for entity matching, inheriting the limitation.

## Notes
Extend normalizeEntityName (or add a pre-quality-check strip pass) to remove surrounding Markdown emphasis/headings and surrounding punctuation. Maintain a denylist of generic scaffolding labels and discourse markers to reject before persistence. The operator-safe prune should delete malformed historical nodes and their edges transactionally to avoid orphaned graph rows; surface prune candidates via brain_hygiene/brain_doctor. Ensure changes to normalizeEntityName stay backward-compatible with the existing identity-key shape (`<category>:<normalized name>`).

## Unit t_e2b182b6 (board priority 4): [upstream:yantrikdb] NaN/all-zero embedding validation gate before vecUpsert (dimension-only today)

**Source**: https://github.com/yantrikos/yantrikdb/releases/tag/v0.9.3
**Repo**: yantrikos/yantrikdb (31★)
**Released**: v0.9.3 (2026-07-14T01:38:07Z)

## What
yantrikdb added a central contract gate that validates every embedding/scalar with typed `InvalidEmbedding {path,index,reason}` / `InvalidScalar` errors BEFORE any side effect on every entry path, catching external-embedder NaN (e.g. ONNX 0/0) and wrong-dimension vectors that previously panicked.

## Why useful for OSB
OSB validates embedding dimension before storing (`vecUpsert` throws `EMBEDDING_DIMENSION_MISMATCH`), but nothing checks that vector values are finite or non-zero: `vecToBuffer` writes NaN straight to the vec table and `unitNormaliseInPlace` silently returns an all-zero vector on zero norm. A broken OpenAI-compatible endpoint or a future local ONNX provider emitting NaN would poison that chunk's cosine distance (NaN distances → erratic/absent retrieval) with no error surfaced.

## Status in OSB
- **Verdict**: present_weaker
- **Codegraph hints**: dimension gate present (`src/core/search/store.ts:834-840` `vecUpsert`, `src/core/search/indexer.ts:611`, `src/core/search/embeddings/openai-compat.ts:332`); NaN/finite + all-zero gate absent (`src/core/search/store.ts:331-334` `vecToBuffer` does `Float32Array.from` with no validation; `src/core/search/embeddings/http-util.ts:48-55` `unitNormaliseInPlace` propagates NaN and returns an all-zero vector on zero norm with no error).

## Notes
Improvement, not net-new: add a finite/non-zero check at the single choke point `vecUpsert` (and optionally at provider-parse time in `unitNormaliseInPlace` / `openai-compat.ts:338`) so a bad embedder output is rejected with a typed error before it reaches the index, mirroring yantrikdb's pre-write contract gate. Scope is narrow — OSB already funnels all vector writes through `vecUpsert`.

## Unit t_375e98fd (board priority 3): [upstream:signetai] Deterministic durability gate rejecting transient operational content before persist

**Source**: https://github.com/Signet-AI/signetai/releases/tag/v0.147.9
**Repo**: Signet-AI/signetai (183★)
**Released**: v0.147.9 (2026-07-11)

## What
Add a deterministic pre-persist durability gate that classifies and rejects transient operational content (queue counts, in-progress state, temporary paths, run/test status, self-diagnostics) before it is written as durable memory. Mirrors Signet's durability gate (#917) that closes the gap where high-confidence-but-ephemeral content passed all existing gates.

## Why useful for OSB
OSB's existing content gates operate on different axes: capture-boundary validates capture-pattern VALIDITY (not content semantics), and pinned.ts rejects over-budget content by SIZE. Neither inspects whether the content is transient operational noise, so ephemeral content (status counts, in-progress markers, self-diagnostics) can pass every current gate and land as durable memory, polluting recall. A content-semantics durability gate keeps durable memory free of operational noise.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: `src/core/brain/capture-boundary.ts:14-69` — skips invalid capture PATTERNS at compile time (doctor surfaces them); a pattern-validity gate, not content semantics; `src/core/brain/pinned.ts:86` — rejects over-budget pinned content by SIZE (structured signal) before write; a budget gate, not a transient-noise gate; no deterministic gate that rejects transient operational content before durable persistence was found.

## Notes
The classifier must be deterministic (no LLM) to match the upstream "deterministic durability gate" guarantee and avoid adding inference cost to the hot ingest path. Define the transient-content vocabulary (queue counts, in-progress state, temporary paths, run/test status, self-diagnostics) explicitly. Rejected content can be logged for doctor visibility rather than silently dropped. Coordinate with the existing capture-boundary + pinned budget gates so the three form one coherent pre-persist filter chain.

## Unit t_e540b093 (board priority 3): [upstream:mnemosyne] Write-approval gate — stage extracted memory writes to a pending queue and apply only after review

**Source**: https://github.com/AxDSan/mnemosyne/releases/tag/v3.14.0
**Repo**: AxDSan/mnemosyne (629★)
**Released**: v3.14.0 (2026-07-17T20:42:11Z)

## What
Add an opt-in write-approval mode that stages memory writes (e.g. extracted-fact signals) into a pending queue instead of committing them straight to the live brain, plus an apply action that replays only human-approved records into the canonical store.

## Why useful for OSB
OSB currently writes facts as `source_type: extracted` signals directly with no review checkpoint, so a noisy or wrong extraction lands in the brain immediately. A pending/approve gate gives the operator a chance to vet auto-extracted memory before it becomes queryable, reducing pollution of the canonical store.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: No write-approval/pending-memory gate exists — `fact-extract.ts:217` writes extracted signals directly; grep `write.approval|pending/memory|staging.*write|apply.pending` = 0 real hits (only unrelated DB-build staging at `search/store.ts:255`, `indexer.ts:642`, and dream staging).

## Notes
Scope as opt-in (default off) so existing direct-write flow is unchanged. Design the apply step to preserve canonical-entity anchoring done at extraction time.

## Unit t_f79b4fe0 (board priority 3): [upstream:aipass] Synchronous write-time conflict advisory when an incoming fact contradicts an existing belief (supersedes links already present)

**Source**: https://github.com/AIOSAI/AIPass/releases/tag/v2.7.2
**Repo**: AIOSAI/AIPass (214★)
**Released**: v2.7.2 (2026-07-17T06:45:33Z)

## What
Decision curation that maintains supersedes links plus emits a conflict advisory *at write time* when an incoming fact contradicts an existing one. OSB already has the curation + supersedes half comparably; the gap is the synchronous, ingress-time advisory (OSB detects/resolves conflicts in a later health/dream pass, not at the moment of write).

## Why useful for OSB
Warning at write ingress catches a contradiction while the operator/agent is still in context to reconcile it, instead of deferring to the next hygiene pass. It tightens the feedback loop on belief conflicts without changing the existing detection logic.

## Status in OSB
- **Verdict**: present_weaker
- **Codegraph hints**: `health/contradiction.ts`, `reconcile.ts:70` (detectContradictions), `thesis.ts:452` (support/contradiction over subject-bearing span), `hygiene/resolve-conflicts.ts` (supersede action) — supersedes links + contradiction detection at parity; gap is that these run as a health/dream pass, not synchronously at write ingress.

## Notes
Scope the task narrowly to the write-time advisory hook (reuse `detectContradictions`/`resolve-conflicts.ts` supersede logic at ingress) — do not rebuild the already-comparable detection/supersedes machinery.

## Unit t_7965b04b (board priority 4): [upstream:obsidian-wiki] Snapshot-before-destructive-write gate covering bulk deletes (deleteBySource)

**Source**: https://github.com/Ar9av/obsidian-wiki/releases/tag/v2026.07.6
**Repo**: Ar9av/obsidian-wiki (977★)
**Released**: v2026.07.6 (2026-07-14T16:53:39Z)

## What
Upstream now takes a git snapshot of the vault (with a hardened snapshot path) before any skill performs a destructive write, so the change is recoverable/rollback-able. It generalizes snapshotting to cover destructive skill writes broadly, not just one operation.

## Why useful for OSB
OSB already owns the hard part — a full-vault snapshot + rollback engine (tar+zst, retention rotation, restore that preserves `.snapshots/`) — but only three batch paths (`dream`, `upgrade`, `import-claude-memory`) invoke it. Other destructive mutations, notably `deleteBySource`'s bulk `rmSync`, have no pre-write snapshot, so a mistaken bulk delete is unrecoverable despite the machinery existing.

## Status in OSB
- **Verdict**: present_weaker
- **Codegraph hints**: `createSnapshot` at src/core/brain/snapshot.ts:175 (tar+zst full-`Brain/` archive → `Brain/.snapshots/<run_id>.tar.zst`), with `restoreSnapshot` rollback + `pruneSnapshots` retention (snapshot.ts:1-33 contract); WIRED INTO ONLY: src/core/brain/dream.ts:383 (pre-run gate), src/core/brain/upgrade.ts:28, src/core/brain/import-claude-memory.ts:80; UNCOVERED destructive path: `deleteBySource` in src/core/brain/source-cleanup.ts (destructive `rmSync`, writes tombstone only, NO snapshot); individual writes use atomicWrite (partial-write safety, not rollback); src/core/brain/git/store.ts + brain_note_history = ingesting/reading external repo git history, not vault snapshotting.

## Notes
Improvement, not net-new: extend the existing `snapshot.ts` engine into a shared "snapshot-before-destructive-write" gate that fronts other destructive vault operations (start with `deleteBySource`), rather than adopting upstream's git mechanism — OSB's self-contained tar+zst approach is arguably stronger (no requirement that the vault be a git repo, plus built-in retention). Optionally align the snapshot-path hardening idea with `validateRunId`/`snapshotPath` in src/core/brain/paths.ts. Related but distinct from the typed lifecycle-history/revert task: this one is specifically about extending the existing snapshot gate's coverage.

## Unit t_29a63073 (board priority 4): [upstream:contextlattice] Harden local stores — resumable permission migration, in-store symlink guard, opaque store references in outputs

**Source**: https://github.com/sheawinkler/contextlattice/releases/tag/v3.17.3
**Repo**: sheawinkler/contextlattice (61★)
**Released**: v3.17.3 (2026-07-13T14:53:23Z)

## What
Sensitive local stores are locked to owner-only access (restrictive POSIX modes on Unix, ACLs on Windows), applied to *existing* stores via a bounded, resumable migration pass. Symlink targets are constrained to stay inside the store boundary (no escaping to arbitrary host paths). Runtime responses expose opaque store references instead of raw host filesystem paths.

## Why useful for OSB
OSB is local single-tenant over a Markdown vault, so store hardening is squarely in scope. OSB already writes new files owner-only, but three gaps remain: (1) pre-existing files/stores created before the mode discipline are never re-secured; (2) a symlink inside the vault can point outside it, defeating the owner-only guarantee and enabling path traversal; (3) runtime responses can leak absolute host paths, which is an info-disclosure and portability leak. Closing these matches OSB's existing opaque-id discipline and audit posture.

## Status in OSB
- **Verdict**: present_weaker
- **Codegraph hints**: Owner-only modes for *new* writes already present — `src/core/fs-atomic.ts:107` default mode `0o600` (`:153` `0o644`), `src/core/reliability/audit.ts:26` append-only `0o600`, `src/core/doctor.ts:50,70` `chmod u+rwx` checks. Opaque ids exist but only for telemetry — `src/core/config.ts:563,584`. Not found: (a) a bounded resumable migration that re-secures existing stores — reason: no such pass surfaced; (b) a symlink-target-inside-store guard — reason: no traversal check surfaced; (c) opaque store-reference redaction in *runtime response payloads* — reason: opaque-id discipline is telemetry-only, not applied to output paths.

## Notes
The owner-only-mode sub-feature is at parity for new writes; the create-worthy delta is the three missing pieces. Suggest: (1) a resumable doctor/maintenance migration that chmods existing store files with checkpointing; (2) a realpath containment check rejecting symlinks whose target resolves outside the vault/store root; (3) a path→opaque-reference redactor for MCP/CLI response payloads, reusing the existing opaque-id approach from `config.ts`.

## Unit t_66c12a67 (board priority 3): [upstream:mnemosyne] Retire canonical fact slots (mark superseded, keep historical record queryable) instead of hard-deleting

**Source**: https://github.com/AxDSan/mnemosyne/releases/tag/v3.14.0
**Repo**: AxDSan/mnemosyne (629★)
**Released**: v3.14.0 (2026-07-17T20:42:11Z)

## What
Give facts a retire lifecycle: an operator can mark a canonical fact slot inactive/superseded without deleting it, keeping the historical record queryable — mirroring what OSB already does for preferences but for extracted/canonical facts.

## Why useful for OSB
OSB has no operator-managed retire path for facts — a stale fact can only be deleted by source, losing history. A retire-not-delete slot lets an outdated fact be superseded while remaining auditable, matching the retire semantics preferences already enjoy.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: Facts are extracted signals anchored to canonical entities (`fact-extract.ts:199`, `:201`, `:217`) with no fact-level CRUD/retire; the retire lifecycle that exists is preferences-only (`pref-audit.ts:16` create/promote/retire/merge, `query.ts:8` active-or-retired). No canonical-fact retire found.

## Notes
Model the fact retire after the existing preference retire lifecycle rather than inventing new semantics; keep full CRUD scope minimal — the retire/supersede half is the load-bearing part for OSB.

## Unit t_3beb374c (board priority 3): [upstream:mnemosyne] Apply e5 `query:`/`passage:` instruction prefixes at index and query time (configurable)

**Source**: https://github.com/AxDSan/mnemosyne/releases/tag/v3.14.0
**Repo**: AxDSan/mnemosyne (629★)
**Released**: v3.14.0 (2026-07-17T20:42:11Z)

## What
Apply distinct instruction prefixes for queries vs documents when embedding — `query:` at search time and `passage:` at index time — with the prefixes configurable, so instruction-tuned embedders (E5/BGE) get the prompts they require.

## Why useful for OSB
OSB's embedding preset is multilingual-e5-small, which *requires* separate `query:`/`passage:` prefixes for correct retrieval, yet OSB applies none today. This is a retrieval-correctness fix: adding the prefixes materially improves semantic-search relevance for the model OSB already ships.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: Preset is multilingual-e5-small (`search/embeddings/presets.ts:40-41`); no instruction-prefix handling exists — grep `instruction|query.prompt|queryPrefix` in `embeddings/` = 0 hits.

## Notes
Reindex is required after adding passage prefixes so stored vectors match the new instruction; make prefixes preset-aware (defaults for e5) and overridable, and ensure query-side prefix is applied consistently at search time. Highest retrieval-quality payoff of the four.

## Unit t_8880a68d (board priority 2): [upstream:mem9] Classify embeddings-provider quota/billing errors (402 / quota-429) distinctly from generic transient failures and surface an actionable message

**Source**: https://github.com/mem9-ai/mem9/pull/383
**Repo**: mem9-ai/mem9 (1147★)
**PR**: #383 feat(runtime): define public quota error contract (2026-07-04T14:29:39Z)

## What
OSB's opt-in embeddings layer should distinguish a quota-exhausted / billing-blocked outcome (HTTP 402) and a quota-shaped 429 from generic transient failures, mapping them to a dedicated error category with an actionable, user-facing message. This is the client-side kernel of the upstream idea — NOT the mem9 server/HTTP contract, which OSB has no surface for.

## Why useful for OSB
Today a 402 is folded into a blind EMBEDDING_PROVIDER_HTTP failure and every 429 is retried identically, so a user whose embedding billing is exhausted gets a generic error or wasted backoff instead of "embedding quota exhausted — semantic search degraded, check billing." A quota category lets the CLI/agent tell the user why semantic search stopped and skip the pointless retry loop on a hard billing block.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: src/core/search/embeddings/openai-compat.ts:24 (`RETRYABLE_STATUSES = {429,500,502,503,504}` — 402 absent, so it fails fast but with no distinct category; 429 always retried without checking whether it is quota-shaped); src/core/search/embeddings/openai-compat.ts:270-276 (every non-ok status, including 402, collapses into a single `EMBEDDING_PROVIDER_HTTP` SearchError carrying only the status text); src/core/search/embeddings/openai-compat.ts:330-353 (`classifyError` returns only `{retriable, error}` — no quota classifier, no `Retry-After` parsing); SearchError codes in src/core/search/types.ts have no `EMBEDDING_QUOTA_*` member.

## Notes
Scope is client-side classification only: add a quota SearchError code, treat 402 (and quota-shaped 429 payloads) as a non-retriable quota outcome, optionally honor `Retry-After` for the quota-429 case, and thread an actionable message to the `--semantic` surface / implicit warning path. Do NOT build a mem9-style server contract, OpenAPI schema, or `details.runtimeQuota` HTTP envelope — OSB has no hosted route or API clients. Detecting a "quota-shaped 429" reliably across OpenAI-compatible providers is the main risk (bodies vary); a conservative heuristic plus keeping generic 429 retry behavior as the default is advisable. Orthogonal to t_9b0bb1be (which is about retry COUNT for 429, not error classification).

## Unit t_144b680a (board priority 2): [upstream:mem9] Honor Retry-After and gracefully degrade semantic search on embeddings rate-limit/quota signals

**Source**: https://github.com/mem9-ai/mem9/pull/374
**Repo**: mem9-ai/mem9 (1147★)
**PR**: #374 feat: support runtime quota and rate-limit handling in plugins (2026-07-06T07:37:53Z)

## What
Companion to mem9 #383 (which defined the quota error contract). #374 adds the runtime handling side: the embeddings/plugin runtime observes quota and rate-limit signals and reacts gracefully — honoring Retry-After, backing off on rate-limit distinctly from quota exhaustion, and degrading rather than crashing or retrying blindly.

## Why useful for OSB
OSB's embeddings client treats 429 identically to 5xx (RETRYABLE_STATUSES = {429,500,502,503,504}) and blind-retries with no Retry-After parsing and no behavioral split between rate-limit and quota exhaustion. Honoring Retry-After and degrading semantic search to lexical fallback when the provider is rate-limited (instead of failing the request) makes optional semantic search resilient to provider throttling.

## Status in OSB
- **Verdict**: not_in_osb_useful
- **Codegraph hints**: src/core/search/embeddings/openai-compat.ts:24 (429 pooled with 5xx as blindly-retryable); :270-276 (every non-ok status collapses to a single EMBEDDING_PROVIDER_HTTP); :330-353 (classifyError returns {retriable,error} only — no Retry-After parsing, no rate-limit vs quota behavioral split). No graceful-degradation path for semantic search on throttling.

## Notes
Distinct from — but coupled with — t_8880a68d (which covers classifying the error category) and orthogonal to t_9b0bb1be (retry count). This task is the reaction/handling layer: Retry-After honoring + rate-limit-vs-quota backoff behavior + graceful degrade of semantic search. Implement on top of t_8880a68d's classification (the classifier should expose Retry-After and the rate-limit/quota distinction that this handling consumes); sequence after or alongside it.

# Project context

Open Second Brain - TypeScript, Bun runtime, local single-tenant CLI (`o2b`) + MCP server over an Obsidian-compatible Markdown vault. SQLite (bun:sqlite) with optional sqlite-vec semantic index. No hosted server, no HTTP API of its own (the only outbound HTTP is the OpenAI-compatible embeddings client).
Recent commits:
13bde6c3 refactor: remove all import cycles, decompose search.ts (v1.30.1) (#137)
fd5661f9 feat: governance visibility - vitals scorecard + batch-inflation lint (v1.30.0) (#136)
a99b0e71 feat(brain): add o2b brain vitals scorecard + batch-concept-inflation lint (#135)
70fb36e1 feat: operability, safety & first-run experience (v1.29.0) (#134)
ac26a675 feat: retrieval & ranking quality (v1.28.0) (#133)
5cd52e70 fix(hermes): resolve o2b when memory provider PATH is tiny (v1.27.1) (#131)
99adb65f feat: ingestion & import robustness (v1.27.0) (#132)
fb474acc test(hermes): verify OSB surface against core normalize/validate-before-wrap and in_place compaction (1.26.1) (#129)
61a9ad66 fix(brain): CodeRabbit review hardening for the unreleased v1.26.0 (#128)
962c3e0a feat(brain): memory-signal provenance and lifecycle integrity layer (v1.26.0) (#127)
Related files:
- src/core/brain/entities/canonical.ts (normalizeEntityName - NFC/trim/collapse/lowercase only)
- src/core/brain/atomic-facts.ts, src/core/brain/fact-extract.ts (entity matching consumers; fact-extract.ts:217 writes extracted signals directly)
- src/core/search/store.ts (vecUpsert:834, vecToBuffer:331 - dimension gate only, no finite/non-zero check)
- src/core/search/embeddings/http-util.ts (unitNormaliseInPlace:48 - returns all-zero on zero norm)
- src/core/search/embeddings/openai-compat.ts (RETRYABLE_STATUSES {429,500,502,503,504}, classifyError returns {retriable,error} only, no Retry-After parsing, no quota category)
- src/core/search/embeddings/presets.ts (multilingual-e5-small preset, note mentions query:/passage: prefixes but nothing applies them)
- src/core/search/types.ts (SearchError codes - no EMBEDDING_QUOTA_*)
- src/core/brain/snapshot.ts (createSnapshot:175 tar+zst full-Brain archive, restoreSnapshot, pruneSnapshots; wired into dream.ts:383, upgrade.ts:28, import-claude-memory.ts:80 only)
- src/core/brain/source-cleanup.ts (deleteBySource - bulk rmSync, tombstone only, NO snapshot)
- src/core/fs-atomic.ts (atomicWrite, default mode 0o600/0o644 for NEW writes only)
- src/core/brain/capture-boundary.ts (capture-pattern validity gate), src/core/brain/pinned.ts:86 (size budget gate)
- src/core/brain/pref-audit.ts (preference retire lifecycle: create/promote/retire/merge), src/core/brain/preference.ts:256 (superseded_by)
- src/core/brain/health/contradiction.ts, src/core/brain/reconcile.ts:70 (detectContradictions), src/core/brain/hygiene/resolve-conflicts.ts (supersede action)
- src/core/config.ts:563,584 (opaque ids - telemetry only)
- src/core/doctor.ts (read-only diagnostics), src/core/brain/vitals.ts (orphan_preferences read-only)
Conventions:
- Strict TypeScript, no `any`; import cycles are forbidden (v1.30.1 removed all of them; code-ranker gate)
- Deterministic kernel: the core calls no LLM; LLM-dependent behavior lives behind explicit opt-in surfaces
- Errors are typed and explicit (SearchError codes, structured lint findings); silent fallbacks are forbidden
- Frontmatter-first Markdown artifacts in Brain/; every mutation goes through atomicWrite and is logged
- CLI verbs under src/cli/brain/verbs/, MCP tools under src/mcp/; both are thin adapters over src/core
- Tests: bun test, colocated *.test.ts; TDD per atomic unit
- Language-agnostic: no hardcoded natural-language word lists for classification; structural signals, explicit frontmatter fields, corpus frequency, or config-supplied vocabularies only
Constraints:
- Do not change existing public API shapes (CLI flags and MCP tool contracts are additive-only)
- No new external dependencies unless unavoidable
- No LLM calls in any of these gates - all 11 units must be deterministic
- Backward compatible: existing vaults must keep working without migration prompts; identity-key shape `<category>:<normalized name>` must remain stable for existing entities
- Silent no-op fallbacks are forbidden - a rejected write must surface a typed, actionable error or a logged, visible skip
- SOLID/KISS/DRY: shared choke points preferred over scattered per-call-site checks

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
