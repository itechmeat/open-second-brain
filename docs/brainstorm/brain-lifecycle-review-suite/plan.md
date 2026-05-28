# Brain Lifecycle Review Suite - implementation plan

## Tasks

### Task 1: Schema contracts foundation
- **Files**: `src/core/brain/schema-contracts.ts`, `src/core/brain/schema-validator.ts`, `schemas/brain/*.schema.json`, tests under `tests/core/`.
- **Acceptance**: failing tests first prove the expected schemas are registered, exported deterministically, and validate representative valid/invalid lifecycle envelopes without external dependencies.
- **Depends on**: none.

### Task 2: Intent review stage
- **Files**: `src/core/brain/intent-review.ts`, `src/core/brain/dream.ts`, `src/core/brain/review-candidates.ts`, `src/mcp/brain-tools.ts`, `src/cli/brain/verbs/intent-review.ts`, CLI/MCP/core tests.
- **Acceptance**: tests prove active signal clusters receive deterministic decisions and that `dream` / `brain_review_candidates` surface intent-review data while preserving existing promotion, suppression, quarantine, and contradiction outcomes.
- **Depends on**: Task 1.

### Task 3: Retention recommendations
- **Files**: `src/core/brain/retention.ts`, `src/mcp/brain-tools.ts`, `src/cli/brain/verbs/retention.ts`, core/CLI/MCP tests.
- **Acceptance**: tests prove retired preferences and processed signals are classified into `keep`, `improve`, `park`, or `prune` with reasons and no filesystem mutation.
- **Depends on**: Task 1.

### Task 4: Monthly review projection
- **Files**: `src/core/brain/monthly-review.ts`, `src/mcp/brain-tools.ts`, `src/cli/brain/verbs/monthly.ts`, temporal/core/CLI/MCP tests.
- **Acceptance**: tests prove a month window aggregates events, transitions, contradictions, source pointers, neglected areas, and generated metadata in stable order; CLI `--json` mirrors the MCP envelope.
- **Depends on**: Task 1.

### Task 5: Complexity-to-thinking discipline metric
- **Files**: `src/core/discipline/complexity.ts`, `src/core/discipline/decision.ts`, `src/core/discipline/report.ts`, `src/core/discipline/render.ts`, discipline tests.
- **Acceptance**: tests prove high structural complexity with low thinking output produces an explicit productivity-trap warning, while taste events and existing activity alerts retain their current behavior.
- **Depends on**: Task 1.

### Task 6: CLI/MCP registration polish
- **Files**: `src/cli/brain.ts`, `src/cli/brain/verbs/index.ts`, `src/cli/brain/help-text.ts`, `src/mcp/brain-tools.ts`, tests under `tests/cli/` and `tests/mcp/`.
- **Acceptance**: tests prove new verbs/tools are discoverable, reject malformed inputs, and return stable JSON shapes.
- **Depends on**: Tasks 2, 3, 4, 5.

### Task 7: Documentation and release notes
- **Files**: `README.md`, `docs/cli-reference.md`, `docs/how-it-works.md`, `CHANGELOG.md`, optional release draft artifacts.
- **Acceptance**: docs describe the new lifecycle review suite using the full project name and list the CLI/MCP surfaces accurately; changelog has one new version entry for the PR.
- **Depends on**: Tasks 2, 3, 4, 5, 6.
