# Tasks: the closed questions on the queue

Work in order, one section at a time. Before a section, read its part of
`design.md` and the spec requirement it names. Tick each box (`- [x]`) as
soon as it is done. Partial edits from an earlier attempt may already be
in the tree: review them, keep what is right, finish the rest.

For every behaviour: write the failing test first, run it and see it
fail, then write the code.

## Environment and rules

1. Work only in this checkout. Never read or write the real user state: not the real machine config, not a real vault, not the real state directories, not any real agent host configuration. Tests build stores in temp directories. No test reaches a network: the decision model is the injected provider the existing tests use.
2. Your own temporary data goes under one directory you create with `mktemp -d` and remove at the end by its exact path. Never remove anything by a wildcard.
3. English only, no exclamation marks, the product name written "Open Second Brain" in full. No version bump: the changes before version 2.0 merge without a release, with their entries under `## [Unreleased]`; this overrides the bump rule of `CLAUDE.md` for this pull request.
4. No test-only seams in production code. A spy forwards every argument and is restored in `finally`; never `mock.module` a shared builtin.
5. Search before reading: `zg "<meaning>"` or `zg --rg -F "<text>"`.
6. If a fact the design states does not match the code, stop that section and report it.
7. Existing decide tests change in this change, by design. For each one you change, keep its scenario and change its expectation from "the deterministic outcome stands" to "the item waits and nothing is applied" (or to the unchanged outcome where a confident answer arrives); never delete a scenario. List every changed test in the report.

## 0. Preconditions

- [x] 0.1 Read `CLAUDE.md`, then this change's `brainstorm.md`, `proposal.md`, the spec delta, `design.md`, `review.md` and `inventory.md`, and the design of `dream-work-queue`. Confirm the queue is in this branch (`src/core/brain/dream-queue/queue.ts`); if not, stop.
- [x] 0.2 Confirm the tree is clean. Run `bun test tests/core/topics tests/core/decision-model tests/core/brain/dream-queue --timeout 30000` and note the counts. A red baseline is reported, not built on.

## 1. Queue additions (spec: "Every closed question is a queue item", "Modes per use keep their meaning for queue items")

- [x] 1.1 Tests first, in `tests/core/brain/dream-queue/`: `produceWorkBatch` writes every new item with one lock acquisition and one read, skips existing ones, and equals `produceWork` item by item; an operation with `appliedBy: "planning"` is skipped by `applyAccepted`; `takeWork` with an operation filter; `releaseWork` with a reason, kept by the fold with the input hash; a new entry point that marks an accepted item applied with given effect ids (used by planning), refusing an item that is not accepted.
- [x] 1.2 Those additions in `queue.ts`, `fold.ts`, `operations.ts`, `records.ts`; the "Dream work" section of `src/core/store/FORMAT.md` if a record body gains a field (`tests/core/store/format-doc.test.ts`).

## 2. The operations (spec: "An unsure answer decides nothing and is not asked again")

- [x] 2.1 Tests first, one file per family under `tests/core/topics/` (`decide-operations-route.test.ts`, `-new-same.test.ts`, `-items.test.ts`, `-history.test.ts`): `validate` accepts the shape, refuses a choice outside the options, accepts a choice with no confidence; `currentInput` is stable for the same state, changes when an option or the text changes, is null when the subject is gone or no longer eligible; the mapping between use and operation names; `milestone-done` supersedes when a new record arrives in its topic.
- [x] 2.2 `src/core/topics/decide-operations.ts` (design D3), the registration imported where the queue's status view imports its operations, `groups` and `qualifies` exported from `plan.ts`.

## 3. Producing (spec: "Every closed question is a queue item")

- [x] 3.1 Tests first, `tests/core/topics/decide-produce.test.ts`: one item per eligible subject for each operation; records older than eight weeks get items; order is oldest first; a second run produces none; a new question version produces new items; the eligibility thresholds still hold a group back; payloads of private subjects hold the real text and sit in the private partition; production stops at the deadline, says how many are left, and the next run continues.
- [x] 3.2 `src/core/topics/decide-produce.ts` (design D3).

## 4. The executor (spec: "The decision model chain answers queue items", "Modes per use keep their meaning for queue items")

- [x] 4.1 Tests first, `tests/core/brain/dream-queue/decision-executor.test.ts`, with the injected provider: enforce answers and the item is accepted with the provider and the model; one request per item; shadow releases with its reason, leaves the item waiting, and is not asked again for the same input; off leaves the items untouched; not configured takes nothing; a private item with a hosted chain is released as `egress-refused`, has no failed attempt and is not taken again in the run; a timeout and a state over the limit are failed attempts with backoff; the cost gate stops the loop; the deadline stops the loop with items still ready; an untuned entry held to shadow behaves as shadow.
- [x] 4.2 `decision-executor.ts` (design D4), the setting `dream.model_budget_ms` with its documentation.

## 5. Planning applies (spec: "The fixed rule does not answer in place of a model", "Answers are applied through the existing writes, once", "Topic judgment and topic planning run on the dream owner's device")

- [x] 5.1 Tests first, `tests/core/topics/planning-queue.test.ts`: accepted answers become the routes, creations with approval, derived items, proposals and history verdicts they become today for the same verdicts, with the answering provider and model as author, and their items are marked applied with the written ids; an answer below its threshold marks the item abstained and writes nothing; `topic-new` and `human-readable` never abstain; planning twice writes once; an answer whose subject a person changed meanwhile is not applied; a veto and a "none" route hold in the next pass with nothing asked again; a same hint is shown by the review listing from both of its callers in a later pass; with no answer a record stays unassigned and a qualifying group is not created; a brain with an owner plans only on the owner's device, another device plans nothing and its summary says so; a brain with no owner bound plans under the view writer gate and decides nothing.
- [x] 5.2 `planning.ts` (the queue fold read under the lock, verdicts built from it, the applied marks, the gate on the dream owner), `plan.ts` (no rule routing, creation only on approval), `review.ts` and `actions.ts` (hints from the fold), `dream-tail.ts` and `dream-types.ts` (the `topicVerdicts` option removed, the `judgment` field) (design D2, D5).
- [x] 5.3 The front door (design D1): `decide-auto.ts` produces and runs the executor on the owner's device for a live pass; its three callers keep awaiting it; a dry run and every preview produce nothing and ask nothing (a test per caller). The old decide pass modules that only served the in-memory path are removed; the asked file is no longer read (design D6).
- [x] 5.4 The existing decide tests of `inventory.md` section 9, changed as rule 7 says.

## 6. Surfaces (spec: "Waiting is visible and explained")

- [x] 6.1 Tests first, then: the status groups and reasons derived from records, `dream-queue-no-executor` per operation, the doctor code registered and placed (`tests/core/brain/doctor-exit-census.test.ts`), the summary fields (design D7).

## 7. Docs

- [x] 7.1 `CHANGELOG.md` under `## [Unreleased]` with the breaking point. `docs/decision-models.md` and `docs/how-it-works.md` (design D7.4). `docs/cli-reference.md` where the status output is shown.

## 8. The gate

- [x] 8.1 Run each on its own and fix what fails: `bun run test`, `bunx tsc --noEmit -p .`, `bun run lint`, `bun run fmt:check`, `bun run check:paths`, `bun run sync-plugin-mirrors:check`, `bun run scripts/sync-version.ts --check`.
- [x] 8.2 If the OpenClaw bundle includes changed code, rebuild it with `bunx bun@1.4.4 run build:openclaw` and say so.
- [x] 8.3 Measure a pass over a generated backlog of 200 unassigned records with the injected provider, before and after: requests, items produced, time to produce, time per take and answer. Put it in the report.
- [x] 8.4 Windows shards: name the new test files that run longer than a few seconds.

## 9. Report

- [x] 9.1 Report: per section what was built (files), the tests added with real counts, every existing test changed and how, the measurement, every place the design was not followed and why, and what is left open.

## Workflow follow-up

- Independent code review rounds, then archive the change inside its pull request.
