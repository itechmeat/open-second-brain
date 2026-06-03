# Agent Surface Suite - implementation plan

## Tasks

### Task 1: Kernel A - surface descriptors and lexical scorer
- **Files**: `src/core/surface/descriptor.ts`, `src/core/surface/lexical-score.ts`, `tests/core/surface/descriptor.test.ts`, `tests/core/surface/lexical-score.test.ts`
- **Acceptance**: `SurfaceDescriptor` builds deterministically (sorted) from `ToolDefinition[]`; BM25-style scorer ranks descriptors for a query with name-field boost; empty query / empty corpus return empty rankings; scoring is pure and reproducible.
- **Depends on**: none

### Task 2: Skill discovery module
- **Files**: `src/core/surface/skills.ts`, `tests/core/surface/skills.test.ts`
- **Acceptance**: scans repo `skills/` plus optional `<vault>/Brain/skills/`; parses SKILL.md title + first-paragraph description; missing/empty roots yield `[]` (fail-soft); `readSkillFile` rejects path traversal and absolute paths.
- **Depends on**: Task 1 (descriptor shape)

### Task 3: list_skills / get_skill MCP tools (t_251c6490)
- **Files**: `src/mcp/skill-tools.ts`, `src/mcp/tools.ts`, `tests/mcp/skill-tools.test.ts`
- **Acceptance**: `list_skills` returns name/description/path for repo skills; `get_skill` returns SKILL.md content, optional `file_path` reads auxiliary files inside the skill dir only; unknown skill -> tool error; registered in `buildToolTable` and visible in `tools/list`.
- **Depends on**: Task 2

### Task 4: Two-pass tool catalog hydration (t_e8011a89)
- **Files**: `src/mcp/hydrate-tool.ts`, `src/mcp/tools.ts` (`ToolScope` + `"catalog"`), `src/mcp/server.ts`, `src/mcp/instructions.ts`, `tests/mcp/catalog-scope.test.ts`
- **Acceptance**: scope `"catalog"`: `tools/list` advertises diagnostic + writer five + `tool_hydrate` only; every other tool remains callable via `tools/call`; `tool_hydrate` (no args) returns the sorted compact catalog; `tool_hydrate {names}` returns full schemas; unknown names reported per-name without failing the batch; `full`/`writer` scopes byte-identical to before.
- **Depends on**: Task 1

### Task 5: Adaptive tool-surface profiles (t_20dcb192)
- **Files**: `src/mcp/profiles.ts`, `src/cli/main.ts` (`--tool-profile`), `src/core/config.ts` (`mcp_tool_profile`), `tests/mcp/profiles.test.ts`
- **Acceptance**: named profiles full/writer/catalog/recall/minimal resolve to scope + capability window; unknown profile fails OPEN to full with a capability-report note; every non-full profile retains `second_brain_capabilities` + `tool_hydrate`; flag wins over config key; default (no key, no flag) bit-identical to today.
- **Depends on**: Task 4

### Task 6: Skill auto-attach (t_10b86707)
- **Files**: `src/core/surface/skill-attach.ts`, `src/mcp/skill-tools.ts` (`skills_attach`), `src/core/config.ts` (`skill_auto_attach`), `plugins/hermes/provider.py`, `tests/core/surface/skill-attach.test.ts`, `tests/mcp/skills-attach-tool.test.ts`
- **Acceptance**: scorer returns top-k skills over threshold within a token budget; `skills_attach` returns `{enabled:false, block:""}` when config off (default); enabled path returns deterministic block with skill names + descriptions + paths; provider.py prefetch appends the block fail-soft (Python diff is one call).
- **Depends on**: Tasks 1, 2, 3

### Task 7: Kernel B - session-scope resolver
- **Files**: `src/core/brain/session-scope.ts`, `tests/core/brain/session-scope.test.ts`
- **Acceptance**: `resolveSessionScope` normalises arbitrary session ids / workstream labels to `[a-z0-9-]` slugs, length-capped, deterministic; rejects empty input with a typed error.
- **Depends on**: none

### Task 8: Role-based capture filtering (t_e2346fe9)
- **Files**: `src/core/config.ts` (`resolveSessionCaptureRoles`), `src/cli/brain.ts` / `src/cli/brain/` import-session verb, `src/core/brain/session-lifecycle.ts`, `tests/core/config.capture-roles.test.ts`, `tests/cli/import-session-roles.test.ts`
- **Acceptance**: `session_capture_roles: "user,assistant"` filters import when no explicit flag; explicit `--filter-roles` flag wins; absent/empty key captures all roles (bit-identical); invalid role name -> fail-fast config error.
- **Depends on**: none

### Task 9: Session-scoped focus (t_5b478e47)
- **Files**: `src/core/search/session-focus.ts`, `src/cli/search.ts` (`--session`), `src/mcp/search-tools.ts` (`focus_session`), `src/core/brain/context-pack.ts` (gated boost), `src/core/brain/session-lifecycle.ts` (auto-clear), `src/core/config.ts` (`search_focus_context_pack`), `tests/core/search/session-focus-scoped.test.ts`, `tests/core/brain/context-pack-focus.test.ts`
- **Acceptance**: per-session focus file `search-focus/<scope>.json`; session focus wins over global; `focus set/status/clear --session` round-trips; SessionEnd lifecycle event clears the matching session focus; context-pack boost only when `search_focus_context_pack: "true"` (default off, pack byte-identical).
- **Depends on**: Task 7

### Task 10: Operator-readable handoff notes (t_28afa4d2)
- **Files**: `src/core/brain/handoff.ts`, `src/cli/brain.ts` (`handoff` verb), `src/core/brain/session-lifecycle.ts` (gated SessionEnd generation), `src/core/config.ts` (`session_handoff`), `tests/core/brain/handoff.test.ts`
- **Acceptance**: `buildHandoffNote` extracts request / completed work / files changed / learned context / next steps from `SessionTurn[]` by regex; writes `Brain/handoffs/<date>-<scope>.md`; CLI verb works on a real session fixture via the adapters; SessionEnd generation only when `session_handoff: "true"` (default off).
- **Depends on**: Task 7

### Task 11: Scoped intention chains (t_6d78f69e)
- **Files**: `src/core/brain/intentions.ts`, `src/cli/brain.ts` (`intention` verb), `src/mcp/brain-tools.ts` (`brain_intention`), `src/cli/command-manifest.ts`, `tests/core/brain/intentions.test.ts`, `tests/mcp/brain-intention-tool.test.ts`
- **Acceptance**: `set` creates/updates `Brain/intentions/<scope>.md` bumping `version` and appending a timestamped history line; `show`/`list` read; `move` archives to `Brain/intentions/history/<scope>-<date>.md` and removes the active file; MCP tool mirrors all four operations; `Brain/pinned.md` untouched.
- **Depends on**: Task 7

### Task 12: Integration test + command manifest + docs surface
- **Files**: `tests/integration/agent-surface.integration.test.ts`, `src/cli/command-manifest.ts` (final entries)
- **Acceptance**: one flow exercises catalog profile (`tools/list` small, hydrate, call hidden tool), `list_skills`/`skills_attach` on the real repo `skills/`, scoped focus + intention + handoff on a temp vault; full suite green.
- **Depends on**: Tasks 1-11
