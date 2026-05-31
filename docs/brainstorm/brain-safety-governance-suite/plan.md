# Brain Safety & Governance Suite - implementation plan

## Tasks

### Task 1: Context guard core
- **Files**: `src/core/brain/safety/context-guard.ts`, `tests/core/brain/context-guard.test.ts`
- **Acceptance**: tests prove deterministic reason IDs for direct instruction phrases, delimiter spoofing, metadata/title injection, Unicode-obfuscated variants, trusted instruction allowlisting, and ordinary-note false positives.
- **Depends on**: none

### Task 2: Guard automatic surfacing
- **Files**: `src/core/brain/context-pack.ts`, `src/core/brain/pre-compress-pack.ts`, `src/mcp/brain-tools.ts`, `tests/core/brain/context-pack.test.ts`, `tests/core/brain/pre-compress-pack.test.ts`, `tests/mcp/context-pack-tool.test.ts`
- **Acceptance**: context-pack and pre-compress outputs no longer include hostile snippets verbatim, MCP JSON includes deterministic safety reports, trusted instruction sources remain available, and existing private-region/secret redaction tests still pass.
- **Depends on**: Task 1

### Task 3: Agent-blind secret references
- **Files**: `src/core/brain/safety/secret-ref.ts`, `src/core/config.ts`, `src/cli/main.ts`, `tests/core/secret-ref.test.ts`, `tests/core/config.test.ts`, `tests/cli/main.test.ts`
- **Acceptance**: `$secret:NAME` values store as references, resolve only inside local process helpers, list/status output never includes raw values, known resolved values are redacted from diagnostics, and missing references fail explicitly.
- **Depends on**: none

### Task 4: Governance preview foundation
- **Files**: `src/core/brain/governance/forget-plan.ts`, `src/core/brain/packs/pack.ts`, `src/core/brain/payload-registry.ts`, `src/cli/brain.ts`, `src/cli/brain/verbs/index.ts`, new CLI verb files, `tests/core/brain/forget-plan.test.ts`, `tests/core/brain/pack.test.ts`, `tests/core/brain/payload-registry.test.ts`, `tests/cli/brain.test.ts`
- **Acceptance**: dry-run forget plans, pack export previews, and payload registry reports return deterministic manifests with counts, hashes, provenance, conflicts/warnings, and privacy reasons without mutating unrelated Brain content.
- **Depends on**: Task 1, Task 3

### Task 5: Documentation and release metadata
- **Files**: `README.md`, `docs/cli-reference.md`, `docs/mcp.md`, `CHANGELOG.md`, `package.json`, `plugin.yaml`, `openclaw.plugin.json`, version sync targets if required
- **Acceptance**: docs describe the new safety and preview surfaces; changelog has one next-version entry; version sync check passes after the required pre-push version bump.
- **Depends on**: Tasks 1-4

### Task 6: QA, self-review, and pre-push stop point
- **Files**: no source files expected unless checks reveal defects
- **Acceptance**: formatter, linter, typecheck, tests, sync-version check, focused smoke commands, and self-review against `main` all pass before the pre-push `ask_report` stop point.
- **Depends on**: Tasks 1-5