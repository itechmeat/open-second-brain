# MCP context economy - implementation plan

Five atomic units, each TDD (failing test first), each its own conventional commit
on `feat/mcp-context-economy`. Order matters: store -> seam -> fetch tool -> wiring -> hint.

## Tasks

### Task 1: Artifact store
- **Files**: `src/core/brain/paths.ts` (add `BRAIN_ARTIFACTS_REL`, dir ctor, id validation), `src/mcp/artifact-store.ts`, `tests/mcp/artifact-store.test.ts`.
- **Acceptance**: store writes full text atomically under `Brain/.artifacts/<run-id>/<artifact-id>.json`; `read(id)` round-trips; content-hash id is stable for identical input; traversal / malformed ids rejected; secret-shaped tokens redacted before persist; `prune(ttl)` removes stale run dirs and keeps fresh ones.
- **Depends on**: none.

### Task 2: Preview-budget seam (MCP dispatch)
- **Files**: `src/mcp/preview-budget.ts`, `src/mcp/tools.ts` (`previewBudget?` on `ToolDefinition`), `src/mcp/server.ts` (wrap in `handleToolsCall`, store on instance + injectable run-id), `tests/mcp/preview-budget.test.ts`, `tests/mcp/preview-budget-dispatch.test.ts`.
- **Acceptance**: a tool with a small `previewBudget` and an over-budget result returns `content[0].text` = valid JSON `{preview_truncated:true, artifact_id, full_chars, bytes_preview}`, `bytes_preview.length <= budget`, `structuredContent` is the full object, and the artifact holds the full text; an under-budget result is byte-identical to today; a tool with no budget is byte-identical to today; the CLI bridge (`callTool`) always returns full text regardless of budget.
- **Depends on**: Task 1.

### Task 3: brain_artifact_get tool
- **Files**: `src/mcp/brain-tools.ts` (handler), `src/mcp/tools.ts` (register), `src/mcp/instructions.ts` (protocol docs), `tests/mcp/artifact-get.test.ts`.
- **Acceptance**: `brain_artifact_get(artifact_id)` returns `{artifact_id, full_chars, content}` for a stored id; unknown / expired id returns a tool-level error envelope (not a thrown 500); traversal id rejected; tool present in `tools/list` under full scope.
- **Depends on**: Task 1, Task 2.

### Task 4: Wire budgets onto large tools
- **Files**: `src/mcp/search-tools.ts`, `src/mcp/brain-tools.ts`, `src/mcp/tools.ts`, `src/mcp/pay-memory-tools.ts`.
- **Acceptance**: the enumerated large tools (`brain_search`, `brain_context_pack`, `brain_digest`, `brain_timeline`, `brain_concept_synthesis`, `brain_operator_summary`, `brain_weekly_synthesis`, `brain_monthly_review`, `brain_daily_brief`, `second_brain_status`, `second_brain_query`) carry a `previewBudget`; small status/echo tools do not; a table-level test asserts the exact opted-in set so the list stays intentional.
- **Depends on**: Task 2.

### Task 5: Recall hint
- **Files**: `src/core/search/recall-hint.ts`, `src/mcp/search-tools.ts` (add `recall_hint` to output + `SEARCH_OUTPUT_SCHEMA`), `src/mcp/tools.ts` (`brain_query`/`second_brain_query` hint), `tests/core/search/recall-hint.test.ts`.
- **Acceptance**: `deriveRecallHint` returns one English-template string built from counts (total, per-`searchType`, top score); field omitted when zero results; never reads or stores natural-language phrase tables; existing `brain_search` consumers still validate (additive optional field).
- **Depends on**: none (independent; sequenced last to keep search-tools edits together).
