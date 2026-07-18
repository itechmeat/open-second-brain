# Memory write-path integrity and store safety - an 11-unit hardening wave

**Status:** draft
**Author:** claude-dev-agent (via feature-release-playbook)
**Audience:** implementation
**Branch:** `feat/memory-write-path-integrity`
**Consultant:** Claude Code (variants in `variants.md`, raw output in `cli-output/claude.md`)

## Problem statement

Open Second Brain funnels every durable memory mutation through a small set of choke points (`writeSignal`, `vecUpsert`, `deleteBySource`, the embeddings client), but several of those choke points accept input they should reject and several destructive paths lack the safety machinery that already exists elsewhere in the codebase. A malformed entity label fragments the entity graph, a NaN vector poisons cosine distances silently, a bulk `deleteBySource` is unrecoverable despite a full snapshot engine sitting one import away, and an exhausted embeddings quota surfaces as a generic HTTP failure with blind retries. This wave closes those gaps as one coherent release: every unit strengthens the write path or the safety envelope around it, with typed, explicit errors and no silent fallbacks.

## Scope

Eleven kanban units, grouped into four subsystem clusters:

Cluster A - brain write path:
- **A1** `t_657b365e` (p4) - strip Markdown/punctuation decoration from entity labels, reject structurally-junk labels before graph persistence, snapshot-gated prune of historical malformed entity nodes.
- **A2** `t_375e98fd` (p3) - deterministic durability gate rejecting transient operational content before an extracted signal is persisted.
- **A3** `t_e540b093` (p3) - opt-in write-approval queue: stage extracted signal writes to `Brain/pending/`, apply or reject via a new CLI surface.
- **A4** `t_f79b4fe0` (p3) - synchronous write-time conflict advisory when an incoming signal contradicts a confirmed preference.
- **A5** `t_66c12a67` (p3) - retire lifecycle for extracted fact signals (mark superseded and move to `Brain/retired/`, keep queryable), modeled on the preference retire lifecycle.

Cluster B - vector store:
- **B1** `t_e2b182b6` (p4) - finite/non-zero vector validation gate at `vecUpsert` plus a typed error from `unitNormaliseInPlace` on zero-norm or non-finite input.
- **B2** `t_3beb374c` (p3) - instruction prefixes (`query:` / `passage:`) applied at query and index time, preset-aware defaults for e5-family models, configurable.

Cluster C - embeddings client resilience:
- **C1** `t_8880a68d` (p2) - classify quota/billing outcomes (HTTP 402, quota-shaped 429) distinctly from generic transient failures, with a dedicated error code and actionable message.
- **C2** `t_144b680a` (p2) - honor `Retry-After`, split rate-limit backoff from quota fail-fast, degrade implicit semantic search gracefully with an actionable warning.

Cluster D - store safety:
- **D1** `t_7965b04b` (p4) - shared snapshot-before-destructive-write gate over the existing `snapshot.ts` engine, wired into `deleteBySource` (and reused by the A1 entity prune).
- **D2** `t_29a63073` (p4) - store hardening: bounded idempotent permission migration for existing `Brain/` files, a doctor lint for symlinks escaping the vault, opaque store references instead of absolute host paths in MCP responses.

## Out of scope

- No LLM-backed classification anywhere in this wave; every gate is deterministic.
- No mem9-style server quota contract, OpenAPI schema, or HTTP envelope (the project has no hosted API surface).
- No rebuild of the existing conflict-resolution supersede machinery (`hygiene/resolve-conflicts.ts`); A4 reuses detection, it does not replace resolution.
- No full CRUD for facts; A5 ships the retire/supersede half only.
- No git-based snapshot mechanism; D1 extends the existing tar+zst engine.
- No temporal half-open interval model (`valid_from`/`valid_to` at instant precision) - the atomic temporal fact-replacement task (`t_3ba9c404`) stays on the board.
- No changes to existing public CLI flag or MCP tool contracts beyond additive fields, new verbs, and new configuration keys.

## Chosen approach

Variant 3 from the consultant run: cluster-scoped kernels with per-unit atomic commits. A shared abstraction is introduced only where two or more units provably share a choke point:

- Cluster A gets a light pre-persist gate seam inside the extracted-signal path (`routeExtractedFacts` -> durability gate -> approval staging -> `writeSignal`), one logged-skip convention, and reuses the existing retire/audit patterns for A5.
- Cluster B gets one vector-validity kernel used by both the store write path and the provider normalisation path, and one `kind`-aware embed choke point for prefixes.
- Cluster C gets a single richer classification result (`category`, `retriable`, `retryAfterMs`) consumed by both C1 and C2, avoiding a double rework of `classifyError`.
- Cluster D gets one `withDestructiveSnapshot` wrapper reused by `deleteBySource` and the A1 prune, and reuses the existing remediation plan/apply machinery for the permission migration.

Clusters stay mutually independent so any unit remains an independently revertable atomic commit; error vocabularies stay subsystem-native (`SearchError` codes for search/embeddings, typed brain-side errors and logged skips for vault writes).

## Design decisions

- **A1 keeps `normalizeEntityName` byte-stable and adds a separate decoration-stripping quality pass.** The identity-key shape `<category>:<normalized name>` (built by `entityIdentityKey`, `src/core/brain/entities/canonical.ts`) must not change for existing entities, so Markdown/punctuation stripping (`**Foo**` -> `Foo`, trailing `:`/`.` etc.) runs as a new exported `sanitizeEntityLabel(raw)` applied BEFORE `normalizeEntityName` at label-intake boundaries (entity creation, fact-extract anchoring, atomic-facts anchoring). Junk rejection is structural only: labels that are empty after stripping, contain no letter or digit in any script (Unicode property classes, not ASCII), collapse to pure punctuation/digits, or exceed a length bound are rejected with a typed error at creation and skipped-with-log at anchoring time. There is NO built-in natural-language denylist; an optional `entities.label_denylist` config key accepts operator-supplied exact labels (compared post-normalization). The prune walks `Brain/entities/`, re-runs the same validator, and removes failing nodes plus their edges behind the D1 snapshot gate, surfaced as a dry-run-default CLI action.
- **A2 durability classification uses structural signals only.** `classifyDurability(text)` (new `src/core/brain/gates/durability.ts`) flags transient operational content via language-agnostic shapes: filesystem temp paths (`/tmp/`, `*.tmp`, OS temp dirs), progress counters (`N/M`, `NN%`), run-id/timestamp-suffixed identifiers, byte/duration measurements as the dominant token class, and process-exit/status codes. Word lists are not compiled in; an optional `durability.denylist` config key accepts operator-supplied regexes. The gate runs inside `routeExtractedFacts` (the noisy automated path) before `writeSignal`; a rejected fact is not silently dropped - it is recorded via `appendLogEvent` with a dedicated event kind so `doctor` can surface rejection counts. Operator-initiated `brain_feedback` writes are NOT gated (the operator is not noise).
- **A3 approval queue defaults off and reuses the signal file format verbatim.** With `write_approval.enabled=true`, `routeExtractedFacts` writes the identical frontmatter document to `Brain/pending/` instead of `Brain/inbox/`. Apply moves the file into `Brain/inbox/` unchanged (entity anchors were resolved at extraction time and live in the document); reject moves it to `Brain/retired/` with a rejection reason. New CLI verb `o2b brain pending list|apply|reject`. No new document schema.
- **A4 advisory reuses `detectContradictions` as a pure function at write ingress.** `src/core/brain/health/contradiction.ts:250` already takes in-memory preferences and a Jaccard option; A4 loads confirmed preferences for the incoming signal's scope bucket only, runs the same pairwise similarity against the incoming principle, and returns an advisory (never blocks the write). The advisory surfaces in the `brain_feedback` MCP response and CLI output and is logged. Detection thresholds reuse the existing health-pass defaults.
- **A5 fact retire mirrors `moveToRetired` for signals.** `retireSignal(vault, id, { reason, superseded_by? })` moves `Brain/inbox/sig-*.md` to `Brain/retired/`, rewrites frontmatter (`_status: "retired"`, `retired_at`, `retired_reason`, optional `superseded_by`, tag swap, alias for the old id) and appends an audit line, following `preference.ts:1005` conventions. Because the dream pass consumes `Brain/inbox/` only, the directory move IS the exclusion mechanism; retired signals stay readable through the existing retired-directory query fallback. CLI: `o2b brain signal retire <id> --reason <text> [--superseded-by <id>]`.
- **B1 validates at the store choke point and fails loud in normalisation.** A new `assertValidVector(vector, context)` (in `src/core/search/vector-guard.ts`) rejects non-finite values and all-zero vectors with a new `SearchError` code `EMBEDDING_INVALID_VECTOR`; `vecUpsert` (`store.ts:821`) calls it after the existing dimension gate, and `semanticTopK` applies it to query vectors. `unitNormaliseInPlace` (`http-util.ts:48`) stops returning unnormalised zeros: zero-norm or non-finite input now throws the same typed error, because a silent all-zero embedding is exactly the misleading no-op fallback this project forbids.
- **B2 threads an embed kind through the provider contract additively.** `EmbeddingProvider.embed(texts, kind?: "query" | "passage")` is an optional second parameter (backward compatible for any provider implementation). The openai-compat provider prepends the configured prefix per kind; `indexer.ts:601` passes `"passage"`, `semantic-phase.ts:94` passes `"query"`. New config keys `embedding_prefix_query` / `embedding_prefix_passage` (env twins included) default from the preset: a new optional `queryPrefix`/`passagePrefix` field pair on `EmbeddingModelPreset`, populated for e5-family entries. The active prefix pair is recorded in the index meta and a mismatch between stored and configured prefixes surfaces the existing reindex-required warning path, since stored vectors embedded without prefixes are not comparable to prefixed queries.
- **C1 and C2 share one classification rework.** `classifyError` returns `{ category: "quota" | "rate_limit" | "auth" | "transient" | "fatal"; retriable: boolean; retryAfterMs: number | null; error: SearchError }`. The HTTP status and `Retry-After` header are carried as structured fields on the thrown error from `embedBatchOnce`: `SearchError` gains an additive optional constructor argument (`opts?: { status?: number; retryAfterMs?: number }`) exposed as readonly fields, so no message-string parsing remains anywhere in the classifier. 402 always classifies as quota; 429 classifies as quota only on protocol-token evidence in the response body (provider error codes such as `insufficient_quota`, which are wire-protocol identifiers, not natural language). Quota adds `SearchError` code `EMBEDDING_QUOTA_EXHAUSTED` with an actionable message (billing exhausted, semantic search degraded, check provider billing). C2 makes the retry loop honor `retryAfterMs` (capped) for rate-limit/transient retries, fail fast on quota, and enrich the implicit-semantic degrade warning (`semantic-phase.ts`) plus `searchErrorToMcp` (`search-tools.ts:400`) with the quota-specific actionable message. Explicit `--semantic` continues to throw the typed error - no silent lexical fallback on an explicit request.
- **D1 is a thin wrapper, not a new engine.** `withDestructiveSnapshot(vault, label, op)` (in a new sibling `src/core/brain/snapshot-gate.ts`, keeping the 656-line engine module untouched) mints `runId = <label>-<isoSecondCompact>` via the existing `validateRunId`, calls `createSnapshot`, runs `op`, then `pruneSnapshots` with the configured retention. Snapshot failure aborts the operation with the existing typed snapshot errors - a destructive op never proceeds unsnapshotted. `deleteBySource` calls it around its confirm-path deletions (`source-cleanup.ts`); the A1 prune reuses it.
- **D2 reuses remediation machinery and secure-by-default redaction.** Permission migration ships as a new `auto-safe` remediation step class (`harden-permissions`) in `health/remediation.ts`: an idempotent bounded walk (existing `stepCap` bounds work per run, so re-running resumes naturally) that chmods `Brain/` files to `0o600` and directories to `0o700`, dry-run by default through the existing `--remediate --dry-run` flow. The symlink lint adds a doctor issue code (`symlink-escape`) that reports vault-internal symlinks resolving outside the vault, reusing `ensureInsideVault` (`src/core/path-safety.ts`) semantics. MCP responses stop exposing `ctx.vault` absolute paths at the four `src/mcp/tools.ts` sites: the value is replaced by an opaque store reference derived from the existing device-id primitive plus a stable vault hash, with an `expose_host_paths=true` config escape hatch (resolved in `src/core/config.ts`, the vault-level config surface) for operators who depend on the raw path; the redaction default is on because MCP responses land in model context, which is exactly the leak surface the upstream fix targets. The prune surface for A1 ships under the existing entity CLI verb as a subcommand (dry-run default, `--confirm` to apply); the implementer wires it into whichever entity verb file already exists rather than creating a parallel verb.

## File changes

New files:
- `src/core/brain/gates/durability.ts` - structural transient-content classifier (A2).
- `src/core/brain/pending.ts` - approval queue staging/apply/reject (A3).
- `src/core/brain/signal-retire.ts` - signal retire lifecycle (A5).
- `src/core/search/vector-guard.ts` - vector validity kernel (B1).
- `src/cli/brain/verbs/pending.ts` - pending queue CLI verb (A3).
- `tests/*` mirrors for every new module.

Modified files:
- `src/core/brain/entities/canonical.ts` (+ `sanitizeEntityLabel`, structural label validation) and its intake call sites `src/core/brain/fact-extract.ts`, `src/core/brain/atomic-facts.ts`, entity creation path (A1).
- `src/core/brain/fact-extract.ts` - durability gate + approval staging seam in `routeExtractedFacts` (A2, A3).
- `src/core/brain/signal.ts` - write-ingress advisory hook surface (A4), shared by MCP/CLI feedback paths.
- `src/core/brain/health/contradiction.ts` - export an incoming-vs-confirmed advisory helper reusing the existing pairwise kernel (A4).
- `src/core/search/store.ts`, `src/core/search/embeddings/http-util.ts` - vector gate wiring (B1).
- `src/core/search/embeddings/contract.ts`, `openai-compat.ts`, `presets.ts`, `src/core/search/indexer.ts`, `src/core/search/semantic-phase.ts`, `src/core/search/index.ts` (config keys), index meta - prefixes (B2).
- `src/core/search/embeddings/openai-compat.ts`, `http-util.ts`, `src/core/search/types.ts`, `src/core/search/semantic-phase.ts`, `src/mcp/search-tools.ts` - quota classification and Retry-After handling (C1, C2).
- `src/core/brain/snapshot.ts` (or sibling), `src/core/brain/source-cleanup.ts` - snapshot gate (D1).
- `src/core/brain/health/remediation.ts`, `src/core/brain/doctor.ts`, `src/mcp/tools.ts`, `src/core/config.ts` or `src/core/search/index.ts` config surface - hardening (D2).
- `src/cli/brain.ts`, `src/cli/brain/help-text.ts` - new verbs/flags registration (A1 prune surface, A3, A5, D2).
- `README.md`, `CHANGELOG.md`, `package.json` + manifest mirrors via `scripts/sync-version.ts` - docs and version (final task).

## Risks and open questions

- **B2 reindex semantics**: adding passage prefixes invalidates stored vectors; the mismatch must surface through the existing reindex-required path, not silently mix prefixed queries with unprefixed passages. The implementer must verify how index meta records embedding parameters today (`embeddingHash`, dimension lock) and extend that mechanism rather than invent a parallel one.
- **C1 quota-shaped 429 detection** varies by provider; the classifier stays conservative (default: 429 without protocol-token evidence remains a rate-limit) so false quota classifications cannot disable retries incorrectly.
- **D2 redaction default-on** changes the VALUE of existing MCP response fields (shape unchanged). This is deliberate (security default) and gets a CHANGELOG callout plus the `expose_host_paths` escape hatch.
- **A1 prune blast radius**: prune only removes nodes failing the structural validator and their edges; it never touches nodes that merely LOOK unusual. Dry-run default plus D1 snapshot gate bound the damage of a bad run.
- **Gate chain ordering** in `routeExtractedFacts` is fixed as: dedup -> durability (A2) -> staging decision (A3) -> write; A4 advisory attaches to the operator-facing feedback path, not the extracted path, so the two never double-fire on one write.
