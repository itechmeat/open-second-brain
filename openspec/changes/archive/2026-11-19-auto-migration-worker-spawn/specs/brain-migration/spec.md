# Spec Delta

## Purpose

The automatic store migration worker starts under the runtime that runs the
start, never one looked up on PATH, and a worker that cannot run is a
recorded failure, never a silent "pending". A device's last evidence takes
the newest row time of every shard naming scheme, and every surface names
the devices still on the legacy layout from one judgement of the cohort.

## MODIFIED Requirements

### Requirement: A silent device counts as retired
A cohort device that has not switched SHALL count as retired by silence when its last evidence of life is older than the shared setting `migration.silent_device_days` (default 30; 0 turns the rule off). Its last evidence SHALL be the newest of its legacy shard name dates, their row times and the clocks of its store records, or else the earliest cohort record naming it; file modification times SHALL NOT be evidence. For every shard naming scheme the newest row time SHALL date the shard when it is later than the name's period (a day, a month, an ISO week), which SHALL only be a floor; a row time is any top-level ISO 8601 time field of the row (`ts`, `timestamp`, `time`, `at`, any `*_at` or `*At` field) except one that names a time still to come (an expiry, a retry, a schedule).

#### Scenario: A monthly shard whose rows are later than the month
- **WHEN** a device's only shard is a continuity shard named for the month and its newest row carries `createdAt` four days into that month
- **THEN** its last evidence is that row time, not the month's first day, wherever the status, the doctor and the dry run show it

#### Scenario: An id with no dated trace
- **WHEN** the cohort record names device D and no legacy shard or store record of D carries a date
- **THEN** D is retired by silence once the threshold has passed since the cohort record, and an id named by no cohort record and with no date is never retired by silence

### Requirement: The state of each cohort device is shown and derived
The retirement by silence SHALL be derived on every read and never recorded: a device that writes again SHALL be pending again at once when what it writes carries a date within the threshold of the reference (a date later than the reference counts as the reference), and a write stamped older than that SHALL leave it retired by silence. Doctor and the store status SHALL list each cohort device as switched, pending with its last evidence date, or retired by silence with the date and the threshold, and once none is pending SHALL say, as advice and not as a warning, that the legacy tree can leave the vault and name the removal command. Every surface that names the devices still on the legacy layout (`o2b brain migrate-store` on a switched machine, text and `--json`, the removal report, doctor, the store status) SHALL take them from that one judgement: a device retired by silence SHALL NEVER be named as still on the legacy layout.

#### Scenario: The transition report on a switched machine
- **WHEN** `o2b brain migrate-store` runs on a switched machine whose cohort holds a pending device and devices retired by silence
- **THEN** its line of devices still on the legacy layout and its `legacy_devices` name the pending device only, with its last evidence date, and the devices retired by silence are named apart, as the doctor and the status name them

#### Scenario: A stale id stops holding the tree
- **WHEN** device C last wrote 40 days before the newest evidence of the store and the threshold is 30
- **THEN** doctor lists C as retired by silence with its last evidence date and the threshold, and says the legacy tree can leave the vault with `o2b brain migrate-store --remove-legacy`

#### Scenario: A retired device writes again
- **WHEN** device C, retired by silence, writes a legacy log shard dated today while the tree is still in the vault
- **THEN** doctor lists C as pending again and the removal without `--force` refuses and names it

#### Scenario: A device that returns on the new release after the removal
- **WHEN** device C, retired by silence, updates after the tree left the vault and its local copy of the tree is gone
- **THEN** it writes the store only by the no-legacy-tree rule and its start records no switch from the removal record, because a vault without its tree carries no identity marker to match that record to and another vault whose tree has not arrived yet looks the same; `o2b init --vault` on that machine records its switch, and only records it wrote after its last sync and never synced are lost

### Requirement: The automatic migration runs in its own process
The automatic migration SHALL NOT run inside the session start hook or the MCP server process. Detection at a start SHALL be a cheap read when nothing is to do; the migration itself SHALL run in a detached worker process that one per-vault, per-machine lock admits, and a slow or hung worker SHALL NOT delay the start. The worker SHALL run under the runtime that runs the start, named by its absolute path, never one looked up on PATH, and SHALL be detached on every platform so it outlives the start's process and its terminal. A worker that cannot be started, or that exits before it confirms the claim it was handed, SHALL be recorded as a failed attempt (with the spawn error, or with its exit and the tail of its error output and the device-local log that holds it) under the retry and cooldown rules, and status, doctor and the session start notice SHALL say so with the manual command; such a worker SHALL NEVER leave a silent "pending".

#### Scenario: A start with no Bun on PATH
- **WHEN** a session starts under an absolute runtime path while PATH holds no Bun (an ssh session, an agent a macOS GUI started)
- **THEN** the worker starts under that runtime and runs its attempt to its outcome

#### Scenario: A worker that exits before it starts
- **WHEN** the worker a start spawned exits before it confirms its claim
- **THEN** the start that spawned it, when it still runs, or else the next start records a failed attempt naming the worker's process, its exit when seen, its error output and the log; that start starts nothing until the cooldown has run out, and status and doctor name the failure, also before any start recorded it

#### Scenario: Two starts at once
- **WHEN** two agents start at once on one machine while a migration is available
- **THEN** exactly one worker runs (the lock decides), and the other start reports that a worker is already running

#### Scenario: A long or hung worker
- **WHEN** a worker holds the worker lock and its process is still running, however long
- **THEN** later starts report a running worker and are not delayed, and no start takes over the claim of a process that is alive; a day after the claim a start, which reads no process identity, starts a worker that judges the holder by its start identity and takes the claim over only when the holder is gone (a later process that reuses its pid), and a worker whose claim was taken over stops before it writes

#### Scenario: A killed worker
- **WHEN** the worker holding the lock is killed
- **THEN** the lock is free at once (its recorded process is gone), a manual `o2b brain migrate-store` is not refused by it, and two starts taking it over at once leave exactly one holder

#### Scenario: A worker claim that cannot be read
- **WHEN** the worker lock file is there and cannot be read (a permission or an I/O error)
- **THEN** no start and no worker takes it over, however old, and a manual `o2b brain migrate-store` reports the automatic migration as running

#### Scenario: A worker whose claim was taken over while it runs
- **WHEN** a worker's claim is taken over while that worker still runs (its start identity cannot be told and the claim is older than an hour)
- **THEN** the old worker writes nothing more: its attempt record, waits, failures, success outputs, notice, metrics row, log line and the store it would create are each written only while it still holds its claim, checked under the claim's mutex, and the migration itself stays serialised by the migration gate

#### Scenario: A worker with nothing to do
- **WHEN** a worker's first decision, before it claims the lock, is that nothing is to be done
- **THEN** it creates, changes and removes no file before it holds the claim; clearing a record that is moot, or remembering a wait, is decided again and done under the claim

#### Scenario: A read that fails
- **WHEN** the migration gate, the attempt record, this machine's run state (or the store it is kept in), the vault's legacy tree or the worker claim cannot be read right now
- **THEN** the read is never taken as absent: a gate that cannot be read holds, a record that cannot be read is reported as a failure, a run state that cannot be read is never migrated over, a legacy tree that cannot be read is not "nothing to migrate", and a claim that cannot be read is never taken over or written under
