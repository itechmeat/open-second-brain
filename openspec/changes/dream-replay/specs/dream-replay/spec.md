# Spec Delta

## Purpose

What a dream pass covers after any length of silence: the windows it evaluates and at which instants, what a record that arrives late is given, when coverage advances, how an interrupted window and an owner transfer continue, and what the first run on an existing brain does.

## ADDED Requirements

### Requirement: Missed days are replayed oldest first

When days are not covered, a pass SHALL evaluate each of them as its own window, oldest first, each past window at its end and today's at the real moment of the run. Every rule of the pass that reads the present SHALL read the window's instant, and every rule that counts per day SHALL count against the window's day. Each window SHALL see the state the previous window left.

#### Scenario: Evidence would have been archived

- **WHEN** three matching signals arrived on one day, the brain was silent for three weeks, and a pass runs
- **THEN** the rule is promoted in the window in which daily runs would have promoted it, and the signals are consumed, not archived

#### Scenario: A deadline inside the gap

- **WHEN** a trial's deadline passed during the silence and no evidence for it is dated before the deadline
- **THEN** the trial is retired in the window of its deadline, not in today's

#### Scenario: A per-day allowance

- **WHEN** two clusters competed for one cross-topic promotion per day and the brain was silent for ten days
- **THEN** one is promoted in the first window and the other in the second, as daily runs would have done

### Requirement: The reference is daily runs over the same admission history

The admission window of a record is defined by this specification, not observed: it is the record's event day, unless the record is first seen when that day is already covered, in which case it is the first window still open. For any history, one replay SHALL end in the same promotions, retirements, archive moves, counters, deadlines, ledgers and queued model work as daily passes in which each record becomes visible on that admission window. Changes made by a person are held fixed in this comparison. Run identifiers and real run times MAY differ.

#### Scenario: Replay equals daily

- **WHEN** a generated history of several weeks is processed once by daily passes and once by a single replay with the same admission schedule
- **THEN** the two brains hold the same records apart from run identifiers and run times

### Requirement: A person's changes apply from the first replayed window

The state a replay starts from SHALL be what the last covered window left plus what people changed since. A change made by a person during the gap SHALL apply to every replayed window and SHALL NOT be replayed around.

#### Scenario: A rule retired by hand during the gap

- **WHEN** a person retired a rule last week and a replay covers the last three weeks
- **THEN** the rule is retired in every replayed window

### Requirement: A late record counts from its admission and reopens nothing

A record first seen after its event day was covered SHALL be admitted to the first window still open. A late signal SHALL count from that window on and SHALL NOT be archived before a window has considered it. Signals already consumed or archived SHALL stay so. Late evidence SHALL keep its event time for staleness and confidence. A record dated later than the moment it is admitted SHALL be treated as dated at its admission.

#### Scenario: A late third signal

- **WHEN** two signals were archived by earlier windows and a third matching one from another machine arrives late
- **THEN** the third is considered alone in the windows after its admission, and the two stay archived

#### Scenario: A signal that arrives older than the window

- **WHEN** a signal whose event time is older than the contradiction window is first seen
- **THEN** it is counted in the window of its admission and is not archived by that window's archive rule

#### Scenario: A clock ahead

- **WHEN** a record dated weeks in the future is admitted today
- **THEN** it counts today, as it did before this change

#### Scenario: A clock behind

- **WHEN** the machine's clock reads a day earlier than a window already admitted or covered
- **THEN** the pass evaluates no window, writes nothing, and says why until the clock reaches that day

### Requirement: Unknown input stops coverage

A source whose read is incomplete (a pending blob, a corrupt line that is not a torn tail, an unreadable shard) SHALL NOT advance its position, and a window whose inputs were incomplete SHALL NOT be evaluated or covered. The status and doctor SHALL name the source. When the same source stays incomplete for three days, the replay SHALL go on without its new records, SHALL report which source was left out, and SHALL admit those records as late when the source can be read.

#### Scenario: A shard with a pending blob

- **WHEN** a shard the window needs has a record whose blob has not arrived
- **THEN** the window is not evaluated, the next pass tries it again, and doctor names the shard

#### Scenario: A gap that lasts

- **WHEN** the same shard has been incomplete for three days of passes
- **THEN** the replay continues without its new records, the audit record and doctor name the shard, and its records are admitted as late once it can be read

### Requirement: A replaced shard is rebased and the loss is reported

When a shard a position names was replaced by compaction and its prefix cannot be verified, the pass SHALL treat every record in the replacing shards whose event day is already covered as seen, SHALL continue, and SHALL report in the audit record and in doctor how many records could not be told apart.

#### Scenario: Compaction between two passes

- **WHEN** a shard was compacted away after the last pass
- **THEN** the next pass continues from the replacing shards and reports the number of records it took as seen

### Requirement: A window is finished once, whatever interrupts it

A window SHALL record what it admitted before anything depends on it, then its plan, then its effects, then its audit record, then coverage. An effect SHALL be identified by the window and its subject, independent of the run and of the owner, and applying it twice SHALL have one result. A pass that finds an open window SHALL finish that window's plan and SHALL NOT plan it again.

#### Scenario: A crash between an effect and its ledger

- **WHEN** the process ends after a cross-topic promotion was written and before the window was covered
- **THEN** the next pass finishes the same plan, and the day's allowance is spent once

#### Scenario: A crash before the audit record

- **WHEN** the process ends after all effects and before the audit record
- **THEN** the next pass writes one audit record for the window and covers it

### Requirement: Coverage belongs to the brain

Coverage, admission, window plans and the ledgers the pass keeps between windows SHALL be records in the brain store, identified by window and not by owner. After a transfer the new owner SHALL continue from the last covered window and SHALL NOT start until it holds the last window the previous owner committed and can read every source that window admitted from; until then it SHALL report that it waits for sync.

#### Scenario: A transfer in the middle of a replay

- **WHEN** the owner is transferred after the fifth of ten missed windows was covered
- **THEN** the new owner starts at the sixth, repeats no rollup and spends no allowance twice

#### Scenario: The release arrives before the records

- **WHEN** the new owner holds the release and not yet the last covered window it names
- **THEN** it runs no window and reports that it waits for sync

### Requirement: A budget stops a pass without losing work

A pass SHALL have a budget. When it is spent, between windows or inside one, the pass SHALL stop with every finished effect durable and SHALL leave the rest to the next pass.

#### Scenario: One very large window

- **WHEN** the budget is spent in the middle of applying a window
- **THEN** the pass ends, and the next pass applies the remaining effects of the same plan

### Requirement: An existing brain starts from its retained history

On a brain with no coverage, the first pass SHALL inventory the retained inputs in resumable pages, freeze the initial positions, and start at the day of the oldest retained input that can still change an outcome, never later than the day after the last pass the audit log shows to have changed something. It SHALL report once what cannot be recovered.

#### Scenario: A backlog in the inbox

- **WHEN** a brain with signals of the last two months in its inbox and no coverage runs its first pass
- **THEN** the windows from the oldest of those signals on are replayed in order, and nothing is archived before its window

#### Scenario: An empty inbox

- **WHEN** a brain with no unconsumed signal and no coverage runs its first pass
- **THEN** coverage starts at the day after its last pass that changed something and the pass completes

#### Scenario: An interrupted inventory

- **WHEN** the first pass is stopped in the middle of the inventory
- **THEN** the next pass continues from the page it reached

### Requirement: Timely evidence that arrives after a retirement is recorded

Evidence dated before a trial's deadline that is admitted after the trial was retired SHALL be recorded as a reconciliation outcome in the window's audit record and in the digest, and SHALL NOT revive the rule by itself.

#### Scenario: A reconciliation is recorded

- **WHEN** evidence dated before a trial's deadline is admitted after the trial was retired
- **THEN** the window's audit record and the digest name the rule and the evidence, and the rule stays retired

### Requirement: A staged pass waits for the replay

While windows are behind, staging, validating, applying and re-triaging a staged pass SHALL be refused with the number of windows behind and the command that replays them. With coverage at yesterday a staged pass SHALL work as before.

#### Scenario: Staging after a silence

- **WHEN** a staged pass is requested and three windows are behind
- **THEN** it is refused, names the three windows and the command, and writes nothing

### Requirement: The status tells three things apart

The dream status SHALL report, separately, the last admitted position, the last evaluated window with the number of windows still behind, and the model work of which windows is unfinished. A window whose model work waits SHALL NOT be reported as completed.

#### Scenario: Behind after a long gap

- **WHEN** a pass stopped on its budget with eight windows left
- **THEN** the status says eight windows are behind and names the last covered day

### Requirement: A brain that is not on the store is never reported as covered

Nothing of the replay SHALL run on a brain whose records are not yet in the store, and no surface SHALL call its passes covered. The first live pass after the switch to the store SHALL be the inventory.

#### Scenario: The first pass after the switch

- **WHEN** a brain is switched to the store and a live pass runs
- **THEN** that pass inventories the retained inputs and starts the replay
