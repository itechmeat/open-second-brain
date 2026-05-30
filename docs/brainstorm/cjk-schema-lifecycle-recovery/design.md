# CJK search, schema mutation, lifecycle capture, and recovery - shared reliability spine

**Status:** draft
**Author:** GitHub Copilot (via feature-release-playbook)
**Audience:** implementation

## Problem statement

Open Second Brain has four high-priority gaps that now need to ship together: CJK vault search quality, the deferred runtime schema-pack mutation/admin surface, real-time session lifecycle capture, and self-healing brain gateway recovery. The common risk is that three of the four tasks add new write paths around the Brain vault. The PR must deliver the full task scope while preserving the existing Markdown/YAML source of truth, default install ergonomics, and rollback safety guarantees.

## Scope

- CJK-aware FTS indexing and query tokenization for Chinese, Japanese, Korean, and mixed CJK/Latin text, with optional segmenter dependencies and deterministic fallback tokenization.
- A shared internal reliability spine for atomic file replacement, stale-aware file locking, privacy-redacted ISO-week JSONL audit append, and reusable health probe result types.
- Schema-pack mutation primitives for the 11 requested operations, writing only through `Brain/_brain.yaml` and reusing `schema-vocab.ts` for token validation.
- Schema pack-lock, pre-write lint validation, schema mutation audit log, CLI management verbs, MCP admin/read tools, and a schema-author skill workflow.
- Real-time session lifecycle hook capture for SessionStart, UserPromptSubmit, PostToolUse, Stop, and SessionEnd, using the existing hook launcher and Brain write boundaries.
- Brain watchdog probes, lazy remediation planning, opt-in recovery execution, exponential backoff metadata, and safe snapshot restore integration through the existing rollback/snapshot boundary.
- User-facing docs, changelog, version bump, and tracker/kanban completion at release time.

## Out of scope

- A second schema registry database or generated schema-pack state outside `_brain.yaml`.
- Making snapshot auto-restore implicit. Destructive recovery requires an explicit CLI/MCP option and must reuse rollback drift safeguards.
- Replacing the existing post-hoc session import pipeline.
- Cloud vector database storage, subagent orchestration, or provider backend abstraction.
- Changing operational lifecycle enums such as preference status, retire state, or apply-evidence result semantics.

## Chosen approach

Use a small shared reliability spine for the new write-heavy surfaces, while keeping CJK search isolated inside the search subsystem. The spine owns only generic mechanics: atomic file writes, stale-aware locks, audit JSONL append with redaction, and normalized probe/remediation result shapes. Schema mutation, lifecycle capture, and watchdog recovery remain separate domain modules that depend on those primitives rather than sharing business logic.

For CJK search, add an index-time/search-time tokenizer boundary that expands CJK runs into segment tokens while preserving the original text for exact matching and display. Optional segmenters improve Chinese/Japanese segmentation when installed; the default fallback still improves CJK recall without making base installs fail.

## Design decisions

- **CJK search uses an FTS-only shadow column.** Add a `chunks.fts_content` column and rebuild `chunk_fts` to index `fts_content` plus `heading_path`, while hydrated result snippets continue to read `chunks.content`. This avoids polluting displayed chunk text with token expansion.
- **CJK query tokenization mirrors indexing.** `buildFtsMatch` receives tokenizer-expanded terms for CJK runs so unspaced queries can match the indexed segments. Mixed CJK/Latin order is preserved by walking Unicode runs once.
- **Optional segmenters are isolated.** Dynamic loading lives in one module. Missing `@node-rs/jieba` or `tiny-segmenter` degrades to deterministic bigram/unigram fallback and can emit a one-time structured warning where callers expose warnings.
- **Schema mutations edit `_brain.yaml` only.** The schema pack remains the `_brain.yaml schema:` block plus optional metadata under that block. No hidden registry DB, no generated active-pack file.
- **Schema metadata is forward-compatible.** The existing array categories remain valid. Additional fields for aliases, prefixes, link types, extractable tokens, and expert routing are parsed and validated by new schema-pack helpers without breaking vaults that only use the v0.25.0 shape.
- **Mutation ops are batched and prevalidated.** `schema_apply_mutations` and CLI apply perform all mutations against an in-memory candidate, run schema lint, and write atomically only if the batch is valid.
- **Pack-lock uses the shared lock primitive.** Lock TTL and stale detection are configurable, but default to conservative values aligned with the existing proper-lockfile use in search indexing.
- **MCP admin tools are full-scope only.** Read operations can appear on the normal full server; mutation runs through `schema_apply_mutations`, not writer-only scope, so narrow writer surfaces do not grow silently.
- **Lifecycle hooks capture structured events, not speculative preferences.** Hook capture records lifecycle observations and extracts explicit `@osb` markers/tool feedback through the existing signal boundaries. It does not infer preferences from arbitrary prompts.
- **Hook handlers stay fast and quiet.** They target sub-150ms local work in normal cases, never crash the host runtime, and enqueue/audit only small payloads.
- **Watchdog recovery is opt-in for destructive actions.** Probe and recommendation are always safe. Search-index repair and hook/config reload can run automatically when requested. Snapshot restore requires an explicit restore mode and reuses rollback drift checks.

## File changes

Expected new files:

- `src/core/reliability/atomic.ts`
- `src/core/reliability/audit.ts`
- `src/core/reliability/lock.ts`
- `src/core/reliability/probe.ts`
- `src/core/search/cjk-tokenizer.ts`
- `src/core/brain/schema-pack.ts`
- `src/core/brain/schema-mutate.ts`
- `src/core/brain/schema-admin.ts`
- `src/core/brain/session-lifecycle.ts`
- `src/core/brain/watchdog.ts`
- `src/cli/brain/verbs/session-hook.ts`
- `src/cli/brain/verbs/watchdog.ts`
- `hooks/session-capture.ts`
- `skills/schema-author/SKILL.md`
- focused tests under `tests/core/`, `tests/cli/`, `tests/mcp/`, and `tests/hooks/`

Expected modified files:

- Search schema/store/indexer/search/FTS modules and related tests.
- Brain schema vocabulary/report/CLI/MCP registration and help/manifest files.
- Brain session hook config and hook README.
- Snapshot/rollback integration only through public helpers, not by changing rollback semantics.
- README, docs, CHANGELOG, package metadata, and lockfile for optional dependencies/version bump.

## Risks and open questions

- CJK FTS migration must preserve existing indexes and make reindex guidance clear when old DBs lack `fts_content`.
- Optional native segmenter availability may vary by platform. The fallback path must be test-covered and useful without native packages.
- The schema metadata shape under `_brain.yaml schema:` is new; tests must lock compatibility with the existing simple-array foundation shape.
- MCP tool count and scopes must remain explicit so admin mutation does not leak into writer-only runtime configurations.
- Real-time hooks can duplicate post-hoc import if they process the same explicit marker later. Dedup hashes must be reused.
- Watchdog remediation can become dangerous if it bypasses drift detection. Snapshot restore must call the same safety checks as rollback or require an explicit force flag.
