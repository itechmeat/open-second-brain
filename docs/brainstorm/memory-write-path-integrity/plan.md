# Memory write-path integrity and store safety - implementation plan

Task order is risk-first inside each cluster and respects the only two hard
dependency edges: C1 before C2 (the handling layer consumes the classifier)
and D1 before A1 (the entity prune runs behind the snapshot gate). Clusters
are mutually independent; each task lands as one atomic conventional commit
with its tests, formatted and lint-clean.

Sequence: C1 -> C2 -> B1 -> B2 -> D1 -> D2 -> A1 -> A2 -> A3 -> A4 -> A5 -> L

## Tasks

### Task C1 - quota/billing error classification (`t_8880a68d`, p2)
- **Files**: `src/core/search/embeddings/openai-compat.ts`, `src/core/search/embeddings/http-util.ts`, `src/core/search/types.ts`, tests under `tests/core/search/`.
- **Acceptance**: `embedBatchOnce` carries HTTP status and `Retry-After` as structured fields (no message-string regex); `classifyError` returns `{ category, retriable, retryAfterMs, error }`; HTTP 402 and protocol-token-evidenced 429 classify as `quota` with new code `EMBEDDING_QUOTA_EXHAUSTED`, are non-retriable, and carry an actionable billing message; plain 429 stays `rate_limit` and retriable; 5xx stays `transient`; existing retry behavior for non-quota statuses is unchanged and all existing tests stay green.
- **Depends on**: none.

### Task C2 - Retry-After honoring and graceful semantic degrade (`t_144b680a`, p2)
- **Files**: `src/core/search/embeddings/openai-compat.ts`, `src/core/search/semantic-phase.ts`, `src/mcp/search-tools.ts`, tests.
- **Acceptance**: retry backoff uses `retryAfterMs` (bounded by a cap constant) when present for `rate_limit`/`transient` categories; `quota` fails fast with no retry; implicit semantic search degrades to lexical with a warning that names the category and the actionable message; explicit `--semantic` throws the typed error; `searchErrorToMcp` maps `EMBEDDING_QUOTA_EXHAUSTED` to its actionable message.
- **Depends on**: C1.

### Task B1 - vector validity gate (`t_e2b182b6`, p4)
- **Files**: new `src/core/search/vector-guard.ts`, `src/core/search/store.ts`, `src/core/search/embeddings/http-util.ts`, `src/core/search/types.ts`, tests.
- **Acceptance**: `assertValidVector` rejects non-finite and all-zero vectors with new code `EMBEDDING_INVALID_VECTOR`; `vecUpsert` and `semanticTopK` invoke it; `unitNormaliseInPlace` throws the same typed error on zero-norm or non-finite input instead of returning zeros; a NaN vector can no longer reach the vec table (proven by test through the store API).
- **Depends on**: none.

### Task B2 - e5 instruction prefixes (`t_3beb374c`, p3)
- **Files**: `src/core/search/embeddings/contract.ts`, `openai-compat.ts`, `presets.ts`, `configured-provider.ts`, `src/core/search/indexer.ts`, `src/core/search/semantic-phase.ts`, `src/core/search/index.ts`, index meta handling in `src/core/search/store.ts` or `indexer.ts`, tests.
- **Acceptance**: `embed(texts, kind?)` is additive; indexer embeds with `"passage"`, semantic phase with `"query"`; prefixes resolve preset-first (`queryPrefix`/`passagePrefix` on the e5 preset) with `embedding_prefix_query`/`embedding_prefix_passage` config/env overrides; the active prefix pair is persisted in index meta and a stored-vs-configured mismatch surfaces the reindex-required warning; with no preset match and no config the behavior is byte-identical to today.
- **Depends on**: none (C1/C2 touch the same file; land after them to avoid churn).

### Task D1 - snapshot-before-destructive-write gate (`t_7965b04b`, p4)
- **Files**: new `src/core/brain/snapshot-gate.ts`, `src/core/brain/source-cleanup.ts`, tests.
- **Acceptance**: `withDestructiveSnapshot(vault, label, op)` mints a validated run id, snapshots before `op`, prunes after with configured retention, and aborts (typed error, no partial deletion) when snapshotting fails; `deleteBySource` with `confirm: true` produces a snapshot before any `rmSync` and reports the snapshot path in its result; dry-run path takes no snapshot.
- **Depends on**: none.

### Task D2 - store hardening (`t_29a63073`, p4)
- **Files**: `src/core/brain/health/remediation.ts`, `src/core/brain/doctor.ts`, `src/mcp/tools.ts`, config surface (`src/core/config.ts`), `src/cli/brain/help-text.ts` if flags change, tests.
- **Acceptance**: a `harden-permissions` auto-safe remediation step chmods existing `Brain/` files to `0o600` and directories to `0o700`, idempotent and bounded by `stepCap` (re-run resumes), dry-run listed before apply; doctor reports a `symlink-escape` issue for any vault-internal symlink resolving outside the vault; the four `src/mcp/tools.ts` sites return an opaque store reference instead of the absolute vault path by default, with `expose_host_paths=true` restoring the raw value.
- **Depends on**: none.

### Task A1 - entity label quality and prune (`t_657b365e`, p4)
- **Files**: `src/core/brain/entities/canonical.ts`, `src/core/brain/fact-extract.ts`, `src/core/brain/atomic-facts.ts`, entity-creation path, prune subcommand under the existing entity CLI verb (dry-run default), `src/core/brain/doctor.ts` for candidate visibility, tests.
- **Acceptance**: `sanitizeEntityLabel` strips surrounding Markdown emphasis/heading markers and surrounding punctuation before normalization at every label-intake boundary; structurally-junk labels (empty after strip, no letter/digit in any script, over length bound, or in the operator-supplied `entities.label_denylist`) are rejected with a typed error at creation and a logged skip at anchoring; `entityIdentityKey` output for every currently-valid label is byte-identical to before; the prune lists malformed historical nodes in dry-run, and on confirm removes nodes plus their edges inside `withDestructiveSnapshot` leaving no orphaned references (doctor-verified in test).
- **Depends on**: D1.

### Task A2 - durability gate (`t_375e98fd`, p3)
- **Files**: new `src/core/brain/gates/durability.ts`, `src/core/brain/fact-extract.ts`, log event kind registration, doctor visibility, tests.
- **Acceptance**: `classifyDurability` flags transient content via structural signals only (temp paths, progress counters, dominant measurement tokens, run-id shapes, exit-status shapes) with zero built-in natural-language word lists; optional `durability.denylist` config regexes extend it; `routeExtractedFacts` skips flagged facts before `writeSignal`, logging each skip with a dedicated event kind; operator `brain_feedback` writes are not gated; classification is pure and deterministic (property: same input, same verdict, no I/O).
- **Depends on**: none (same file as A3; land before it).

### Task A3 - write-approval pending queue (`t_e540b093`, p3)
- **Files**: new `src/core/brain/pending.ts`, `src/core/brain/fact-extract.ts`, new `src/cli/brain/verbs/pending.ts`, `src/cli/brain.ts`, `src/cli/brain/help-text.ts`, `src/core/brain/paths.ts` (pending dir), tests.
- **Acceptance**: with `write_approval.enabled=true` extracted signals land in `Brain/pending/` with unchanged frontmatter; default off preserves today's direct-to-inbox behavior byte-for-byte; `o2b brain pending list` shows queued items, `apply <id>` moves to `Brain/inbox/` preserving entity anchors and dedup hash, `reject <id> --reason` moves to `Brain/retired/` with reason; applying a missing id is a typed error, not a no-op.
- **Depends on**: A2 (gate chain order inside `routeExtractedFacts`).

### Task A4 - write-time conflict advisory (`t_f79b4fe0`, p3)
- **Files**: `src/core/brain/health/contradiction.ts` (advisory helper export), the feedback write path in `src/core/brain/signal.ts` and its MCP/CLI surfacing, tests.
- **Acceptance**: writing a feedback signal whose principle contradicts a confirmed same-scope preference (per the existing pairwise kernel and thresholds) returns an advisory naming the conflicting preference id; the write itself always proceeds; the advisory appears in the `brain_feedback` MCP response and CLI output and is logged; no advisory fires for non-conflicting writes (test both directions); the extracted-fact path does not double-fire the advisory.
- **Depends on**: none.

### Task A5 - fact signal retire lifecycle (`t_66c12a67`, p3)
- **Files**: new `src/core/brain/signal-retire.ts`, CLI verb wiring (`src/cli/brain.ts`, `help-text.ts`, verb file), tests.
- **Acceptance**: `retireSignal` moves `Brain/inbox/sig-*.md` to `Brain/retired/` with `_status: "retired"`, `retired_at`, `retired_reason`, optional `superseded_by`, tag swap and old-id alias, refusing paths outside the inbox dir; an audit line is appended; retired signals stop being dream-pass intake but remain queryable through the retired-directory fallback; retiring an already-retired or missing id is a typed error.
- **Depends on**: none.

### Task L - docs, CHANGELOG, version bump
- **Files**: `README.md`, `CHANGELOG.md`, `package.json`, mirrored manifests via `bun run scripts/sync-version.ts`, `docs/` pages the units touch (`cli-reference.md`, `mcp.md`, `stability.md` as applicable).
- **Acceptance**: one `## [1.32.0]` CHANGELOG entry with link reference covering all eleven units; README gains short sections for the new surfaces; `bun run sync-version:check` passes; version 1.32.0 (1.31.0 is reserved by the open pull request #138).
- **Depends on**: all previous tasks.
