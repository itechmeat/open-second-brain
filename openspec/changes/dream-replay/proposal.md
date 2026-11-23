# Proposal

## Why

A dream pass is one scan of the present. Run daily, that is correct. Run after two weeks of silence, it is not: every signal older than the window is archived in the first pass back, before the promotion it once qualified for is considered; trials, staleness and confidence are judged in one jump; a day's budget covers a month. The owner's rule for version 2.0 is that no period is left unprocessed: a machine that was off for weeks ends where daily runs would have ended. This change makes the pass replay the days it missed.

## What Changes

1. The pass works in windows of one day. A missed day is evaluated at its end, oldest first; today's window is evaluated at the real moment of the run, so a pass with no gap behaves exactly as it does now.
2. Every record has an event time and an admission window: the first window in which this brain's dream could see it. A record that syncs late counts from its admission on, is never archived unseen, and does not reopen what already happened without it.
3. A position per source (store, partition, stream, device, shard, verified offset) tells seen records from new ones. A source with a gap stops coverage: unknown is not empty.
4. A window is a recoverable unit: admission record, plan record, idempotent effects, audit record, coverage record. A crash resumes the open window instead of planning it again.
5. Coverage is in the brain store, so a new owner continues where the old one stopped, and waits until the old owner's last commit has synced. The rollup and cross-topic ledgers move from machine-local files into the store for the same reason.
6. A brain that predates this change is inventoried once, in pages, and starts its replay at the oldest retained input that can still change an outcome.
7. A pass has a budget that can stop it between windows or inside one; the next pass continues. The status says what was admitted, what was evaluated and what model work is unfinished.
8. Evidence dated in time for a trial that was already retired is recorded as a reconciliation outcome and shown in the digest; it does not revive the rule.
9. A staged pass is refused while windows are behind, and says which command replays them.

The cut of the series is in `openspec/changes/dream-work-queue/proposal.md`: the replay was then split once more on the reviewer's advice, into `dream-window-context` (one present for every rule, the deadline rule) and this change. The order of the series is now seven: `agent-neutral-dream`, `dream-work-queue`, `dream-window-context`, `dream-replay`, `dream-executors`, `dream-session-trigger`, `agent-parity`. This change depends on the first three.

## Capabilities

### New Capabilities

- `dream-replay`: what a pass covers, at which instants windows are evaluated, what admission gives a late record, when coverage advances, what a new owner needs before it continues, and what the first run on an existing brain does.

### Modified Capabilities

- `dream-ownership` (from `agent-neutral-dream`): one requirement is added: the release of the role names the last covered window, and a forced takeover says what may be missing.

## Impact

1. Code: the store's read layer (`src/core/store/read/stream-read.ts`, `store-entities.ts`, `log-events.ts`: reading from positions, a byte limit per shard, a stored prefix check), `src/core/brain/dream.ts` (the loop), `dream-scan.ts` and `dream-refresh.ts` (inputs below a boundary with effective times), `dream-apply.ts` and `dream-report.ts` (effects from a recorded plan), `dream-stage.ts` (the refusal), a new module family under `src/core/brain/dream-replay/` (windows, admission, positions, plan and coverage records, bootstrap), the two ledgers in `src/core/brain/paths.ts`, the owner release in the dream owner module, doctor, the dream owner status, the digest.
2. Store: new record kinds in the `shared` partition for admission, window plans, coverage and the two ledgers; the format document gains a section.
3. Behaviour of a daily pass: unchanged, proven by the existing dream tests passing unmodified.
4. Risks carried into the design: a step that reads the clock or the log outside the window's value; the cost of a long gap, since every day is replayed; compaction that cannot be verified; the size of plan records.
5. Not in this change: skipping days on which nothing can change, the trigger and what closes a day, any executor, moving closed questions off the decide pass (its budget and newest-first order are the executors change).
