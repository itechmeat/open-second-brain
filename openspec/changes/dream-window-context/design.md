# Design

## Context

From `inventory.md` in this folder and the review of the replay artifacts (each claim with its code reference there):

1. `dreamRun` (`src/core/brain/dream.ts`) threads `now` into its steps. The rules that read it are listed in D2.
2. Steps that read the evidence on their own: `scanApplyEvidence` reads the whole log once (`dream-refresh.ts`); the freshness trend and the per-preference rereads read it again at plan time; the preference bodies reread it at apply (`dream-apply.ts`); `priorCounters` and `privateEvidenceCounts` read the store inside the evidence walk; the salience gate reads lessons and observed use.
3. The archive rule reads `min(now, wall clock)` (`signal-archive.ts`), pinned by `tests/core/brain/signal-archive-edges.test.ts` ("a future --now does not archive against a clock that has not come").
4. Confirmation of a trial is "a first application exists" with no check against the deadline (`dream-refresh.ts`); the retire plan then reads the refreshed status (`dream-plan-retires.ts`). No existing test has evidence dated after a deadline.
5. Order inside `dreamRun`: scan, intent review, topic plan, archive plan, then the evidence read, then the refresh plan. The safeguard checkpoints inside the evidence walks are pinned by `tests/core/brain/dream-checkpoints.test.ts`.
6. `scanApplyEvidence` keeps only `pref-` targets. The per-preference readers (`dream-refresh.ts`, `dream-apply.ts`) go through `collectEvidenceForSlug` in `evidence.ts`, which matches `pref-<slug>` and `ret-<slug>` and reads the log itself. `moveToRetired` in `preference.ts` reads the log the same way when its caller passes no evidence; `dream-apply.ts` passes none today. The command line's reject path reaches `moveToRetired` outside any pass.
7. `buildIntentReview` falls back to `new Date()` when no moment is passed, and `src/mcp/brain/review-tools.ts` relies on that. `archiveClock` in `signal-archive.ts` defaults its wall clock, and `src/core/brain/doctor/inbox-archive-check.ts` relies on that.
8. `buildRollupPlan` reads no clock. `writeDreamLog` stamps its events from a cursor seeded with the pass's moment.

## Goals / Non-Goals

**Goals:**

1. Every rule of the pass reads its present and its inputs from one value.
2. A build fails when a rule reads the clock or the log on its own.
3. No behaviour change except the two stated ones.

**Non-Goals:**

1. A loop over days, admission, coverage: the replay change.
2. The decide pass, the topic pass, the view pass, digest regeneration, the workrun journal, the snapshot gate, lane id repair: they keep their own clocks.
3. Reads of state that are neither the clock nor the evidence log (the rollup ledger, the link walk, lessons and observed use, the store folds of preferences): unchanged here. The replay change bounds the ones it needs.
4. Any change to what a pass on a brain not yet on the store archives. The first draft stopped the archive there; the review showed it would rewrite thirteen tests and make every such pass a changed run, for a state version 2.0 leaves automatically. Dropped: such a brain keeps today's pass, and what it archived before its switch is counted by the replay's bootstrap.

## Decisions

### D1. The context

`src/core/brain/dream-replay/window.ts` exports `WindowContext`:

1. `instant`: the moment the rules judge against. In this change always the pass's `now`.
2. `wallClock`: the real clock, read once when the context is built.
3. `day`: the UTC day of `instant`.
4. `signals`: the scanned signals, each with an `effectiveTime` (in this change its own `created_at`).
5. `evidence`: set once, later (see below): every evidence event of the log with its target, `pref-` and `ret-` alike, with the merge aliases and the private counts, and a lookup by slug that takes the same options as `collectEvidenceForSlug` (the trend asks for up to 1000 applications, the others use the defaults) and returns what it returns today.
6. `final`: true (in this change always: the window is today's).

`dreamRun` builds the context right after the scan, before the intent review, so the plan-side rules have it. The evidence is read where it is read today, after the archive plan, so the checkpoints keep their order; that one read fills `evidence`. A step that asks for `evidence` before it is set throws: a programming error, covered by a test. The replay change later builds one context per window.

The wall clock is read a few milliseconds earlier than today (at the context, not inside the archive rule). The pinned test works in days; no outcome depends on those milliseconds.

### D2. What reads it

| Rule or step | Module | Takes from the context |
|---|---|---|
| Contradiction window | `dream-plan.ts` `filterWithinWindow` | `instant`, `effectiveTime` |
| Intent review (keeps its upper bound `created <= now`) | `intent-review.ts` | `instant`, `effectiveTime` |
| Signal expiry | `dream-plan-topics.ts` `dropExpiredSignals` | `instant` |
| Temporal constraints of a signal's text | `dream-plan-topics.ts` | `instant` |
| Guardrail minimum age | `dream-plan-topics.ts` | `instant`, `effectiveTime` |
| Archive rule | `signal-archive.ts` | the earlier of `instant` and `wallClock`, `effectiveTime` |
| Reconcile outcomes | `reconcile-outcomes.ts` | `instant`, `effectiveTime` |
| Trial deadline, staleness, chain decay | `dream-plan-retires.ts` | `instant` |
| Trial stamp at promotion, creation stamp | `dream-apply.ts` | `instant` |
| Confidence, freshness trend | `confidence.ts`, `dream-refresh.ts` | `instant`, `evidence` |
| Evidence for refresh (the `pref-` subset), per-preference lists, bodies at apply, the snapshot of a retired rule | `dream-refresh.ts`, `dream-apply.ts` | `evidence` |
| Salience mass | `salience-gate.ts` | `instant` |
| Cross-topic daily allowance | `dream-plan-cross-topic.ts` | `day` |
| Audit events: their stamps, their day and shard link | `dream-report.ts`, `dream.ts` | `instant`, `day` |

The rollup plan reads no clock and is not in the table.

Four callers outside the pass lose a default and pass the value themselves: `src/mcp/brain/review-tools.ts` and `src/cli/brain/verbs/intent-review.ts` pass the moment to `buildIntentReview`; `src/core/brain/doctor/inbox-archive-check.ts` passes the wall clock to the archive selection; the command line's reject path keeps reading the log for `moveToRetired`.

**Where the log is read.** The reading half of `evidence.ts` (the function that opens the log for a slug) moves to a new module `evidence-read.ts`; `evidence.ts` keeps the pure matching. `window.ts` owns the pass's one read and builds the lookup with the same matching. `scanApplyEvidence` takes the events from the context and applies its `pref-` filter as today. `dream-apply.ts` passes the retired rule's evidence lists into `moveToRetired`, which reads the log only when none are passed (the command line's path).

**The census** (`tests/core/architecture/`): in exactly the modules of the table, no call of `Date.now`, no `new Date()` with no argument, and no import of the reading symbols (`logDayReader`, `readStoreLogEvents`, and the reading function of `evidence-read.ts`). `window.ts`, `evidence-read.ts` and `dream.ts` (which holds the read pass and builds the context) are outside the list. Writers of the log (`appendLogEvents`) and dates built from an argument are not readers of the present and are allowed. The modules of Non-Goal 2 are not in the list.

### D3. Evidence confirms a trial only when dated on or before its deadline

In the refresh plan, an application counts toward confirming a trial only when its event time is not after the trial's `unconfirmed_until`. It still counts in the counters. A trial with only later evidence is then seen unconfirmed by the retire plan and retired at its deadline, whatever the hour of the pass. The path from quarantine back to confirmed is not touched. New tests pin both sides; the baseline rerun shows whether any existing test depended on the old behaviour, and the report names it if one did.

### D4. The history helpers

`tests/helpers/dream-history.ts`: a seeded generator of histories on a temp brain served from a store (signals by topic and agent, evidence, expirations, trials, competing cross-topic clusters, a superseded chain), every record with an event time and an admission day; a driver that runs one pass per day with the records admitted by that day; a canonical dump of a brain's records that leaves out run ids and run times and does not include snapshots, workrun journals or retention state at all. In this change it backs one test: for a table of seeds, the dump after daily passes is identical before and after the refactor (the expected dumps are produced in task 0, after checking that nothing under `src/` differs from the branch point, and committed as fixtures), apart from the cases the deadline rule changes, which are listed.

## Risks / Trade-offs

1. A reader of the clock the table misses. The census covers the listed modules; the generated-history test covers behaviour.
2. The refactor touches many planners in one pull request. It is mechanical, and the existing dream tests are the proof; the task forbids editing them outside the named ones.
3. Fixture dumps from the baseline are large. They are compressed to a hash per seed plus one readable dump for the first seed.
4. The retired rule's evidence now comes from the caller inside a pass and from the log outside one; a test compares the two for the same rule.
