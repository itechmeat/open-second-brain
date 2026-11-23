# Tasks: the launched agent

Work in order, one section at a time. Before a section, read its part of
`design.md` and the spec requirement it names. Tick each box (`- [x]`) as
soon as it is done. Partial edits from an earlier attempt may already be
in the tree: review them, keep what is right, finish the rest.

For every behaviour: write the failing test first, run it and see it
fail, then write the code.

## Environment and rules

1. Work only in this checkout. Never read or write the real user state: not the real machine config, not a real vault, not the real state directories, not any real agent host configuration. Tests build everything in temp directories.
2. No test starts a real agent program. Every test of the worker uses a fake agent: a small script in the test's temp directory that speaks MCP over standard input and output to the server it is told to start, with scripted behaviour (answers, hangs, exits early, never calls the tools). The one place a real agent runs is task 6.3, by hand, reported, not part of the suite.
3. Your own temporary data goes under one directory you create with `mktemp -d` and remove at the end by its exact path. Never remove anything by a wildcard.
4. English only, no exclamation marks, the product name written "Open Second Brain" in full. No version bump: the changes before version 2.0 merge without a release, with their entries under `## [Unreleased]`; this overrides the bump rule of `CLAUDE.md` for this pull request.
5. No test-only seams in production code. A spy forwards every argument and is restored in `finally`; never `mock.module` a shared builtin.
6. Search before reading: `zg "<meaning>"` or `zg --rg -F "<text>"`.
7. If a fact the design states does not match the code, take the smallest deviation that keeps the spec's requirements and list it in the report; stop only when a requirement itself cannot be met.

## 0. Preconditions

- [x] 0.1 Read `CLAUDE.md`, then this change's `brainstorm.md`, `proposal.md`, the spec delta, `design.md`, `review.md` and `inventory.md`, and the designs of `dream-work-queue` and `dream-closed-questions`. Confirm both are in this branch (`decision-executor.ts`, the trait `appliedBy`, the take filter, `produceWorkBatch`, the producer of closed questions); if not, stop: nothing here can be built without them.
- [x] 0.2 Confirm the tree is clean. Run `bun test tests/core/brain/dream-queue tests/core/topics tests/mcp --timeout 30000` and note the counts. A red baseline is reported, not built on.

## 1. The run and the marker (spec: "A run authorises the operations, a marker does not", "The session is kept apart")

- [x] 1.1 Tests first: a run record is written with mode 0600 and found by id and token; a wrong token, an expired run, another owner revision are refused; a stale record is swept; `insideDreamSession` is true only with the marker; with the marker both hook launchers (`scripts/o2b-hook` and, when present in the branch, `bin/o2b-hook.js`) exit 0 before running any hook file (one table test over the hook names of `hooks/hooks.json`, each against a temp home, asserting nothing was written); the live capture seam records nothing with the marker; a transcript whose first user message begins with the session line is ignored by the live seam and by the batch import, and one that only quotes the line later is not; the server appends one line per call to the run's call log.
- [x] 1.2 `run-record.ts`, `insideDreamSession`, its call in the hook launchers and the live capture seam, the session line in the capture boundary for both seams, the call log (design D2).
- [x] 1.3 Tests first, then `src/core/process/run-program.ts` (design D4): a program that exits, one that is ended at the deadline, one that ignores the termination signal and is killed, a child of the program that is ended with it, arguments with spaces and non-ASCII characters passed intact, no shell involved; the Windows branch behind the platform guards the repository uses.

## 2. The profile and the three tools (spec: "The session works only through three operations")

- [x] 2.1 Tests first, `tests/mcp/dream-executor-profile.test.ts`: the server in the profile lists exactly three tools and no capability tool; resource and prompt methods return nothing and a resource read is refused; initialize advertises neither and gives the fixed task as instructions; the profile is refused as a brain setting value and is not an install profile; it refuses to start without a live run; take returns one ready item or nothing with a reason; answer accepts with a receipt and refuses a stale generation, a changed input and a wrong shape with the queue's reason; the agent recorded is the run's, not the caller's claim; finish releases the run's leases; the item budget stops take; every call with the marker and no valid run is refused and writes nothing.
- [x] 2.2 The exact profile, the three tools, the start check, the instruction override (design D3). The tests that enumerate profiles or assert the kept capability tool, updated without weakening them for the other profiles: `tests/mcp/profiles.test.ts`, `tests/mcp/runtime-capabilities.test.ts`, `tests/mcp/mcp.test.ts`, `tests/helpers/tool-probe-catalogue.ts`, `tests/core/brain/policy/install-block.test.ts`, `tests/core/architecture/harness-identity-census.test.ts`; the registry guard; `docs/mcp.md`.

## 3. Settings, presets and the worker (spec: "The launch command is a machine setting with fallbacks", "A run is bounded", "The agent answers closed questions nobody else answers")

- [x] 3.1 Tests first, with the fake agent: a command given as a JSON array is used as its arguments with no splitting (spaces, quotes, non-ASCII kept), an invalid value is a configuration error that names the key; placeholders are filled; the keys are read from the machine config and their environment twins and are not shared settings; a session that answers everything; one that exits early (leases released, items offered again); one that hangs (ended at the deadline, pass completes); the budget is clamped to the caller's remaining time less the reserve, and under the minimum no session starts and the reason is `no-time` (for the verb, the MCP tool and the lane task); one that never calls the tools; the fallback is tried once after a failure and the run records which command answered; no verified command means nothing is started; the session is offered text operations always and closed operations only when the decision model does not answer them; private items are withheld when `dream_agent_private` is off.
- [x] 3.2 The config keys, `agent-presets.ts` (the table and `restricts`), `agent-executor.ts`, its call in the front door after the decision model executor (design D1, D4).

## 4. Verification (spec: "The command is verified by a real call")

- [x] 4.1 Tests first, with the fake agent: the check passes when both canary items are answered correctly and finish is called; fails within its limit when the session never calls the tools, answers wrongly or does not finish, and says what it saw; the canary runs in a throwaway store under the device state directory, removed afterwards, and writes nothing to the brain; a failed check prints what the call log shows; a verified command is recorded by its hash and used by the worker; a changed command is unverified again.
- [x] 4.2 `src/cli/dream/agent.ts` (`show`, `set`, `check`), the dispatch and command manifest entries (`tests/cli/manifest-completeness.test.ts`, the help parity tests), `--dream-agent` on `o2b setup` if the setup verb is in this branch (otherwise leave a note in the report), `docs/cli-reference.md` (design D5).

## 5. Text work and drafts (spec: "Text work is done only by the launched agent", "Text written by a model is a draft until it is applied")

- [x] 5.1 Tests first: the rollup apply writes the note with its author and is a no-op the second time, and does not deadlock while another process holds the locks of the note creation path; a `topic-wording` item is produced for every group that qualifies, in the batch of its `topic-new` item; a note with the wrong kind, an empty body or over the size bound is a failed attempt; the `topic-wording` operation's validate, `currentInput` and bounds; a topic is created only when approved and worded, with the agent's title, goal and author; with no wording answer it is not created; in `auto` text answers are applied by the next pass; in `review` they wait as `awaiting-review`, approve applies them, reject closes them with the reason; the listing shows the text.
- [x] 5.2 The rollup apply, the `topic-wording` operation and its use in planning, the removal of the rule's title from the create path, the trait `text`, the shared setting `dream.apply_drafts` in the closed list of setting keys and in the fold's input, the fold state, the text in the listing, the approve and reject verbs (design D6, D7). Existing tests that create a topic with a rule title change to the new flow; list each.

## 6. Surfaces, docs and the real check

- [x] 6.1 Tests first, then: the four doctor codes registered (`doctor.ts`, `store-side-pass.ts`) and placed (`doctor-exits.ts`, `diagnostics.ts`; `tests/core/brain/doctor-exit-census.test.ts`), the status section, the per-operation `executor` field (design D8).
- [x] 6.2 `docs/dream.md`, `CHANGELOG.md` under `## [Unreleased]` with the breaking point, `install.md` (a short section on the dream agent).
- [x] 6.3 By hand, on this machine, with a temp home and a temp brain: for each agent program installed here, find its non-interactive form that restricts the session to one MCP server, write the preset, and run `o2b dream agent check` against it. Put in the report, per agent: the program version, the exact command, and the check's output. Ship only the presets that passed. If none passes, ship no preset and say what failed.

## 7. The gate

- [x] 7.1 Run each on its own and fix what fails: `bun run test`, `bunx tsc --noEmit -p .`, `bun run lint`, `bun run fmt:check`, `bun run check:paths`, `bun run sync-plugin-mirrors:check`, `bun run scripts/sync-version.ts --check`, `bun run pack:check` if the script exists in this branch (regenerate the manifest with `bun run scripts/pack-manifest.ts --write` for new source files).
- [x] 7.2 If the OpenClaw bundle includes changed code, rebuild it with `bunx bun@1.4.4 run build:openclaw` and say so.
- [x] 7.3 Windows shards: name the new test files that run longer than a few seconds; keep the fake agent tests in files of their own.

## 8. Report

- [x] 8.1 Report: per section what was built (files), the tests added with real counts, every existing test changed and why, the result of 6.3, every place the design was not followed and why, and what is left open.

## Workflow follow-up

- Independent code review rounds, then archive the change inside its pull request.
