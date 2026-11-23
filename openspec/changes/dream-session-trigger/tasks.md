# Tasks: the session trigger

Work in order, one section at a time. Before a section, read its part of
`design.md` and the spec requirement it names. Tick each box (`- [x]`) as
soon as it is done. Partial edits from an earlier attempt may already be
in the tree: review them, keep what is right, finish the rest.

For every behaviour: write the failing test first, run it and see it
fail, then write the code.

## Environment and rules

1. Work only in this checkout. Never read or write the real user state: not the real machine config, not a real vault, not the real state directories, not any real agent host configuration. Tests set HOME and the state roots under a temp directory before anything runs.
2. No test starts a real detached worker that outlives it: the spawn goes through the injectable seam the post-upgrade worker's tests use, and the one test that starts a real worker waits for it and removes what it made.
3. Your own temporary data goes under one directory you create with `mktemp -d` and remove at the end by its exact path. Never remove anything by a wildcard.
4. English only, no exclamation marks, the product name written "Open Second Brain" in full. No version bump: the changes before version 2.0 merge without a release, with their entries under `## [Unreleased]`.
5. No test-only seams in production code beyond the existing spawn seam. A spy forwards every argument and is restored in `finally`; never `mock.module` a shared builtin.
6. Search before reading: `zg "<meaning>"` or `zg --rg -F "<text>"`.
7. If a fact the design states does not match the code, take the smallest deviation that keeps the spec's requirements and list it in the report; stop only when a requirement itself cannot be met.

## 0. Preconditions

- [x] 0.1 Read `CLAUDE.md`, then this change's `brainstorm.md`, `proposal.md`, the spec delta, `design.md`, `review.md` and `inventory.md` (section "Change A"). Confirm the earlier changes are in this branch (the pass lock held while its process lives, the replay status, the queue status, the two executors); if one is missing, stop and name it.
- [x] 0.2 Confirm the tree is clean. Run `bun test tests/hooks tests/core/maintenance tests/core/brain/dream-owner --timeout 30000` and note the counts.

## 1. The record and the outcome (spec: "A day is closed only by a complete pass", "Every live pass records the day")

- [x] 1.1 Tests first: the record's path from a configured store root; an atomic write; a missing and a corrupt record read as unknown; each outcome of design D4 from a built pass result (complete, complete with unanswerable work, behind, a gap, answerable work left, a throw); the backoff table up to its cap; the day of a pass that crosses midnight; each of the three existing live entry points records the outcome on the owner's device and not elsewhere.
- [x] 1.2 `src/core/brain/dream-trigger/record.ts`, `outcome.ts`, the calls in the dream verb, the MCP dream tool and the lane task (design D1, D4).

## 2. The check (spec: "The check at session entry is nearly free on a closed day", "A due pass is started once, detached", "Automatic dream can be turned off, and needs an owner")

- [x] 2.1 Tests first, with a spy on the store open and the spawn seam: on a closed day, a future retry time, auto off and a cached non-owner the check opens no store, reads the config no further time and spawns nothing (assert zero store opens and one record read); the first check of a day folds the owner and spawns once; two checks racing in two processes spawn once (the exclusive claim); a young claim returns; an old claim whose worker does not hold the pass lock is a lost worker: it is removed, a failed attempt is recorded and nothing is spawned in that check; a spawn that throws removes the claim and records a failure; a brain with no owner is never started; a throw inside the check never reaches the caller; no check in a process with the dream session marker.
- [x] 2.2 `check.ts` (design D2), the shared setting `dream.auto` (design D5), the spawn site in the self-spawn census.
- [x] 2.3 The callers. `hooks/active-inject.ts`, on each event of its matcher, with its target resolution returning the loaded config (tests: the hook's output is unchanged when nothing is due and when a pass was started; its time ceiling tests pass; a note is carried through the runtime notices channel and is printed alone when the payload is otherwise empty; the one-cut-note test still passes). `MCPServer`, keeping its config, at initialize and in `invokeToolHandler` (tests: one check per day for a long-lived server, a check on the first call of a server that never got initialize, none on other calls).

## 3. The worker (spec: "A due pass is started once, detached")

- [x] 3.1 Tests first: `o2b dream run` runs the front door and the pass and records the outcome; with `--claim` it runs only when the claim file holds that token, takes the pass lock itself, and removes the claim after recording the outcome; with a wrong token it exits without running; refused on a device that is not the owner; `--json` is one document; one real detached run through the check on a temp brain, awaited by polling the record, leaves a closed day and a log with one attempt header.
- [x] 3.2 `src/cli/dream/run.ts`, the dispatch and manifest entries (`tests/cli/manifest-completeness.test.ts`, the help parity tests), the worker log.

## 4. Other machines, status, doctor (spec: "Other machines say one thing, once", "The state of the day is visible")

- [x] 4.1 Tests first: the line appears for a non-owner when the newest coverage record is older than three days, once per day, and not otherwise; the owner's note for a day closed with unanswerable work is shown once a day and reported by doctor; `o2b dream status` in text and JSON for a closed day, an open day with its reason and retry time, auto off, a non-owner; the four doctor codes registered and placed (`tests/core/brain/doctor-exit-census.test.ts`).
- [x] 4.2 The line (design D6), `src/cli/dream/status.ts`, the doctor check (design D7).

## 5. Docs

- [x] 5.1 `CHANGELOG.md` under `## [Unreleased]`; `docs/dream.md`: how dream starts, what closes a day, how to turn it off, what a cron job does beside it; `docs/cli-reference.md`.

## 6. The gate

- [x] 6.1 Run each on its own and fix what fails: `bun run test`, `bunx tsc --noEmit -p .`, `bun run lint`, `bun run fmt:check`, `bun run check:paths`, `bun run sync-plugin-mirrors:check`, `bun run scripts/sync-version.ts --check`, `bun run pack:check` (regenerate the manifest with `bun run scripts/pack-manifest.ts --write` for new source files).
- [x] 6.2 If the OpenClaw bundle includes changed code, rebuild it with `bunx bun@1.4.4 run build:openclaw` and say so.
- [x] 6.3 Measure the session start hook on a closed day before and after this change (median of twenty runs) and put both in the report.

## 7. Report

- [x] 7.1 Report: per section what was built (files), the tests added with real counts, the measurement, every place the design was not followed and why, and what is left open.

## Workflow follow-up

- Independent code review rounds, then archive the change inside its pull request.
