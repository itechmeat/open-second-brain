# CJK search, schema mutation, lifecycle capture, and recovery - implementation plan

## Tasks

### Task 1: Shared reliability spine
- **Files**: `src/core/reliability/atomic.ts`, `src/core/reliability/lock.ts`, `src/core/reliability/audit.ts`, `src/core/reliability/probe.ts`, `tests/core/reliability/*.test.ts`
- **Acceptance**: Tests prove atomic replacement preserves old content on validation failure, stale locks are reported deterministically, redacted JSONL audit records are appended under ISO-week paths, and probe result helpers produce stable JSON.
- **Depends on**: none

### Task 2: CJK search tokenizer
- **Files**: `src/core/search/cjk-tokenizer.ts`, `src/core/search/schema.ts`, `src/core/search/store.ts`, `src/core/search/indexer.ts`, `src/core/search/fts.ts`, `src/core/search/search.ts`, `tests/core/search/cjk-tokenizer.test.ts`, `tests/core/search.test.ts`, `package.json`, `bun.lock`
- **Acceptance**: A failing test first demonstrates that unspaced CJK query text does not retrieve matching CJK content; implementation then passes with indexed `fts_content`, query tokenization, optional segmenter soft-fail fallback, and no display-content pollution.
- **Depends on**: none

### Task 3: Schema mutation core
- **Files**: `src/core/brain/schema-vocab.ts`, `src/core/brain/types.ts`, `src/core/brain/policy.ts`, `src/core/brain/schema-pack.ts`, `src/core/brain/schema-mutate.ts`, `src/core/brain/schema-report.ts`, `tests/core/brain/schema-pack.test.ts`, `tests/core/brain/schema-mutate.test.ts`, `tests/core/brain/schema-report.test.ts`
- **Acceptance**: Tests cover all 11 mutation primitives, batched prevalidation, atomic `_brain.yaml` writes, lock contention, schema lint findings, and audit log redaction without breaking existing simple-array schema config.
- **Depends on**: Task 1

### Task 4: Schema CLI and MCP admin surface
- **Files**: `src/cli/brain/verbs/schema.ts`, `src/cli/brain/help-text.ts`, `src/cli/command-manifest.ts`, `src/mcp/schema-tools.ts`, `src/mcp/tools.ts`, `tests/cli/brain-schema-cli.test.ts`, `tests/mcp/schema-tools.test.ts`, `skills/schema-author/SKILL.md`
- **Acceptance**: CLI tests cover `stats`, `lint`, `graph`, `explain`, `orphans`, `apply`, `sync`, and JSON output. MCP tests cover the 9 requested tools: `get_active_schema_pack`, `list_schema_packs`, `schema_stats`, `schema_lint`, `schema_graph`, `schema_explain_type`, `schema_review_orphans`, `schema_apply_mutations`, and `reload_schema_pack`.
- **Depends on**: Task 3

### Task 5: Real-time session lifecycle capture
- **Files**: `src/core/brain/session-lifecycle.ts`, `src/cli/brain/verbs/session-hook.ts`, `src/cli/brain.ts`, `src/cli/brain/help-text.ts`, `src/cli/command-manifest.ts`, `hooks/session-capture.ts`, `hooks/hooks.json`, `hooks/README.md`, `tests/core/brain/session-lifecycle.test.ts`, `tests/cli/brain-session-hook.test.ts`, `tests/hooks/session-capture.test.ts`
- **Acceptance**: Tests cover SessionStart, UserPromptSubmit, PostToolUse, Stop, and SessionEnd payloads; explicit markers/tool feedback write immediately through existing signal/dedup boundaries; lifecycle observations audit/log without crashing malformed hook payloads.
- **Depends on**: Task 1

### Task 6: Brain watchdog and safe recovery
- **Files**: `src/core/brain/watchdog.ts`, `src/cli/brain/verbs/watchdog.ts`, `src/cli/brain.ts`, `src/cli/brain/help-text.ts`, `src/cli/command-manifest.ts`, `src/mcp/brain-tools.ts` or `src/mcp/watchdog-tools.ts`, `tests/core/brain/watchdog.test.ts`, `tests/cli/brain-watchdog.test.ts`, `tests/mcp/watchdog-tools.test.ts`
- **Acceptance**: Tests cover healthy probes, degraded probes, lazy remediation plans, search-index repair recommendation, explicit recovery execution, exponential backoff metadata, audit output, and snapshot restore refusal unless explicit restore/force options are provided.
- **Depends on**: Task 1

### Task 7: Documentation, changelog, version, and release prep
- **Files**: `README.md`, `docs/cli-reference.md`, `docs/how-it-works.md`, `docs/mcp.md`, `CHANGELOG.md`, `package.json`, synced version files
- **Acceptance**: Docs describe the new CJK search behavior, schema authoring/admin surface, lifecycle capture hooks, and watchdog safety model. `bun run sync-version:check` passes after the required version bump.
- **Depends on**: Tasks 2-6

## TDD order

1. Task 1 reliability spine tests, implementation, focused test run.
2. Task 2 CJK search failing test, implementation, focused search test run.
3. Task 3 schema mutation failing tests, implementation, focused schema test run.
4. Task 4 CLI/MCP failing tests, implementation, focused CLI/MCP test run.
5. Task 5 lifecycle hook failing tests, implementation, focused hook/session test run.
6. Task 6 watchdog failing tests, implementation, focused watchdog test run.
7. Task 7 docs/version update, then full QA.

## Commit plan

- `chore(brainstorm): cjk-schema-lifecycle-recovery`
- `feat(core): add shared reliability primitives`
- `feat(search): add cjk-aware vault search tokenization`
- `feat(schema): add schema mutation and admin surface`
- `feat(brain): capture session lifecycle hooks`
- `feat(brain): add watchdog recovery probes`
- `docs: document cjk schema lifecycle recovery release`
