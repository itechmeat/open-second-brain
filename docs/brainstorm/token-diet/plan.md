# Token diet - implementation plan

Order: shared seams first (they unblock everything), then the P4 bugfix, then the remaining slices by priority. Each task is one TDD loop ending in one conventional commit; formatter + linter run before every commit.

## Tasks

### Task 1: text-budget core
- **Files**: `src/core/brain/text/text-budget.ts` (new), `tests/core/brain/text-budget.test.ts` (new)
- **Acceptance**: pure function takes ordered sections `{key, text, priority}` plus a char budget and returns the included sections + a `truncated` flag; deterministic (same input -> same output), never cuts mid-line, drops lowest-priority sections first, zero budget returns the marker line only. Property test: output length <= budget for all fixture inputs.
- **Depends on**: none

### Task 2: context-events allowlist + PostCompact fix (t_a1602738)
- **Files**: `hooks/lib/context-events.ts` (new), `hooks/active-inject.ts`, `hooks/hooks.json`, extend `tests/hooks/active-inject.test.ts` + `tests/hooks/hooks-json-shape.test.ts`
- **Acceptance**: active-inject emits `hookSpecificOutput.additionalContext` only for event names in the allowlist (`SessionStart`, `UserPromptSubmit`); for `PostCompact` (and unknown names) it exits 0 with empty stdout; `hooks.json` SessionStart matcher becomes `startup|resume|clear|compact`; contract test pins the allowlist and the silent-no-op behavior.
- **Depends on**: none

### Task 3: Most-applied one-liners + principle sanitization + one-shot migration (t_40eb1de7, part 1)
- **Files**: `src/core/brain/active.ts`, `src/core/brain/signal.ts`, `src/core/brain/preference.ts`, `src/core/brain/doctor.ts`, `src/core/brain/upgrade.ts`, fixture tests
- **Acceptance**: Most-applied section renders `- \`pref-id\` (scope, applied_in_window: N)` with no principle text; principle text persisted via signal/preference writers strips leaked tool-call XML fragments and collapses repeated backslash-quote escaping (fixtures copied from the real corrupted files); doctor flags remaining artifacts; `planUpgrade`/`applyUpgrade` rewrites them once and is idempotent; regenerateActive stays idempotent (byte-stable across two runs).
- **Depends on**: none

### Task 4: active.md injection budget (t_40eb1de7, part 2)
- **Files**: `hooks/active-inject.ts`, `src/core/brain/active.ts` or a small adapter, `src/core/brain/policy.ts` (config key `active.inject_budget_chars`), tests
- **Acceptance**: injected body is budgeted through the text-budget core (default 8,000 chars), truncation order retired -> quarantine -> most-applied -> confirmed tail, pointer line to `brain_context` appended when truncated; config override honored; live-vault-shaped fixture shrinks >= 35% vs the unslimmed baseline.
- **Depends on**: Task 1, Task 3

### Task 5: post-write-reminder cadence (t_9cc4f400)
- **Files**: `hooks/post-write-reminder.ts`, `hooks/lib/messages.ts`, session-marker helper, extend `tests/hooks/post-write-reminder.test.ts`
- **Acceptance**: first successful artifact write in a Claude Code session emits the full reminder; later writes in the same session emit a <= 200-char nudge; missing session_id or marker IO failure falls back to full text; Codex runtime always gets the full one-shot text; marker files live under the vault state dir and never throw.
- **Depends on**: none

### Task 6: consolidated tools - brain_brief, brain_analytics, schema_inspect + aliases (t_3920db77)
- **Files**: `src/mcp/brain-tools.ts`, `src/mcp/schema-tools.ts`, `src/mcp/tools.ts`, `tests/mcp/mcp.test.ts`, per-tool tests
- **Acceptance**: three new tools dispatch by `view` to the exact existing handlers; per-view output is byte-identical to the predecessor tool (asserted by running both paths in tests); 18 predecessors re-register as `deprecatedAlias(...)` definitions with one-line descriptions; registry contract test updated (count + sorted names); invalid `view` raises INVALID_INPUT.
- **Depends on**: none

### Task 7: description diet + registry guard (t_352fd7f6)
- **Files**: `src/mcp/registry-guard.ts` (new), `tests/mcp/registry-guard.test.ts` (new), description edits across `src/mcp/*-tools.ts`, `src/mcp/instructions.ts`
- **Acceptance**: every tool description <= 300 chars (guard test enforces); relocated guidance lands in per-property schema descriptions or instructions; serialized full-scope registry shrinks >= 35% vs the 44,912-char baseline (asserted informationally by the measurement script, not hard-failed in CI).
- **Depends on**: Task 6 (descriptions of consolidated tools written once)

### Task 8: preview budget by default (t_c967abaf)
- **Files**: `src/mcp/brain-tools.ts`, `src/mcp/schema-tools.ts`, `src/mcp/registry-guard.ts`, tests
- **Acceptance**: listed verbose read tools carry `previewBudget: MCP_PREVIEW_BUDGET`; guard test requires every budget-less tool to appear in an exempt list with a reason string; at least one newly budgeted tool covered by an artifact-store roundtrip test.
- **Depends on**: Task 6, Task 7

### Task 9: measurement script
- **Files**: `scripts/measure-token-surface.ts` (new)
- **Acceptance**: prints per-tool serialized sizes, registry totals (count + chars + est. tokens) for both scopes, and active.md size for the configured vault; runs via `bun run scripts/measure-token-surface.ts`; used to produce the before/after table for the PR body.
- **Depends on**: Task 7, Task 8 (final numbers)
