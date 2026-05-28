# Cross-agent query foundation - implementation plan

## Tasks

### Task 1: Registry-driven agent-source groundwork
- **Files**: `src/core/brain/sessions/types.ts`, `src/core/brain/sessions/registry.ts`, `src/core/brain/sessions/import.ts`, `src/cli/brain/verbs/import-session.ts`, `src/cli/brain/help-text.ts`, `tests/core/brain.sessions.registry.test.ts`, `tests/cli/brain/import-session.test.ts`
- **Acceptance**: the import surface uses registry-owned helpers for format validation, help choices, and default agent labeling; adding a future adapter does not require changing query-layer code.
- **Depends on**: none

### Task 2: Vault provenance provider
- **Files**: `src/core/brain/agent-source/types.ts`, `src/core/brain/agent-source/registry.ts`, `src/core/brain/agent-source/vault-provider.ts`, `tests/core/brain.agent-source.provider.test.ts`
- **Acceptance**: the provider enumerates available source agents and emits a normalized contribution record over signals, preferences, and log events without writing to the vault.
- **Depends on**: Task 1

### Task 3: Agent query core
- **Files**: `src/core/brain/agent-source/query.ts`, `src/core/brain/agent-source/summary.ts`, `tests/core/brain.agent-source.query.test.ts`
- **Acceptance**: deterministic query over one or more agents returns a structured result envelope with matched contributions, source summary, and an explainable synthesized summary derived from the matched data.
- **Depends on**: Task 2

### Task 4: Agent diff core
- **Files**: `src/core/brain/agent-source/diff.ts`, any shared helper under `src/core/brain/agent-source/`, `tests/core/brain.agent-source.diff.test.ts`
- **Acceptance**: browse/search/diff/map modes compare agent contributions and surface shared vs unique topics/concepts using the normalized contribution model from Task 3.
- **Depends on**: Task 3

### Task 5: MCP surfaces
- **Files**: `src/mcp/brain-tools.ts`, `tests/mcp/brain-agent-query.test.ts`, `tests/mcp/brain-agent-diff.test.ts`
- **Acceptance**: `brain_agent_query` and `brain_agent_diff` are exposed as read-only MCP tools with stable structured envelopes and validation errors consistent with existing brain tools.
- **Depends on**: Task 4

### Task 6: CLI surfaces
- **Files**: `src/cli/brain/verbs/agent-query.ts`, `src/cli/brain/verbs/agent-diff.ts`, `src/cli/brain.ts`, `src/cli/brain/help-text.ts`, `tests/cli/brain/agent-query.test.ts`, `tests/cli/brain/agent-diff.test.ts`, `tests/cli/help-text.test.ts`
- **Acceptance**: `o2b brain agent-query` and `o2b brain agent-diff` ship with markdown and `--json` modes and match the MCP result semantics.
- **Depends on**: Task 5

### Task 7: Docs update
- **Files**: `README.md`, `CHANGELOG.md`, and any implementation-facing docs required by the final surface
- **Acceptance**: user-facing docs describe the new cross-agent query foundation and first comparison surface; CHANGELOG has one version entry for this PR only.
- **Depends on**: Task 6
