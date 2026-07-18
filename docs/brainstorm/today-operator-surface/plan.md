# Today operator surface - implementation plan

Order follows dependency flow: grammar first (shared by loops and
write-back), then the independent renderers, then the composing
dashboard, then write-back, then surfaces. Each task is one atomic
conventional commit; formatter + linter green before every commit; TDD
(failing test first) within each task.

## Tasks

### Task 1: widen the @osb marker grammar to per-kind field sets

- **Files**: `src/core/brain/inline.ts`,
  `tests/core/brain.inline.test.ts` (extend)
- **Acceptance**: `parseInlineMarker` / `parseBlockMarker` accept
  `loop` (free text, optional `id=`) and `set` (required `note=`,
  `field=`, `value=`) kinds; `loop close id=<id>` parses as a close
  token; `feedback` behavior byte-identical (all existing tests pass
  unchanged); unknown kinds still reject.
- **Depends on**: none

### Task 2: open-loops live scan and open-set computation

- **Files**: `src/core/brain/open-loops.ts`,
  `tests/core/brain/open-loops.test.ts`
- **Acceptance**: scanning a tmp vault with loop markers across
  configured note paths returns open loops with deterministic ids
  (hash of normalized text, or explicit `id=`); a close token removes
  the loop from the open set; consumed-sentinel and fence rules match
  `discoverMarkers`; loop markers are never annotated or rewritten;
  size/ignore limits honored.
- **Depends on**: Task 1

### Task 3: merged chronological activity timeline renderer

- **Files**: `src/core/brain/temporal/activity-timeline.ts`,
  `tests/core/brain/temporal/activity-timeline.test.ts`
- **Acceptance**: given a `TimelineIndex`, returns bullets merged
  chronologically across event kinds (newest first), each
  `- [<kind>] <text> · <relative age>`; window and limit options;
  deterministic under injected `now`; ordering/tie-break behavior of
  the index pinned by tests.
- **Depends on**: none

### Task 4: today dashboard builder

- **Files**: `src/core/brain/today-dashboard.ts`,
  `tests/core/brain/today-dashboard.test.ts`
- **Acceptance**: `buildTodayDashboard(vault, { now, ... })` returns a
  frozen envelope with four sections - obligations (due/overdue via
  `listObligations`), open loops (Task 2), recent activity (Task 3),
  totals - plus rendered Markdown; a section that fails to compute
  yields an explicit per-section error entry, the rest still render;
  read-only (no writes to the vault).
- **Depends on**: Tasks 2, 3

### Task 5: exact-title note resolver

- **Files**: `src/core/brain/notes/note-title-resolver.ts`,
  `tests/core/brain/note-title-resolver.test.ts`
- **Acceptance**: `[[Title]]` resolves to exactly one vault page by
  exact title match; zero or multiple matches throw a typed error
  listing candidates; path inputs delegate to `resolveNotePath`.
- **Depends on**: none

### Task 6: marker write-back engine

- **Files**: `src/core/brain/marker-writeback.ts`,
  `src/core/brain/types.ts` (new log event kind),
  `src/core/brain/policy.ts` (guardrail flag),
  `tests/core/brain/marker-writeback.test.ts`
- **Acceptance**: report mode lists pending `set` markers with resolved
  targets and validation results without writing; apply mode requires
  `marker_writeback` guardrail (off - typed refusal), applies via
  `assignNoteAttribute`, emits one `attribute-write` log event per
  applied mutation (prior value captured), annotates applied markers
  via `rewriteMarkers`; re-run applies nothing (idempotent); ambiguous
  or unresolvable targets fail that marker with a candidate-listing
  error and leave it unconsumed.
- **Depends on**: Tasks 1, 5

### Task 7: CLI verbs and MCP surface

- **Files**: `src/cli/brain/verbs/today.ts`,
  `src/cli/brain/verbs/apply-markers.ts`, `src/cli/brain.ts`,
  `src/cli/brain/helpers.ts`, `src/mcp/brain/brief-tools.ts`
  (`view=today`; write-back stays CLI-only, no new MCP tool),
  test extensions for the touched surfaces
- **Acceptance**: `o2b brain today [--json]` renders the dashboard;
  `o2b brain apply-markers [--apply] [--json]` reports/applies;
  `brain_brief view=today` returns the dashboard envelope; existing
  views untouched (their tests unchanged); help text updated.
- **Depends on**: Tasks 4, 6

### Task 8: docs, changelog, version

- **Files**: `README.md`, `CHANGELOG.md`, `package.json` + manifest
  sync, `docs/brainstorm/today-operator-surface/` final status
- **Acceptance**: README documents the dashboard, loop markers, close
  convention, and guarded write-back; CHANGELOG entry under the next
  version with link reference; `bun run scripts/sync-version.ts
  --check` green.
- **Depends on**: Tasks 1-7
