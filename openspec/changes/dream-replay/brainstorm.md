# Brainstorm

This change is one of the changes cut in `openspec/changes/agent-neutral-dream/proposal.md`. The shared brainstorm with the owner's decisions is `openspec/changes/agent-neutral-dream/brainstorm.md` ("Starting dream" items 5, 6 and 8; "Model work" items 1, 2, 6 and 7). This file settles what those decisions leave open for the replay. It was first drafted as one change with the queue; the partner asked for the split, and the queue is now `openspec/changes/dream-work-queue`, which comes first. The code inventory behind both is `inventory.md` in this folder.

## What the code does today

From a read-only inventory of main (an agent of another model family, every claim with its code reference):

1. One pass is one scan of the present state. Eighteen places judge against the present moment. The ones that lose data after a silence: the contradiction window (14 days back from now) decides which signals count; expired signals are dropped against the present; the archive step moves every unconsumed signal outside the window to the archive, and nothing undoes it; the trial deadline, the staleness window (90 days, 7 for decayed chains), confidence freshness and the guardrail's minimum age are all one jump; the cross-topic rule allows one promotion per owner per calendar day of the run; the rollup ladder fires one envelope for any backlog.
2. The pass keeps no boundary. The inbox layout (inbox, processed, archived) is the only record of what was consumed. The evidence log is read whole on every pass and sorted by wall-clock strings.
3. The store gives one stable read position: a byte offset inside a device's shard (`readShard` returns `nextOffset`, holds back an unverified last line, and reports gaps). A record that syncs late lands in its device's shard after what was read there, or in a new shard. A clock is not a position: a late record carries an earlier clock than records already read. Compaction replaces shards and invalidates their offsets.
4. Nothing in the store is a work queue. The rollup ladder emits a `needs-llm-step` envelope that nothing brings an answer back for. The decide pass (closed questions to a decision model) asks newest first inside eight weeks under a 20 second budget and falls back to the fixed rule on every failure.
5. The pass is idempotent by planning nothing on a rerun, not by idempotent writes: a second identical log append would duplicate.

## Questions

1. What is a window, at which instant is it evaluated, and what does replaying it mean?
2. What is "the same result as daily runs" measured against?
3. What is a position, and what does a record that arrives after its day was covered get?
4. What is coverage, when does it advance, and what must a new owner have before it continues?
5. How does a window survive a crash in the middle?
6. How far back does a brain that predates this change start?
7. What bounds the cost of a long gap and of one large window?
8. What about a brain that is not on the store?

## Decisions

Each gives the author's first answer, the partner's finding, and what was decided. The partner was an agent of another model family than the author, run read-only against main at its highest reasoning setting; it was asked to attack, and it found the author's central claim false as first written.

### Windows and evaluation instants

1. **A window is one day, counted as the code counts days today (UTC), and each window stores its bounds.** The author proposed the civil day of the configured time zone. Partner: daily accounting is UTC today (`src/core/brain/time.ts`), and a zone change in the middle of a gap would move records between days. Decided: UTC days in this change; the window record stores its UTC bounds, so a later change of the day's definition cannot reinterpret old windows.
2. **A past window is evaluated at its end; today's window is evaluated at the real moment of the run.** The author evaluated every window at its end. Partner: that changes an ordinary morning run (a signal that expires at noon is promoted at 09:00 today and would not be at 23:59). Decided as stated: a run with no gap has one window, today's, and behaves exactly as it does now. This is a requirement with its own test: every existing dream test passes unchanged.
3. **Every reader inside a window uses the same present.** Partner: several steps reread evidence on their own (the freshness trend, the preference bodies at apply), and the rollup plan sees the preferences before the window's promotions. Decided: the virtual present and the admitted input set are one value passed to every step of the pass, and a test fails when a step of the pass reads the clock or the log outside it.
4. **Real time is kept only as a fact about the run.** Partner: the run id is part of the rollup target path, so real time leaks into durable identity. Decided: a window's effects have logical identities built from the window and the effect's subject, independent of the run's time and of the owner revision; the run id and the real time are separate fields of the audit record; provenance points at the audit record of the window.
5. **Windows are processed oldest first, one at a time.** Partner: sound.

### Every day, no skipping

6. **Every day of the gap is replayed.** The author proposed to replay only the days on which something can change. Partner: confidence decays continuously, the guardrail's minimum age and the next day's cross-topic allowance change outcomes on days with no input and no listed deadline (three signals on the first, a minimum age of three days: the daily run promotes on the fourth, a skipping replay never visits it). Decided: every day, under a resumable budget. Skipping days is an optimisation for a later change, and only once each rule that reads the present states its own next day of change. The cost of a long gap is measured in this change's report.

### What "the same as daily runs" means

7. **The oracle is daily runs over the same admission history, not the same final set of records.** The author claimed that daily runs and one replay over the same inputs end in the same records. Partner: false. With late sync the daily machine acted before a record arrived (it archived two signals before the third came; it retired a trial before the evidence synced), and no replay can or should undo that. Decided: every record has an event time (its own) and an admission window (the first window in which this brain's dream could see it). The acceptance test builds a history with an admission schedule and compares (a) daily runs, each seeing the records admitted by its day, with (b) one replay given the same schedule: same promotions, retirements, archive moves, counters, deadlines, ledgers and queue items. Run times and run ids are allowed to differ.
8. **Human changes made during the gap apply from the first replayed window.** Partner: the rest of the state (preferences edited or retired by hand, settings, merges) is today's state, and reading it inside an old window leaks the future into the past. Decided, as the author's own call: the state at the start of a replay is the state the last covered window left plus what people changed since; a person's change is authoritative and is not replayed around. Changes that dream itself makes are made window by window. The spec says so in plain words, and the equivalence test holds human changes fixed.

### Positions and admission

9. **A position is (store, partition, stream, device, shard, byte offset) with a hash of the verified prefix.** The author kept an offset. Partner: an offset alone is unsafe after a shard is replaced; the incremental reader already verifies the old prefix (`src/core/store/read/stream-read.ts`). Decided as stated.
10. **Admission is recorded before anything depends on it.** The author wrote the late records' effective times together with the coverage record, after the effects. Partner: a crash between apply and coverage loses the admission decision the effects were built on. Decided: a window starts by writing an admission record: the frozen positions (the window's input boundary) and, for every record first seen now whose event day is already covered, its admission window. Effects come after it.
11. **What a late record gets.** A late signal counts in the windows from its admission on, and is never archived unseen. It does not reopen what already happened: signals already archived or consumed stay so (the partner's example of two archived signals and a late third ends, as with daily runs, with the third alone in the inbox). Late evidence keeps its event time for staleness and confidence. Evidence whose event time is after a trial's deadline cannot confirm that trial (the partner showed the code does not check this today and a day-end evaluation would confirm a trial the daily run retired); evidence in time for a trial that was already retired produces a named reconciliation outcome in the audit record and in the digest, and does not silently revive the rule.
12. **A record dated in the future is admitted now.** Partner: the window filter has no upper bound today, so a skewed clock's record counts at once in a daily run; restricting inputs by event time would hide it until its date. Decided: event time later than the real moment of admission is clamped to the admission window, as today.
13. **A gap stops coverage.** A shard with a pending blob, a corrupt line or an unreadable state does not advance its position, and a window whose inputs had a gap is not covered. Partner: sound; use the reader's own classification, including its torn-tail and quarantine distinctions.
14. **Compaction.** The author rebased by record identity. Partner: once the old shards are gone their offsets cannot name the records that were consumed, and the compaction record holds no such mapping. Partner's answer: stop coverage and report. Decided differently, as the author's call, because the owner asked for a dream that needs no attendance: when a shard a position names was replaced and its prefix cannot be verified, every record in the replacing shards whose event day is already covered is taken as seen, the positions are rebased to the ends of those shards, and the audit record and doctor state how many records could not be told apart. What can be lost is only the late-arrival treatment of records that reached this machine between the last pass and the compaction. Coverage does not stop.

### Coverage, commits and transfer

15. **A window is a small transaction with a recoverable plan.** The author relied on "a rerun plans nothing". Partner: false today: cross-topic preferences are written before the daily budget ledger, so a crash lets a retry spend the same day's slot on a second promotion. Decided: after admission the pass writes the window's plan record (its effects by logical identity); apply writes each effect idempotently by that identity; the audit record and then the coverage record close the window. A restart with an open window finishes that plan instead of planning again.
16. **The ledgers the pass keeps move into the store.** Partner: the rollup and cross-topic ledgers are device-local on a switched machine, so a new owner starts with empty ones and repeats rollups or spends budgets twice. Decided: both become records in the shared partition, written as effects of the window, and the cross-topic budget is judged against the window's day.
17. **Coverage is a record in the shared partition, keyed by window, not by owner revision.** The author keyed the audit record by window and owner revision. Partner: that duplicates one logical window across a transfer. Decided: one window, one identity, whoever ran it; the owner and the run are fields.
18. **A new owner waits for the old owner's last commit.** Partner: the release can reach the new machine before the coverage, the effects and the queue records do; the owner revision does not help. Decided: the release record of the owner role names the last committed window and its admission record; the new owner does not replay until it holds those records and can read every shard the admission record names. Until then it reports that it is waiting for sync. This adds a field to the release record of `agent-neutral-dream`.
19. **Three facts, not one.** The author exposed a covered day and queue counts. Partner: queued work is not finished work, and one day cannot say which chain or topic is unfinished. Decided: the status has the last admitted position, the last evaluated window and what model work of which windows is unfinished (from the queue). The trigger change decides what closes a day from these.

### Budget

20. **Budget is checked inside a window as well.** The author checked it between windows. Partner: one enormous window is unbounded, and the code already checkpoints between preference writes. Decided: the plan record makes a window resumable, so the budget may stop a window between effects; the next pass continues it.

### A brain that predates this change

21. **The first run inventories everything retained, in pages.** The author started at the oldest unconsumed signal. Partner: that misses evidence-only histories, existing deadlines and retained archived candidates, and with an empty inbox there is no start at all; and a window loop is not paging. Decided: a bootstrap with its own durable cursor reads the retained inputs in pages and freezes the initial positions. The first window is the day of the oldest retained input that can still change an outcome (an unconsumed signal, an archived signal inside the window of an unconsumed one, evidence of an active trial), and never later than the day of the last pass the audit log shows. What cannot be recovered (signals archived before the replay existed that may have qualified for a promotion) is counted and reported once.

### Not on the store

22. **A brain whose records are still vault files runs the single pass of today and is never reported as covered.** Partner: the migration must hand over explicitly, or a last legacy pass archives the backlog first. Decided: once this change is installed a legacy pass no longer archives signals outside the window (it reports them instead), and the bootstrap runs after the switch to the store is verified.

## Rejected

1. A boundary by clock (the last run's time, or a logical clock watermark). A late record carries an earlier clock and would be skipped.
2. One scan with widened windows. It keeps evidence from being archived but still judges every deadline in one jump.
3. Skipping days on which nothing can change. Not provable today (decision 6).
4. Equality of final records as the oracle. False under late sync (decision 7).
5. Coverage in machine-local state. A transfer of the owner would restart or skip.
6. Stopping coverage after a compaction that cannot be verified (the partner's proposal). It would need a person; the bounded loss is reported instead (decision 14).
7. A full historical snapshot of every kind of state for each window (the partner's widest reading). Human changes are authoritative from the first replayed window (decision 8); reconstructing past human state would be a second product.

## Partner

The partner judged the author's 25 first answers (replay and queue together): 5 sound, 8 underspecified, 12 flawed, and gave ten dated counterexamples to the equivalence claim. All findings were applied except two, where the author decided otherwise and says why: compaction (decision 14) and the depth of the historical read (decision 8). The inventory was corrected on four points the partner found: workruns do not resume, archived signals stay readable, a failed or unasked question is not entered in the asked set, and four weeks do not exceed the eight-week lookback.
