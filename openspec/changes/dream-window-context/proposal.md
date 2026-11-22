# Proposal

## Why

Every rule of a dream pass asks the clock for the present, and several steps read the evidence log on their own. That is why a pass can only judge today. Before a pass can replay the days it missed, every rule has to take its present and its inputs from one place. This change does that and nothing more ambitious: each pass is still one window, today's. One rule changes on the way, because leaving it would make the replay disagree with daily passes: evidence dated after a trial's deadline stops confirming that trial.

## What Changes

1. A window context: the instant the rules judge against, the real wall clock, the day, and the inputs (signals, evidence read once). Every rule of the pass that read the clock or the log reads the context.
2. A census test that fails when a module of the pass reads the clock or the log on its own.
3. **BREAKING**: evidence confirms a trial only when its event time is not after the trial's deadline.
4. Test helpers for generated histories and a driver of daily passes, used here to show the pass did not change and by the replay change as its reference.

This change is one of a series that makes dream agent-neutral; it does not depend on the others, and the replay itself is a later change.

## Capabilities

### New Capabilities

- `dream-replay`: started here with two requirements (one present for a pass, the deadline rule); the replay itself is added by the change of the same name.

### Modified Capabilities

None.

## Impact

1. Code: `src/core/brain/dream.ts`, `dream-scan.ts`, `dream-plan.ts`, `dream-plan-topics.ts`, `signal-archive.ts`, `dream-refresh.ts`, `dream-plan-retires.ts`, `confidence.ts`, `inject-governor.ts`, `salience-gate.ts`, `intent-review.ts`, `reconcile-outcomes.ts`, `dream-plan-cross-topic.ts`, `dream-rollup.ts`, `dream-apply.ts`, `dream-report.ts`, `evidence.ts` (split: a new `evidence-read.ts`), `preference.ts` (`moveToRetired` takes evidence from its caller), `src/mcp/brain/review-tools.ts`, `src/core/brain/doctor/inbox-archive-check.ts`; a new `src/core/brain/dream-replay/window.ts`.
2. Interfaces: none.
3. Behaviour: unchanged except the deadline rule.
4. Risks carried into the design: a missed reader of the clock or the log; a refactor across many planners.
5. Not in this change: any loop over days, positions, coverage, ledgers, the bootstrap, transfer.
