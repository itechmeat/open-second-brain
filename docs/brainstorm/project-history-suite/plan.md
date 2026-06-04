# Project History Suite - implementation plan

One PR, atomic per-task commits on `feat/project-history-suite`. Formatter + linter green before every commit. TDD: each task starts with failing tests.

## Tasks

### Task 1: Git kernel - repo identity and sanitized reader
- **Files**: `src/core/brain/git/identity.ts` (repo key derivation), `src/core/brain/git/reader.ts` (readCommits with NUL-separated fields + name-only files, readTags, revListRange, shaExists; execFileSync fixed-argv, fail-soft null on git errors, SHA validation helpers); `tests/core/brain/git/reader.test.ts` against real temp git repos (init/commit/tag fixtures), including adversarial commit messages and missing-git-dir fallback.
- **Acceptance**: reader returns structured commits (sha, author name/email, ISO date, subject, body, files) and tags from a fixture repo; bounded by maxCount; never modifies the repo; malformed/absent repos return null.
- **Depends on**: none

### Task 2: Git record store with watermark
- **Files**: `src/core/brain/git/store.ts` (per-repo dir `Brain/projects/git/<repo-key>/`, append commit/tag records to `commits.jsonl` with SHA dedup, `state.json` watermark read/write with 40-hex validation, list/filter API: by file, author, since/until, free-text over subject+body); `tests/core/brain/git/store.test.ts`.
- **Acceptance**: appends are idempotent by SHA; malformed watermark is rejected and reported; filters return deterministic ordered results.
- **Depends on**: Task 1 (record shapes)

### Task 3: Ingest orchestration, release attribution, digest note, CLI `o2b brain git`
- **Files**: `src/core/brain/git/ingest.ts` (full + incremental ingest, watermark advance, tag-range release attribution via revListRange, force-push fallback to full re-scan), `src/core/brain/git/digest.ts` (digest.md renderer: repo header, releases, recent commits, hot files - rendered from records only; wikilinks appear solely for vault-resident promoted notes such as ADR candidates, repo file paths stay plain text); `src/cli/brain/verbs/git.ts` (subcommands ingest/status/find, --json), registration in `verbs/index.ts`, `src/cli/brain.ts`, `help-text.ts`, `command-manifest.ts`; `tests/core/brain/git/ingest.test.ts`, `tests/cli/brain-git.test.ts`.
- **Acceptance**: initial ingest + incremental ingest (no duplicates) + release edges on a fixture repo with tags; `git find --file <f>` answers "when/why did this file change"; digest note discoverable by search after reindex; status shows watermark.
- **Depends on**: Tasks 1, 2

### Task 4: Region merge engine
- **Files**: `src/core/brain/regions.ts` (parseRegions, mergeRegions: replace generated bodies by region id, preserve non-region text byte-for-byte, append new regions, fail-closed domain error on unbalanced/duplicate sentinels); `tests/core/brain/regions.test.ts`.
- **Acceptance**: regeneration over an operator-edited file changes only generated regions; corrupted markers abort without writing; idempotent merge produces zero diff.
- **Depends on**: none

### Task 5: Architecture docs generator + CLI `o2b brain architect`
- **Files**: `src/core/brain/architect/scan.ts` (deterministic project facts: modules from src/packages/flat layouts, language mix by extension, entry points from manifests, test layout, file counts), `src/core/brain/architect/generate.ts` (overview + per-module notes under `Brain/projects/arch/<repo-key>/` through the region engine), `src/cli/brain/verbs/architect.ts` + 4 registration points; `tests/core/brain/architect.test.ts`, `tests/cli/brain-architect.test.ts`.
- **Acceptance**: first run creates overview + module notes; re-run after operator edits preserves user text; module add/remove reflected on regen; unchanged project regen is byte-identical.
- **Depends on**: Task 4

### Task 6: Commit-decision miner + CLI `o2b brain git mine`
- **Files**: `src/core/brain/git/decisions.ts` (deterministic signal matchers + candidate note renderer to `Brain/decisions/candidates/adr-<shortsha>-<slug>.md`, skip-existing semantics), `mine` subcommand in `src/cli/brain/verbs/git.ts`; `tests/core/brain/git/decisions.test.ts`, CLI case in `tests/cli/brain-git.test.ts`.
- **Acceptance**: decision-shaped fixtures produce candidates with matched-signal provenance; non-decision commits produce nothing; re-run duplicates nothing and preserves operator-edited candidates (skip-existing, no region merge - orchestrator decision 3); empty history is a clean no-op.
- **Depends on**: Tasks 2, 3 (records)

### Task 7: brain_query telemetry
- **Files**: `src/core/brain/recall-telemetry.ts` (mode union + `isRecallTelemetryMode`), `src/mcp/brain-tools.ts` (brain_query input schema: telemetry/telemetry_host/session_id/turn_id; handler wiring through emitGatedTelemetry on success and error paths, kind-only payload); `tests/mcp/brain-query-telemetry.test.ts` (no-consumer regression + gated emission + no-raw-values assertion against persisted continuity files).
- **Acceptance**: telemetry off (default) writes zero continuity records and never runs the payload thunk; on, one record with mode "query", correct status/duration/result_count; persisted files never contain the supplied preference/topic/since values.
- **Depends on**: none

### Task 8: End-to-end integration test
- **Files**: `tests/e2e/project-history.integration.test.ts` (temp git repo + temp vault: ingest → find → mine → architect → re-run idempotency in one flow).
- **Acceptance**: full flow green in one process; re-runs of all three generators produce no duplicates and no clobbered edits.
- **Depends on**: Tasks 1-6

### Task 9: Docs
- **Files**: `README.md`, `CHANGELOG.md` (one new version), `docs/cli-reference.md`, `docs/how-it-works.md`, `docs/observability.md` (telemetry mode list + brain_query row).
- **Acceptance**: docs match shipped behavior; CHANGELOG bullets per feature.
- **Depends on**: Tasks 1-8
