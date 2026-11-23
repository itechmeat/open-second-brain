# Tasks: the dream replay

Work in order, one section at a time. Before a section, read its part of
`design.md` and the spec requirement it names. Tick each box (`- [x]`) as
soon as it is done, so an interrupted run can resume from the first open
box. Partial edits from an earlier attempt may already be in the tree:
review them, keep what is right, finish the rest.

For every behaviour: write the failing test first, run it and see it
fail, then write the code.

## Environment and rules

1. Work only in this checkout. Never read or write the real user state: not the real machine config, not a real vault, not the real state directories, not any real agent host configuration. Tests build stores and vaults in temp directories.
2. Your own temporary data goes under one directory you create with `mktemp -d` and remove at the end by its exact path. Never remove anything by a wildcard.
3. English only, no exclamation marks, the product name written "Open Second Brain" in full. No version bump: by the owner's release plan the changes before version 2.0 merge without a release, with their entries under `## [Unreleased]`; this overrides the bump rule of `CLAUDE.md` for this pull request.
4. No test-only seams in production code. A spy forwards every argument and is restored in `finally`; never `mock.module` a shared builtin. Time is injected through the pass's existing `now` option, never by patching the clock.
5. Search before reading: `zg "<meaning>"` or `zg --rg -F "<text>"`.
6. Do not commit, do not push, do not open or comment on pull requests, no subagents. The orchestrator commits.
7. If a baseline or a fact the design states does not match what you find, stop that section and report it; do not work around it.
8. The existing dream tests are the proof that a daily pass did not change. Do not edit an existing test to make it pass unless the section names it; report every existing test you had to change and why.

## 0. Preconditions

- [x] 0.1 Read `CLAUDE.md`, then this change's `brainstorm.md`, `inventory.md`, `proposal.md`, both spec deltas, `design.md` and `review.md`, and the designs of `agent-neutral-dream`, `dream-work-queue` and `dream-window-context`. Confirm all three are in this branch (`assertDreamOwner`, `produceWork`, the window context and `tests/helpers/dream-history.ts`); if not, stop.
- [x] 0.2 Confirm the tree is clean. Run the dream tests (`tests/core/brain.dream*.test.ts`, `tests/core/brain/dream*.test.ts`, `tests/core/brain/signal-archive*.test.ts`) and note the counts as the baseline. A red baseline is reported, not built on.
- [x] 0.3 List every reader of the two ledger files and every caller of `readStoreEntities`, `readStoreLogEvents` and `logDayReader` inside the pass. Put the list in the report; it is the checklist of sections 2 and 4.

## 1. The equivalence scenarios (spec: "The reference is daily runs over the same admission history", "Missed days are replayed oldest first", "A person's changes apply from the first replayed window")

- [x] 1.1 The comparison is against admission as the spec defines it, not against real arrival times, which the store does not keep. A history for the comparison has a covered day C (the daily machine ran through C), a replay day R, and for every record an event day E and whether it reaches the machine before or after C. The admission day is: E for a record with E after C (whenever it arrived inside the gap); E for a record that arrived on time before C; C+1 for a record with E at or before C that arrives during the gap (late). The daily driver makes each record visible on its admission day; the replay driver hands everything to one pass on R. Do not try to model arbitrary arrival days inside the gap: they are not representable and not required. Extend `tests/helpers/dream-history.ts` (from `dream-window-context`) with the replay driver: one replay over a history with its admission schedule, and the comparison with the daily driver that ignores run ids and run times and names the first difference.
- [x] 1.2 `tests/core/brain/dream-replay/equivalence-*.test.ts`, several files sharing the helper: seeds, and the named scenarios: evidence that would have been archived before its promotion (three signals, three weeks of silence); a deadline inside the gap; two clusters and one daily slot; a signal expiring in the gap; chain decay; a minimum age reached on a day with no input; a late signal after two were archived; a signal first seen older than the window (counted, and not archived by that window); a clock ahead; a rule retired by hand during the gap; evidence dated before a deadline that arrives after the retirement (a reconciliation entry on both sides, the rule stays retired); gaps of one, thirty and zero days. They fail now for every scenario with a gap; record which and why in the report. They go green in section 5.

## 2. Reading from positions (spec: "Unknown input stops coverage", "A replaced shard is rebased and the loss is reported")

- [x] 2.1 Tests first, in `tests/core/store/`: `readShardsFrom` returns only records after a position and the new offset; a torn tail is held back and is not a gap; a pending blob and a corrupt line are gaps and keep the position; a stored prefix digest that matches passes, one that does not is reported; a shard named in a hand-built `compacted` record is reported as replaced; `readStreamRecords` with `until` returns nothing beyond the limit; `readStoreEntities` and `readStoreLogEvents` with and without `until` do not share a cache entry; every existing test of these readers passes unchanged.
- [x] 2.2 `readShardsFrom`, the exported prefix hash helper, the `until` option and its pass-through (design D3, "The read path this needs").

## 3. Admission and the inputs of a window (spec: "A late record counts from its admission and reopens nothing")

- [x] 3.0 `tests/helpers/dream-replay-fixtures.ts`: seeds a store with hand-built admission, plan and coverage records, so sections 3 to 5 can be tested before the bootstrap of section 6 exists.
- [x] 3.1 Tests first, `tests/core/brain/dream-replay/admission.test.ts`: the admission record is written before any effect (a failing effect leaves it in place); a late record gets the window's day and keeps it across a restart; a record dated ahead is clamped; a record first read while an early window was admitted and dated later is an input of the window of its day; a gap stops the pass at that window with no plan written, and the next pass admits from the same positions; a gap that has lasted three days is left out, reported, and its records are admitted as late once readable; a rebase takes covered-day records as seen, counts them, and the count is in the admission record and in the window's audit events; only signal creation records and evidence (log events and `preference-evidence` records) are filtered by time, a window's counters come from the filtered evidence and not from the fold's totals, and a preference update or a signal state record below the boundary is visible to every window; `dream-scan.ts` and `scanApplyEvidence` see nothing beyond the boundary and nothing after the instant.
- [x] 3.2 `src/core/brain/dream-replay/positions.ts`, `admission.ts`, the stream `dream-replay` in `STORE_STREAMS` with its section in `FORMAT.md` (`tests/core/store/format-doc.test.ts` must pass), the boundary and effective times in `dream-scan.ts` and `dream-refresh.ts` (design D3).

## 4. Ledgers in the store (spec: "Coverage belongs to the brain")

- [x] 4.1 Tests first: the folds of the two ledger kinds keep one record per effect id; the cross-topic allowance is judged against the window's day; the one-time import of this device's files; no reader of the files is left.
- [x] 4.2 The records, the folds, the import, the removal of the file readers (design D4.5).

## 5. Plans, effects and the loop (spec: "A window is finished once, whatever interrupts it", "A budget stops a pass without losing work", "Timely evidence that arrives after a retirement is recorded", "A staged pass waits for the replay")

- [x] 5.1 Tests first, `tests/core/brain/dream-replay/commit.test.ts`: a kill after each step of design D5 (admission, plan, each of several effects, audit) followed by a new pass ends in the same records as an uninterrupted run, with one set of audit events; a new preference applied twice from the plan is one preference (the idempotency key path); the crash between a cross-topic promotion and its ledger record spends the allowance once; the budget spent between effects resumes the same plan, and the budget spent between windows ends the pass with the next window untouched; a resumed window's audit events are the ones an uninterrupted run writes (built from the plan, every kind `writeDreamLog` writes today, the suppressed signal and the retain-pinned retirement included), none twice; a resumed window reuses its rollup target paths; a pass whose windows plan nothing takes no snapshot.
- [x] 5.2 The plan record with frozen payloads, effect ids as idempotency keys, the audit events built from the plan with `window` and `effect` and the writer appending only the missing ones, the coverage record and the fold of the stream (design D4, D5).
- [x] 5.3 The loop in `dreamRun`, one context per window, what runs once after the loop, the snapshot rule, the budget setting with its documentation (design D1, D2, D6). Heal enrichment lifted out of `applyDreamPlan` to run once after the loop, with a test that it still runs exactly once per pass. The reconciliation entry (design D5a) in the plan, the audit events and the digest, with the deadline from the retiring window's plan, from the record history for a rule retired earlier, and the not-checkable count when neither has it.
- [x] 5.4 The staged flow: tests first for the refusal of stage, validate, apply and retriage while windows are behind, through the verb and through the MCP tool, and for the unchanged flow with coverage at yesterday; then the change in `dream-stage.ts`.
- [x] 5.5 Every equivalence file of section 1 passes.

## 6. Bootstrap (spec: "An existing brain starts from its retained history", "A brain that is not on the store is never reported as covered")

- [x] 6.1 Tests first: a backlog in the inbox replays from its oldest signal and archives nothing before its window; an empty inbox starts at the day after the last pass that changed something; a brain that never ran starts today; an interrupted inventory continues from its page; the unrecoverable count; the first live pass after a switch to the store is the inventory, and a legacy pass is never shown as covered.
- [x] 6.2 `bootstrap.ts` (design D7, D9).

## 7. Transfer (spec: "Coverage belongs to the brain", the `dream-ownership` delta)

- [x] 7.1 Tests first, with the two-device fixture of the dream owner tests: a release carries the covered day; the new owner holding the release and not the coverage ends with `waiting-for-sync` and runs no window; once synced it starts at the next window, repeats no rollup and spends no allowance twice; a forced takeover continues from what it holds and says what may be missing; coverage from the old owner arriving later is folded to the highest day without a second effect.
- [x] 7.2 The `covered` field of the release, the wait, the forced path (design D8).

## 8. Surfaces (spec: "The status tells three things apart")

- [x] 8.1 Tests first, then: the status section, the doctor codes with their registration (`DOCTOR_CHECKS`, `STORE_SIDE_CHECKS`) and their place for the exit census (`DIAGNOSTIC_SIGNALS` or `DOCTOR_EXIT_EXCLUSIONS`), `inbox-archivable` through `scanInboxForArchive` against the next window, the digest interval, the summary fields, `docs/cli-reference.md` (design D10).

## 9. Docs

- [x] 9.1 `CHANGELOG.md` under `## [Unreleased]`. `docs/how-it-works.md`: the section on the pass, rewritten for windows. `docs/brain-store.md`: the new records.

## 10. The gate

- [x] 10.1 Run each on its own and fix what fails: `bun run test`, `bunx tsc --noEmit -p .`, `bun run lint`, `bun run fmt:check`, `bun run check:paths`, `bun run sync-plugin-mirrors:check`, `bun run scripts/sync-version.ts --check`.
- [x] 10.2 If the OpenClaw bundle includes changed code, rebuild it with `bunx bun@1.4.4 run build:openclaw` and say so.
- [x] 10.3 Measure on a generated brain of realistic size (state the size): a daily pass before and after this change, a replay of 30 days and of 180 days (time, passes needed under the default budget, size of the plan records).
- [x] 10.4 Windows shards: name the new test files that run longer than a few seconds, so the orchestrator folds the first CI run's timings into `.github/windows-test-timings.json`. The equivalence table is already several files.

## 11. Report

- [x] 11.1 Report: per section what was built (files), the tests added with real counts, every existing test changed and why, the measurements of 10.3, every place the design was not followed and why, and what is left open.

## Workflow follow-up

- Independent code review rounds, then archive the change inside its pull request.
