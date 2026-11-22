# Tasks: the dream work queue

Work in order, one section at a time. Before a section, read its part of
`design.md` and the spec requirement it names. Tick each box (`- [x]`) as
soon as it is done, so an interrupted run can resume from the first open
box. Partial edits from an earlier attempt may already be in the tree:
review them, keep what is right, finish the rest.

For every behaviour: write the failing test first, run it and see it
fail, then write the code.

## Environment and rules

1. Work only in this checkout. Never read or write the real user state: not the real machine config, not a real vault, not the real state directories, not any real agent host configuration. Tests build a store in a temp directory with the existing store fixtures.
2. Your own temporary data goes under one directory you create with `mktemp -d` and remove at the end by its exact path. Never remove anything by a wildcard.
3. English only, no exclamation marks, the product name written "Open Second Brain" in full. No version bump: by the owner's release plan the changes before version 2.0 merge without a release, with their entries under `## [Unreleased]`; this overrides the bump rule of `CLAUDE.md` for this pull request.
4. No test-only seams in production code. Fixture operations are registered through the public registry call and removed in `finally`. A spy forwards every argument and is restored in `finally`; never `mock.module` a shared builtin.
5. Search before reading: `zg "<meaning>"` or `zg --rg -F "<text>"`.
6. Do not commit, do not push, do not open or comment on pull requests, no subagents. The orchestrator commits.
7. If a baseline or a fact the design states does not match what you find, stop that section and report it; do not work around it.
8. During a section run the test files you touched and their neighbours. The wider run is in the gate section.

## 0. Preconditions

- [x] 0.1 Read `CLAUDE.md`, then `proposal.md`, the spec delta, `design.md` and `review.md` of this change, and `design.md` of `openspec/changes/agent-neutral-dream` (the owner gate, the pass lock, the owner revision). Confirm that change is in this branch (`assertDreamOwner`, `DreamNotOwnerError`, the `o2b dream owner` verb and the `brain_dream_owner` tool exist); if not, stop: nothing of this change can be built before it.
- [x] 0.2 Confirm the tree is clean. Run `bun test tests/core/brain.dream.rollup.test.ts tests/core/view tests/core/store --timeout 30000` and note the counts. A red baseline is reported, not built on.

## 1. Records and the fold (spec: "Work that needs a model is a durable item", "One live lease per item", "Accepted is not finished")

- [x] 1.1 Tests first, `tests/core/brain/dream-queue/fold.test.ts`, on hand-built records: each of the six states; a duplicate item id; the newest generation wins and an answer for an older one is rejected and listed; an expired lease at a later `now`; five failed attempts park and a retry record unparks with the count from zero; a lease by a device that is not the owner at that place in the order is rejected (the fold is given the owner records too); an applied record without its answer is rejected; the same records in any input order fold to the same result.
- [x] 1.2 `src/core/brain/dream-queue/constants.ts`, `records.ts` (kinds, body validators, the id function), `fold.ts` (design D1). The stream `dream-work` in `STORE_STREAMS` (`src/core/store/constants.ts`); check every reader of that list named in design Context 6 and say in the report what each now does with the stream. A section "Dream work" in `src/core/store/FORMAT.md` with every kind, following that document's own rule on whether an added stream needs a newer format version; `tests/core/store/format-doc.test.ts` must pass.

## 2. Readiness and order (spec: "Ordered work stays in order and unrelated work proceeds")

- [x] 2.1 Tests first, `tests/core/brain/dream-queue/order.test.ts`: predecessors; a shared resource behind a parked head; unrelated work offered; order by occurrence then fold place; a closed predecessor under both declared rules (the `cancel` rule is proven through the settle step of section 3, here only that the fold marks the dependant); a successor following a superseded id.
- [x] 2.2 Readiness in the fold (design D2).

## 3. Operations and the core functions (spec: "An answer is accepted only against the current input", "Failed work is retried...", "An item that lost its subject is closed")

- [x] 3.1 `tests/helpers/dream-queue-fixtures.ts`: a closed-answer fixture operation and a text fixture operation over records of a temp store, with a controllable `currentInput` and an idempotent `apply`.
- [x] 3.2 Tests first, `tests/core/brain/dream-queue/queue.test.ts`: produce twice gives one item; an item produced by one process is found waiting by a second, fresh process (the crash after producing); on a brain with no store and on a machine that has not switched, the pass calls nothing of the queue and its outcome is what it was; take on a device that is not the owner throws the dream owner error and writes nothing; two takes give different items; a take while the lock is held returns nothing with the reason `busy` after the budget (use a short budget passed in, not a sleep of 30 seconds); settle writes the closed record of a dependant under the `cancel` rule and the released attempt of an expired lease, once; take skips an item before its retry time and one whose operation is unknown; an answer under a replaced generation is refused; an answer outside the schema records a failed attempt with backoff; the same answer twice returns the first receipt and writes once; a changed input supersedes and the successor is offered; a missing subject cancels; accepted then a simulated crash then `applyAccepted` applies once; `apply` run twice writes its effects once; release; retry and cancel with human authority; no entry point takes the lock twice (a test that runs each entry point against a lock spy and counts one acquisition).
- [x] 3.3 A concurrency test with two real processes taking from one store on one device (the helper used by the existing lock tests): no item is leased twice.
- [x] 3.4 The owner moved: with the two-device fixture of the dream owner tests, produce and lease on the first device, transfer the owner, and show that the second device folds the same states, refuses nothing it should accept, treats the old lease by its generation and takes the item after expiry.
- [x] 3.5 `operations.ts` and `queue.ts` (design D3, D4, D6).

## 4. Partitions (spec: "Private evidence stays in the private partition")

- [x] 4.1 Tests first: an item built from a private record is written to `private` with all its later records; a device that never held the private partition shows nothing of it and never takes it; a device whose held-partition ledger shows the partition lost says private work is unknown.
- [x] 4.2 The partition choice and the status wording (design D5).

## 5. The rollup producer (spec: "The rollup ladder's model step is queued")

- [x] 5.1 Tests first: the salience gate returns the admitted ids and its existing tests pass; a live pass that fires the fact rung produces one item whose evidence is the admitted ids no earlier item of the rung holds; the next firing's item holds only the new ids; more than the bound leaves the rest for the next firing and says so; the identity rung's item names the fact rung's items as evidence and the unfinished ones in `after`; a second pass over the same state adds none; a dry run, the staged `stage` and `validate`, and each preview caller produce nothing; the pass summary shows the rung as before and the `model_work` counts; every existing test of `tests/core/brain.dream.rollup.test.ts` passes unchanged.
- [x] 5.2 The salience gate returns the admitted ids (`src/core/brain/salience-gate.ts`); the ladder is not changed. The pass calls `produceWork` in the executing branch beside the audit log write, and `applyAccepted` at the top of `dreamRun` for a live pass only (design D4, D7). The operation `rollup-summary` is registered with a real schema and `currentInput` and an `apply` that refuses.

## 6. Surfaces (spec: "The queue is visible")

- [x] 6.1 Tests first: each doctor code of design D8 on a built queue; the owner status section; the verb's listing, JSON output, retry and cancel, and the refusal of retry and cancel off the owner's device.
- [x] 6.2 `queueStatus`; the doctor check under `src/core/brain/doctor/`, registered in `DOCTOR_CHECKS` and `STORE_SIDE_CHECKS`, with each code placed in `DIAGNOSTIC_SIGNALS` or `DOCTOR_EXIT_EXCLUSIONS` (`tests/core/brain/doctor-exit-census.test.ts` must pass); the status section in the dream owner verb and tool; the verb under `src/cli/brain/verbs/`; child entries under `dream` in `src/cli/command-manifest.ts` (`tests/cli/manifest-completeness.test.ts`, the help parity and completion tests must pass); `docs/cli-reference.md`.

## 7. Docs

- [x] 7.1 `CHANGELOG.md` under `## [Unreleased]`. `docs/brain-store.md`: a short section on the queue and what waiting means before an executor exists.

## 8. The gate

- [x] 8.1 Run each on its own and fix what fails: `bun run test`, `bunx tsc --noEmit -p .`, `bun run lint`, `bun run fmt:check`, `bun run check:paths`, `bun run sync-plugin-mirrors:check`, `bun run scripts/sync-version.ts --check`.
- [x] 8.2 If the OpenClaw bundle includes changed code, rebuild it with `bunx bun@1.4.4 run build:openclaw` and say so.
- [x] 8.3 Measure the fold and one take on ten thousand generated items and put the times in the report; the take must fit well inside the lock budget.
- [x] 8.4 Windows shards: the new test files are not in `.github/windows-test-timings.json`. Say in the report which of them run longer than a few seconds, so the orchestrator folds the first CI run's timings into that file (`CLAUDE.md`, "Windows test shards"). Keep the two-process test in a file of its own.

## 9. Report

- [x] 9.1 Report: per section what was built (files), the tests added with real counts, the fold measurement, every place the design was not followed and why, and what is left open.

## Workflow follow-up

- Independent code review rounds, then archive the change inside its pull request.
