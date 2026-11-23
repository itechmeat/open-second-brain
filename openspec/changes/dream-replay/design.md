# Design

## Context

Facts from `inventory.md` (each with its code reference there) and the partner's corrections:

1. `dream()` wraps `dreamRun` in the log read pass, the topic pass and the view pass (`src/core/brain/dream.ts`). `dreamRun` plans (scan, intent review, topic plan, archive plan, evidence scan, refresh plan, retire plan, cross-topic plan, reconcile, salience gate, rollup plan), then on a state change snapshots and applies, writes the audit log and the two ledgers, regenerates the digests.
2. Eighteen places read the present (`inventory.md` section 2). Days are counted in UTC (`src/core/brain/time.ts`).
3. Some steps read inputs on their own: the freshness trend and the preference bodies reread evidence (`dream-refresh.ts`, `dream-apply.ts`); the rollup plan is built from the preferences before the pass's promotions.
4. The pass keeps no boundary. The cross-topic ledger and the rollup ledger are files that are device-local on a machine switched to the store (`src/core/brain/paths.ts`). Cross-topic preferences are written before that ledger. The run id is part of the rollup target path.
5. The store's reader returns a resumable byte offset per shard, holds back an unverified last line, classifies gaps (`shardReadGap`, `shardScanGap`) and verifies a previously read prefix on an incremental read (`src/core/store/reader.ts`, `read/stream-read.ts`). A compaction record names `replaces` and `into` and no mapping of records.
6. Workrun journals are forensic and do not resume (`dream-workrun.ts`).
7. The changes before this one give: one owner device with a gate, a pass lock and a release record (`agent-neutral-dream`); a durable queue with `produceWork` and `applyAccepted` (`dream-work-queue`); and one window context that every step of the pass reads its present and its inputs from, with the deadline rule for trials (`dream-window-context`).
8. The pass does not read by position today. Signals and preferences reach it through `readStoreEntities` (a fold over whole shards of the `events` stream, cached by shard stamp), evidence through `readStoreLogEvents` and `logDayReader` (whole log or a date range). `readStreamRecords` takes no offset; offsets exist at `readShard(path, { offset })`. A prefix is verified only in process (`ShardTails` and a private `hashRange` in `read/stream-read.ts`); nothing checks a stored prefix digest.
9. A store record id must be a ULID (`src/core/store/envelope.ts`). A second create of a preference with `overwrite: false` throws. The mechanism that makes a repeated write converge is the idempotency key (`src/core/brain/preference.ts`, `idempotency-ledger.ts`): the same key with the same payload is a no-op, the same key with another payload throws. `writeDreamLog` appends unconditionally. Heal enrichment has no subject.
10. The staged pass validates today's plan against the current state and then runs the live pass, relying on both producing the same plan (`dream-stage.ts`). Its serialised plan is a projection of ids and reasons, not the payloads.
11. Store compaction is not implemented yet; the reader already understands `compacted` records.

## Goals / Non-Goals

**Goals:**

1. After any silence, the brain is where daily passes over the same admission history would have left it.
2. A pass with no gap is byte-for-byte the pass of today, apart from the two stated breaking points and the new records.
3. An interrupted window and an owner transfer continue without a repeated or lost effect.
4. No attendance: nothing in the normal course stops and waits for a person.

**Non-Goals:**

1. Skipping days on which nothing can change.
2. Reconstructing how hand-made changes looked on a past day.
3. The trigger, what closes a day, any executor, the decide pass's budget and order.
4. Changing the topic pass or the view pass: they run once, after the last window of a pass.

## Decisions

### D1. The window loop

`dream()` keeps its wrappers. Inside, `dreamRun` becomes a loop over windows; one iteration is today's `dreamRun` body with a window context.

A window is `{ day, from, to, instant, final }`: a UTC day, its bounds, the evaluation instant (`to` for a past day, the run's real `now` for today's) and whether it is today's. The loop:

1. Bootstrap if there is no coverage (D7), or resume an open window (D5).
2. Compute the days from the day after the last covered one through today.
3. For each, in order: admit (D3), plan, write the plan record, apply, audit, cover (D5). Stop when the budget is spent (D6).
4. After the loop: digests once, then the topic and view wrappers as today.

A dry run and a preview plan only today's window over the current state, write nothing and say in their output how many windows a live pass would replay first. The staged flow keeps its contract (the validated plan is the executed plan) by refusing while windows are behind: `stageDream`, `validateDreamBundle`, `applyDreamBundle` and `retriageDreamBundle` (`dream-stage.ts`, reached from the dream verb and the MCP dream tool) answer that the replay must run first, with the count, and name the command. With coverage at yesterday they work as today, and the staged `apply` runs exactly one window, today's.

Digest regeneration, the topic pass and the view pass run once per pass, after the last window, as today. Heal enrichment runs inside `applyDreamPlan` today; it is lifted out to run once after the last window, since it has no subject to make it converge. The vault snapshot is taken once per pass, before the first destructive effect of whichever window has one; a pass whose windows all plan nothing takes none, as the no-op path does today.

### D2. The window context

The context, its table of rules, the census test and the deadline rule for trials are the change `dream-window-context`, which lands first and runs every pass as one window. This change makes the loop supply one context per window: the instant (`to` for a past window, the real moment for today's), the real wall clock (the archive rule keeps reading the earlier of the two, so a pass with a future `now` archives nothing early, as `tests/core/brain/signal-archive-edges.test.ts` pins), the day, and the inputs D3 defines. Evidence in a context is cumulative: every event below the window's boundary with an event time not after the instant, because the counters are totals over all history.

### D3. Positions, the boundary and admission

**The read path this needs** (new, in the store's read layer, with its own tests):

1. `readShardsFrom(positions)`: for each shard of the given streams, the verified records after the recorded offset and the new offset, through `readShard`; the gap classification of the reader; and a check of the recorded prefix digest (the private range hash is exported as a helper). A shard whose prefix does not match, or that a compaction record replaced, is reported as such.
2. An `until` option on `readStreamRecords`: a per-shard byte limit. A fold given `until` sees nothing beyond it. `readStoreEntities` and `readStoreLogEvents` pass it through. `readStoreEntities` caches one fold per store root, keyed by shard stamps: a read with `until` does not use or replace that slot (the pass keeps its own per-window result), so a replay does not thrash the cache other readers rely on. `readStoreLogEvents` has no cache; the pass's log read pass is keyed by shard size and time and gains the limit in its key.

A position is `{ partition, stream, device, shard, offset, prefix_hash }`. The pass keeps positions for the `events` stream (signals, preferences and their state records) and the `log` stream (evidence).

**Admission.** At the start of a window the pass calls `readShardsFrom` with the last positions and writes one `dream-admission` record before anything else:

1. `positions`: the new positions. This is the window's boundary. A shard with a gap keeps its old position and is listed under `gaps`.
2. `late`: ids of new records whose event day is at or before the last covered day, with this window's day. Their effective time is the window's `from`.
3. `clamped`: ids of new records dated after the real moment of admission; their effective time is that moment.
4. Every other new record keeps its event time as its effective time and needs no entry. This includes records dated inside the part of the gap that is not replayed yet: during a gap no pass ran, so the admission history of the gap is the event time.

The store does not record when a record reached this machine, and this design does not add that: a record dated on an uncovered day that actually arrived two days later is treated as present on its own day. That is the definition of admission here, and the equivalence requirement is stated against it. It is also the kinder reading: a daily machine would have seen the record two days late only because sync was slow, which is not a fact worth reproducing.

**Inputs of a window.** Not the new records: everything below the boundary. `dream-scan.ts` builds its scan from `readStoreEntities` with `until` set to the boundary, and the window context's evidence read takes the log the same way.

The time filter applies to inputs only, and an input has exactly one time. A signal is filtered as an entity, by the effective time of its creating record: its own `created_at`, or the time the admission records give that record id. An evidence event is filtered as an event, by its own time or its admitted one. Evidence means every record of use, in both forms the store has: the events of the log and the `preference-evidence` records the fold counts. The pass computes a window's counters from the filtered evidence and never takes the fold's totals (`priorCounters` in `dream-refresh.ts` reads the counts the previous window stored on the rule, or the filtered count, not `countersForShared`), so the daily reference and a replayed window decide on the same baseline. `late` and `clamped` therefore name only signal creation records and evidence records. Everything else below the boundary is state and is not filtered by time: preferences and their updates, signal state records (consumed, archived), retirements, merges, settings. They are either what earlier windows of this replay wrote, or what people changed, which applies from the first replayed window by decision. So a record read while an early window was admitted, and dated later, is an input of the window of its day without being read specially: nothing is lost behind a position. The order of late records among themselves follows admission, then event time.

If `gaps` is not empty the window is not evaluated and no plan is written for it: the pass stops at that window, and the next pass admits again from the same positions (a later admission record for a window replaces an earlier one that had gaps). A window that has a plan is never admitted again (D5), and a plan is written only from an admission without gaps, so the two rules never meet. A gap that lasts is not allowed to stop dream for good: when the same source has had a gap for three days of passes, the window is admitted without that source's new records, the admission record says which source was left out and from which offset, the audit record and doctor report it, and the replay goes on; the left-out records are admitted as late when the source becomes readable. Doctor names the shards in both cases.

The effective times of late and clamped records are kept as long as the record they name is neither consumed nor archived.

**Rebase.** When `readShardsFrom` reports a replaced shard or a prefix that does not match, the positions of the replacing shards (or of the same shard) are set to their ends, every record in them whose event day is at or before the last covered day is taken as seen, later ones are admitted normally, and the admission record carries `rebased` with the shard names and the number of records taken as seen. Doctor reports it once. Store compaction does not exist yet, so this path is proven against hand-built `compacted` records and rewritten shards.

### D4. Effects that converge, and ledgers in the store

Every effect a window plans has an effect id: the hex sha256 of `[window day, effect kind, subject]`. Record ids stay ULIDs; the effect id is carried where the code already has a place for it:

1. The plan record holds every effect with its id and its frozen payload: for a new preference the whole page content (principle, evidence, sign, scope, temporal bounds, visibility, supersedes, `created_at`, `unconfirmed_until`), for a refresh the counters, stamps, confidence and trend, the band drops, the rollup envelopes with their target paths. Payloads large enough go to blobs. The staged projection is not reused: it holds ids and reasons only.
2. A new preference (topic plan and cross-topic) is written with the effect id as its idempotency key. A second application with the same frozen payload is a no-op by the existing ledger. Because the payload comes from the plan record and is never recomputed on resume, the "same key, other payload" refusal cannot fire.
3. Retirements, refresh updates, signal moves, archive moves and confidence receipts already converge (state checked, byte-identical, or keyed); they are applied from the plan as they are.
4. The audit events of a window are built from the plan record, not from what this process happened to execute, so a resumed window writes the same events an uninterrupted one would. The plan record has an `audit` part that holds what the tail reads today and the effects do not carry: the corrupt pages of the scan, the suppressed signals, the retain-pinned rules, the contradiction topics and the topic key contentions; the non-primary note is a field of the run, added when the events are written. Every kind `writeDreamLog` writes today is covered, the suppressed signal and the retain-pinned retirement included (by signal, and by slug). Every event carries `window` and `effect` in its body, the effect id hashed from the window, the event kind and its subject: a skipped corrupt page by its path, a redundant note by preference and signal, a retirement by slug, a reconciliation by topic and scope, a rollup by rung and target, the window's summary event by the day alone. Before appending, the writer reads the window's events through the log read pass and appends only the effect ids that are missing.
5. The cross-topic ledger and the rollup ledger become records in the `shared` partition: `dream-cross-topic-spent { day, owner_token, effect }` and `dream-rollup-baseline { rung, baseline, produced, window, effect }`. Their folds keep one record per effect id and replace the two files. The files are device-local on a switched machine; the bootstrap (D7) imports this device's files once, which is enough because only the owner's device ran passes.
6. Rollup target paths keep their current form with the run id; the path is part of the frozen payload, so a resumed window reuses it. The run id collision rebuild stays for the first planning of a window and is not run on resume.
7. Model work a window produces goes through `produceWork` with the window's day as its occurrence; the queue's own identity makes it converge.

### D5. Commit order and resume

Per window, in the `shared` partition, stream `dream-replay`:

1. `dream-admission` (D3).
2. `dream-window-plan { day, bounds, instant, effects, reconciliations, engine_version, policy_digest }`.
3. The effects, each applied from the plan's frozen payload (D4); the snapshot rule is in D1.
4. The audit event.
5. `dream-coverage { day, admission, plan, owner, run, behind }`.

A window with an admission and no coverage is open. A pass that finds one does not admit or plan again when the plan record exists: it applies what the plan lists and is not yet done, then audits and covers. With an admission and no plan, it plans from that admission. The fold of the stream gives: the last covered day, the open window if any, and the positions.

`engine_version` and `policy_digest` (a hash of the dream settings the plan was made under) are recorded so a doctor can say that windows were evaluated under settings that have since changed; they do not alter the replay.

### D5a. Reconciliation of timely evidence after a retirement

When a window admits late evidence (the `late` list of its admission record), the plan compares each such event with the rule it targets: if the rule is retired with the reason `expired-unconfirmed` and the event's own time is not after that trial's deadline, the plan gains a reconciliation entry (rule, evidence ids, the deadline, the window that retired it). It is an effect like the others: it has an effect id, is written into the audit events and shown in the digest. It changes no rule. The deadline is not on a retired rule (the retirement drops it), so the retirement effect in the plan record carries it, and the comparison reads it from the plan of the window that retired the rule. For a rule retired before the replay existed there is no such plan: the deadline is taken from the rule's last record before its retirement in the store's history, and when that is not there no entry is written and the window's audit counts it as not checkable. Evidence that is merely late for a rule that is still active needs no entry: it counts.

### D6. Budget

`dream.replay_budget_ms` (default 60 000) bounds one pass. It is checked before each window and between effects; both points have a test. When it is spent the pass ends normally: finished effects are durable, an open window stays open, the summary says how many windows are behind. The decide pass, the topic pass and the view pass keep their own budgets.

### D7. Bootstrap

With no `dream-coverage` record and the brain on the store:

1. Inventory in pages with a durable cursor (`dream-bootstrap { cursor, counts }` records): unconsumed signals, archived signals, active trials and their evidence, the two ledger files, the last `dream` audit event.
2. The start day is the earliest of: the event day of the oldest unconsumed signal; the event day of the oldest archived signal that shares a topic key with an unconsumed one and lies within one contradiction window before it; and the day after the last audited pass. The audit log records only passes that changed something, so "the last audited pass" is the last pass that changed something; the days after it that a pass visited and left unchanged are replayed as empty windows, which costs time and changes nothing. With none of the first two it is the day after the last audited pass, or today for a brain that never ran a pass.
3. The initial positions are zero for every shard: everything present is admitted by the first windows with its own event time, clamped as in D3. No record is late at bootstrap.
4. The report, once, in the audit record of the first window and in doctor: signals archived before replay existed that share a topic key with at least `promotion threshold - 1` others inside one window (they may have qualified for a promotion that never happened). They are counted, not reopened.

### D8. Transfer

1. The release record of the owner role gains `covered` (the last covered day, or null). This is the one change to the records of `agent-neutral-dream`.
2. A device that becomes the owner through a release runs no window until its fold of `dream-replay` holds the coverage record of that day and every shard named in that window's admission positions is readable up to the recorded offset. Until then the pass ends with the outcome `waiting-for-sync`, and the status says so.
3. A forced takeover has no such record: the new owner continues from the newest coverage it holds and its status and doctor say that windows covered by the previous owner may not have arrived. If they arrive later, the fold takes the highest covered day; effects are idempotent by id, so a window both devices evaluated has one set of effects.

### D9. A brain not on the store

Nothing of D1 to D8 runs on it. Its pass is the single window of `dream-window-context`, archiving included, as today. After the switch is verified the next live pass is the bootstrap, and the status never calls a legacy pass covered.

### D10. Surfaces

1. The dream owner status gains `replay`: last admitted positions (count of sources, any gaps by name), last covered day, windows behind, open window, and from the queue the windows that have unfinished model work.
2. Doctor: `dream-replay-behind` (info: windows behind, when more than one), `dream-replay-gap` (warning: a source with a gap, by name), `dream-replay-rebased` (warning, once per rebase), `dream-replay-waiting-sync` (info), `dream-replay-unrecoverable` (info, once: the bootstrap count), `dream-replay-policy-changed` (info). The existing `inbox-archivable` check counts against the next window instead of the present, through the function it shares with the scan (`scanInboxForArchive`), so the two cannot disagree.
3. The digest lists the interval a pass really covered and the reconciliation outcomes.
4. The pass summary gains `windows`: evaluated, covered, behind, open.

## Risks / Trade-offs

1. A step that still reads the clock gives a wrong past silently. The census test of D2 and the equivalence test are the guards; the equivalence test is generated (seeded) and runs daily against replay over histories with late sync, expiry, deadlines, competing clusters and chain decay.
2. Every day of a gap costs one plan over the brain. The report measures a 30 day and a 180 day gap on a generated brain of realistic size; if the 180 day replay does not finish in a handful of budgeted passes, day skipping becomes the next change rather than an optimisation.
3. Hand-made changes during the gap are visible to old windows. Stated in the spec; a rule a person retired last week is retired for the whole replay.
4. Rebasing after compaction can lose the late treatment of a few records. Reported with a count.
5. Plan records add data per window. An empty window's plan is small; the report gives the size for a busy one.
6. Moving the ledgers changes two files other code may read. The task lists every reader before removing them.
7. The staged flow refuses while windows are behind. A user of staged passes after a long silence runs one ordinary pass first; the refusal says so.
8. Two new options in the store's read layer are used by every reader's cache key. The read layer's own tests and the existing fold tests are the guard.
