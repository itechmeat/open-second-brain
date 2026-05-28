# Agent Boundary Control Surfaces - implementation plan

## Tasks

### Task 1: Private-region redaction helper
- **Files**: `src/core/redactor.ts`, `tests/core/redactor.test.ts`, docs that describe redaction.
- **Acceptance**: `bun test tests/core/redactor.test.ts` proves balanced, case-insensitive, multiline, and unclosed `<private>...</private>` regions are stripped before secret redaction and normalisation.
- **Depends on**: none.

### Task 2: Pinned context core
- **Files**: `src/core/brain/paths.ts`, `src/core/brain/pinned.ts`, `tests/core/brain.pinned.test.ts`.
- **Acceptance**: focused core tests prove missing pinned context reads as empty, write/append/clear are vault-safe and deterministic, and content is sanitised through the shared redactor.
- **Depends on**: Task 1.

### Task 3: Pinned context MCP surface
- **Files**: `src/mcp/brain-tools.ts`, `src/mcp/tools.ts`, `src/mcp/instructions.ts`, `tests/mcp/brain.test.ts`, `tests/mcp/mcp.test.ts`.
- **Acceptance**: MCP tests prove `brain_pinned_context` read/write/append/clear behaviour and prove `brain_context` returns a structured `pinned` block while preserving existing active context fields.
- **Depends on**: Task 2.

### Task 4: Configurable link output format
- **Files**: `src/core/config.ts`, `src/core/brain/wikilink.ts`, presentation call sites selected during implementation, `tests/core/brain.wikilink.test.ts`, relevant CLI/MCP tests.
- **Acceptance**: tests prove default wikilink output remains unchanged, `link_output_format: markdown` renders stable Markdown links for preference/retired references in presentation output, and invalid config values fall back to wikilink.
- **Depends on**: none.

### Task 5: MCP output contracts
- **Files**: `src/mcp/output-contract.ts`, `src/mcp/tools.ts`, `src/mcp/server.ts`, `src/mcp/brain-tools.ts`, `src/mcp/search-tools.ts`, `tests/mcp/output-contract.test.ts`, `tests/mcp/mcp.test.ts`; use `tests/mcp/mcp-json.test.ts` only for existing JSON-envelope regression coverage that already belongs there.
- **Acceptance**: focused tests prove the schema subset validator, MCP tool calls validate `structuredContent` before text serialization, declared contracts pass for covered tools, and a deliberately invalid handler shape becomes an internal tool error.
- **Depends on**: Task 3 for the new pinned-context contract.

### Task 6: Documentation, changelog, and version bump
- **Files**: `README.md`, `docs/mcp.md`, `docs/how-it-works.md`, `docs/cli-reference.md`, `CHANGELOG.md`, `package.json`, version-synced files.
- **Acceptance**: docs describe pinned context, link output config, MCP contracts, and private-region stripping; `bun run sync-version:check` passes after the explicit pre-push version bump.
- **Depends on**: Tasks 1-5.

### Task 7: Self-review and QA
- **Files**: no planned source changes unless review finds defects.
- **Acceptance**: self-review compares the feature branch against `main`; focused tests, `bun run typecheck`, `bun run lint`, `bun run sync-version:check`, and `bun run validate` pass or any failure is fixed in-branch before the pre-push `ask_report` stop-point.
- **Depends on**: Task 6.
