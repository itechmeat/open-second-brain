# Context Continuity & Receipts Suite - implementation plan

## Tasks

### Task 1: Continuity record substrate

- **Files**: `src/core/brain/continuity/types.ts`, `src/core/brain/continuity/store.ts`, `src/core/brain/continuity/redaction.ts`, `tests/core/brain/continuity-store.test.ts`
- **Acceptance**: append/read/filter/paginate redaction-safe continuity records under `Brain/log/continuity/`; stable IDs and source refs; source invalidation markers; corrupt-line tolerance.
- **Depends on**: none

### Task 2: Prompt context receipts

- **Files**: `src/core/brain/context-receipts.ts`, `src/core/brain/context-pack.ts`, `src/core/brain/pre-compress-pack.ts`, CLI/MCP receipt surfaces, receipt tests
- **Acceptance**: context-pack and pre-compress can optionally emit receipts with item IDs, source paths/hashes, budgets, lanes/safety/redaction flags, final text hash; list/show filters work; no raw private content by default.
- **Depends on**: Task 1

### Task 3: Recall telemetry log and summary

- **Files**: `src/core/brain/recall-telemetry.ts`, search/context-pack/pre-compress call wrappers, CLI/MCP telemetry surfaces, tests
- **Acceptance**: optional telemetry records recall/context-pack status, duration, mode, result count, top artifacts, cache/budget metadata, and gaps; view and summary filters produce JSON; disabled/redacted modes preserve privacy.
- **Depends on**: Task 1

### Task 4: Context transforms

- **Files**: `src/core/brain/context-transforms.ts`, `src/core/brain/context-pack.ts`, MCP/CLI context-pack options, tests
- **Acceptance**: opt-in cache-stable ordering keeps selected blocks but records `original_rank` and movement diagnostics; session-scoped dedup replaces repeated blocks with reference hints only when an accessible original exists; default behavior unchanged.
- **Depends on**: Task 2

### Task 5: Context budget presets

- **Files**: `src/core/brain/context-presets.ts`, CLI/MCP preset diagnostics, optional token-footprint/doctor warning only when it reuses the existing diagnostic output path without adding remediation behavior, tests
- **Acceptance**: read-only `show`, `suggest`, and `diff` expose tight-context and long-context presets with match reason/confidence, proposed changes, explicit override preservation, and invalid override reporting.
- **Depends on**: none

### Task 6: Pre-compaction extraction

- **Files**: `src/core/brain/pre-compact-extract.ts`, CLI/MCP extraction surface, timeline/search integration if bounded, tests
- **Acceptance**: bounded segment input emits typed decision/commitment/outcome/rule/open-question records with source turn refs; deterministic media/base64 sanitization; idempotent by session+turn range+content hash; failures are non-blocking and reported.
- **Depends on**: Task 1

### Task 7: Session recall DAG foundation

- **Files**: `src/core/brain/session-recall.ts`, session adapter reuse, CLI/MCP `session-grep`/`session-describe`/`session-expand`, tests
- **Acceptance**: imported session turns can be stored as raw turn records; deterministic summary nodes at two depths keep source lineage; search returns bounded raw and summary hits; expand returns immediate sources and paginated exact raw content; duplicate import idempotent.
- **Depends on**: Task 1

### Task 8: Docs, version, self-review, QA, PR

- **Files**: `README.md`, `docs/cli-reference.md`, `docs/mcp.md`, `CHANGELOG.md`, package/manifests, PR body
- **Acceptance**: user-facing docs describe opt-in behavior and privacy defaults; version bumped before push; self-review checks diff against `main`; full QA passes; pre-push ask_report stop-point completed.
- **Depends on**: Tasks 1-7
