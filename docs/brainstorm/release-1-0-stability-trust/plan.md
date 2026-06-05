# Release 1.0.0 - Stability & Trust - implementation plan

One feature branch (`feat/release-1-0-stability-trust`), one task per atomic commit, TDD throughout: failing test first, implement, refactor green, `bun run fmt` + `bun run lint` before every commit.

## Tasks

### Task 1: Tombstones + alias sweep (MCP surface)
- **Files**: `src/mcp/tools.ts` (REMOVED_TOOLS map + lookup, delete `deprecatedAlias`), `src/mcp/server.ts` (tombstone dispatch on tools/call), `src/mcp/brain-tools.ts` (remove the 10 brain alias registrations), `src/mcp/schema-tools.ts` (remove the 8 schema alias registrations), `tests/mcp/mcp.test.ts` (listed count stays 77; hidden surface gone), new `tests/mcp/removed-tools.test.ts`.
- **Acceptance**: calling each of the 18 removed names via tools/call returns INVALID_PARAMS naming the replacement tool and view; `tools/list` length stays 77; no tool carries `hidden: true` in the full scope; no `deprecatedAlias` symbol remains.
- **Depends on**: none.

### Task 2: Alias-reference cleanup across tests, skills, and docs
- **Files**: every test/skill/doc file that invokes one of the 18 removed names (grep-driven), `skills/` shipped surfaces if any reference them.
- **Acceptance**: repo-wide grep for the 18 names finds only tombstone map, upgrade guide, CHANGELOG, and historical brainstorm docs; full MCP test suite green.
- **Depends on**: Task 1.

### Task 3: Doctor check for removed-surface references
- **Files**: `src/core/brain/doctor.ts`, `tests/core/brain/doctor-removed-tools.test.ts`.
- **Acceptance**: a vault note or installed skill file containing any of the 18 removed tool names yields a doctor warning naming the replacement; clean vault yields none.
- **Depends on**: Task 1.

### Task 4: Safeguard core
- **Files**: new `src/core/brain/safeguard.ts`, `src/core/config.ts` (flat key + env resolution), `tests/core/brain/safeguard.test.ts`.
- **Acceptance**: createSafeguard deadline fires SafeguardTimeoutError at checkpoint() past the deadline; resolution order per-op key -> global key -> built-in default; `0` disables; output-cap helper truncates with explicit marker.
- **Depends on**: none.

### Task 5: Safeguard wiring into long-running operations
- **Files**: `src/core/brain/dream.ts`, `src/core/search/indexer.ts`, `src/core/brain/link-graph/bridge-discovery.ts`, `src/core/brain/link-graph/communities.ts`, `src/cli/brain/verbs/maintenance.ts` (+ verbs dream/reindex surfaces), `src/mcp/brain-tools.ts` (maintenance tool), lane metric payload `timed_out`, tests per wired operation.
- **Acceptance**: each wired operation aborts cleanly at a boundary under a 1ms-deadline test and reports `timed_out: true` (exit 1 JSON contract for CLI); maintenance lane caps per-task output with truncated marker; default config changes nothing (suite green untouched).
- **Depends on**: Task 4.

### Task 6: Dream plan capture + stage bundle writer
- **Files**: new `src/core/brain/dream-stage.ts` (stageDream, bundle layout `Brain/dream/staged/<run-id>/` with manifest.json / REPORT.md / sources.jsonl / proposals.jsonl, input fingerprint, clock-normalized plan projection), `src/core/brain/dream.ts` (export the dry-run plan in a comparable shape if not already), `tests/core/brain/dream-stage.test.ts`.
- **Acceptance**: stageDream on a seeded vault persists a complete bundle; the proposals projection is stable across two stage runs on an unchanged vault (normalized: no run ids/timestamps in the equality surface).
- **Depends on**: none (parallel to safeguard).

### Task 7: Validate / apply / discard / list lifecycle
- **Files**: `src/core/brain/dream-stage.ts` (validateDreamBundle recompute-compare, applyDreamBundle re-validate + live `dream()`, discard, list), `tests/core/brain/dream-stage-lifecycle.test.ts`.
- **Acceptance**: validate passes on unchanged vault and fails with a drift report after a new signal lands; apply on a valid bundle performs exactly the staged promotions (live summary matches plan) and records a `dream_stage` metric; apply on a drifted bundle aborts without writes; discard removes the bundle.
- **Depends on**: Task 6.

### Task 8: Staged dream CLI + MCP surface
- **Files**: dream CLI verb (stage/validate/apply/discard/list actions), `src/cli/command-manifest.ts`, `src/cli/brain/help-text.ts`, `src/mcp/brain-tools.ts` (brain_dream optional `action` param, INVALID_PARAMS first), `docs/metrics.md` (dream_stage surface row), `tests/cli/brain-dream-stage.test.ts`, `tests/mcp/` coverage.
- **Acceptance**: full stage -> validate -> apply cycle via CLI and via MCP brain_dream action param; usage errors exit 2; tool count stays 68.
- **Depends on**: Task 7.

### Task 9: Timezone presentation helper
- **Files**: new `src/core/brain/present-time.ts` (formatLocalTimestamp via Intl.DateTimeFormat, invalid-zone fail-soft to UTC), `tests/core/brain/present-time.test.ts` pinned to UTC / Europe/Berlin / America/New_York including a DST boundary.
- **Acceptance**: canonical UTC input renders `YYYY-MM-DDTHH:MM:SS+HH:MM` in the target zone; invalid zone returns UTC rendering; helper is pure and deterministic for fixed inputs.
- **Depends on**: none.

### Task 10: Timezone wiring across user/LLM-facing surfaces
- **Files**: brief/digest/timeline/analytics CLI verbs and MCP tools (additive `*_local` fields + `timezone` echo when configured; human output renders local), `tests/cli/` + `tests/mcp/` coverage proving byte-identical output when timezone is unset.
- **Acceptance**: with `timezone: Europe/Berlin` configured, brief output carries local renderings; with no timezone, output is byte-identical to pre-change snapshots.
- **Depends on**: Task 9.

### Task 11: Report snapshot + diff engine
- **Files**: new `src/core/brain/report-snapshot.ts` (persist `Brain/reports/<surface>/<date>.json` schema `o2b.report-snapshot.v1`, load-latest fail-soft, deterministic keyed diff), `src/core/config.ts` (`report_snapshots_enabled` + env), `tests/core/brain/report-snapshot.test.ts`.
- **Acceptance**: two snapshots diff into added/removed/changed keyed by stable identities regardless of array order; torn prior snapshot reads as none; disabled flag writes nothing.
- **Depends on**: none.

### Task 12: Dual-output wiring into digest, daily brief, weekly synthesis
- **Files**: digest/brief surfaces (persist snapshot when enabled, append "Since last run" block + `delta` field on subsequent runs), corresponding CLI/MCP tests, `docs/metrics.md` if a metric is recorded.
- **Acceptance**: first enabled run persists a snapshot and reports no delta; second run after a vault change reports the precise delta in both human and JSON output; disabled vault output byte-identical.
- **Depends on**: Task 11.

### Task 13: Stability policy + upgrade guide
- **Files**: new `docs/stability.md` (frozen contracts: MCP tool surface, CLI verb tree, config keys + env vars, search schema ladder, on-disk format schemas; breaking-change definitions per class), `docs/updating.md` (0.x -> 1.0.0 section with the full 9-row alias -> replacement table), README pointer.
- **Acceptance**: every removed alias has a documented replacement; policy enumerates every schema string shipped (`o2b.metrics.v1`, `o2b.tuning.v1`, `o2b.dream-stage.v1`, `o2b.report-snapshot.v1`, continuity records, search schema v7).
- **Depends on**: Tasks 1, 8, 11 (schema names final).

### Task 14: Integration test - the 1.0 composition
- **Files**: `tests/e2e/release-1-0-stability.integration.test.ts`.
- **Acceptance**: one flow exercises tombstone error -> staged dream full cycle -> timezone-rendered brief -> snapshot delta on second digest run -> safeguard abort under a tiny deadline, all on one temp vault.
- **Depends on**: Tasks 1-12.

Docs phase (playbook phase 5) additionally updates `README.md`, `CHANGELOG.md` (single `[1.0.0]` entry), `docs/cli-reference.md`, `docs/mcp.md`, `docs/how-it-works.md`. Version bump to 1.0.0 happens at phase 9 via `bun run sync-version`.

## Implementation deviations

(recorded during implementation)
