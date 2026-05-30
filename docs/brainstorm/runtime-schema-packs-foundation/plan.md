# Runtime Schema Packs Foundation - implementation plan

## Tasks

### Task 1: Schema vocabulary core

- **Files**: `src/core/brain/schema-vocab.ts`, `tests/core/brain/schema-vocab.test.ts`.
- **Acceptance**: Tests prove built-in vocabulary is frozen, tokens normalize deterministically, invalid tokens are rejected with field-specific errors, duplicate declarations collapse deterministically, and absent config resolves to built-ins only.
- **Depends on**: none.

### Task 2: `_brain.yaml` schema block

- **Files**: `src/core/brain/types.ts`, `src/core/brain/policy.ts`, `tests/core/brain.policy.test.ts` or a focused schema config test.
- **Acceptance**: Tests prove `schema:` is optional, default config remains unchanged, inline arrays parse, invalid tokens fail with field names, unknown schema subkeys warn, and resolved schema vocabulary merges built-ins with user declarations.
- **Depends on**: Task 1.

### Task 3: Artifact schema metadata

- **Files**: `src/core/brain/types.ts`, `src/core/brain/preference.ts`, `src/core/brain/signal.ts`, focused parser/writer tests.
- **Acceptance**: Tests prove preferences/retired artifacts and signals parse optional schema metadata when present, writers emit it only when supplied, invalid schema metadata is rejected when a vocabulary is provided, and existing no-schema fixtures remain byte-identical.
- **Depends on**: Task 1 and Task 2.

### Task 4: Read-only schema report

- **Files**: `src/core/brain/schema-report.ts`, `tests/core/brain/schema-report.test.ts`.
- **Acceptance**: Tests prove the report returns resolved vocabulary, used token counts by artifact kind, unknown token findings, unused declared-token findings, stable ordering, and frozen output without mutating the vault.
- **Depends on**: Task 1, Task 2, Task 3.

### Task 5: CLI schema inspection

- **Files**: `src/cli/brain/verbs/schema.ts`, `src/cli/brain.ts`, `src/cli/brain/verbs/index.ts`, `src/cli/brain/help-text.ts`, `src/cli/command-manifest.ts`, `tests/cli/brain-schema-cli.test.ts`.
- **Acceptance**: `o2b brain schema [--vault <path>] [--json]` prints a human summary and a stable JSON report. CLI tests cover a default vault, a custom schema block, and unknown-token lint output.
- **Depends on**: Task 4.

### Task 6: Phase 5 docs and version

- **Files**: `README.md`, `docs/cli-reference.md`, `CHANGELOG.md`, version manifests.
- **Acceptance**: Docs describe schema-pack foundation, explicit out-of-scope mutation surface, and CLI usage. `bun run sync-version:check` passes after version bump.
- **Depends on**: Tasks 1-5 and Phase 4 QA.
