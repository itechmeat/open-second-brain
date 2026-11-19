# Spec Delta

## Purpose

Brain migration moves an existing install whose machine data lives in `<vault>/Brain/` into the brain store and the human view, safely for every user of the public product, without losing evidence and without breaking agents mid-transition.

## ADDED Requirements

### Requirement: One migration command
The product SHALL ship one migration command that converts an existing legacy brain (every `Brain/` lane and the per-vault state under `.open-second-brain/`) into the brain store and the human view. The command SHALL be idempotent and resumable: re-running it after an interruption SHALL continue where it stopped and SHALL never duplicate records. After an update, the product SHALL run the migration automatically on a machine that has not migrated and has not opted out; with the opt-out set (`auto_store_migration: false` in the machine config) the upgrade SHALL offer it but SHALL NOT start it. The opt-out SHALL govern only starting a migration: finishing an automatic attempt that already started (a switch that did not finish, or a run killed while it held the migration gate) is not a new migration, asks no consent, and SHALL run whatever the opt-out says. The opt-out SHALL fail closed: on only for `true`, `1`, `yes`, `on`; off for `false`, `0`, `no`, `off` (any case, surrounding space and a trailing inline comment ignored); any other value, or a machine config that cannot be read, SHALL count as off and SHALL be named by the doctor and the status block. When the config key or the environment variable says off, it SHALL be off. A machine that opted out SHALL still see the offer in the doctor, the status block, the session start notice, `o2b update` and the `o2b brain upgrade --dry-run` plan.

#### Scenario: Interrupted migration
- **WHEN** the migration is killed halfway and run again
- **THEN** it continues from the last verified item, and the store holds every legacy record exactly once

#### Scenario: Upgrade on a legacy install with the opt-out
- **WHEN** a user who set `auto_store_migration: false` upgrades to the release on a legacy layout
- **THEN** status and doctor say a migration is available and name the command, and nothing moves until the user runs it

#### Scenario: An unrecognised opt-out value
- **WHEN** the machine config holds `auto_store_migration: maybe`, or the environment says `1` while the config says `false`
- **THEN** nothing moves, and the doctor and the status block name the value they did not recognise (in the first case)

#### Scenario: Upgrade on a legacy install with the default
- **WHEN** a user upgrades to the release on a legacy layout with no opt-out set
- **THEN** the update names the migration it is about to run and the next session start (or the update itself) runs it, and the machine reports `done` when it has switched

### Requirement: Dry run first
The migration command SHALL support a dry run that writes nothing and reports, per source path, how many items would move, to which stream or view page, and which items it cannot map.

#### Scenario: Dry run on a live install
- **WHEN** the user runs the migration with the dry-run flag
- **THEN** no file changes anywhere, and the report lists counts per source and every unmapped item

### Requirement: Quiesce and back up before moving
A real migration SHALL first stop this machine's legacy writers through a device-local gate that drains in-flight writes, then snapshot the `Brain/` tree and back up every non-rebuildable per-vault surface (secrets, keys, attestations, checkpoints) explicitly, verify each backup by a test restore, and SHALL refuse to start if any step fails. Writes attempted on this machine during the migration SHALL be refused with a message saying a migration is in progress.

#### Scenario: Agent writes during migration
- **WHEN** an agent on the migrating machine records feedback mid-migration
- **THEN** the call is refused with a migration-in-progress message and nothing is written to the legacy tree

#### Scenario: Snapshot fails
- **WHEN** the snapshot cannot be written because the disk is full
- **THEN** the migration stops before moving anything and says why

### Requirement: Every writer of the vault is refused while the gate names it
While this machine's migration gate names a vault, every write into that vault SHALL be refused: from any CLI verb, MCP tool, hook or background worker, on every path (content, Brain log and audit records, per-vault state, caches kept in the vault). The rollback and the legacy tree removal hold the same gate and SHALL refuse the same writes. Only the run's own snapshot SHALL pass. Writes into another vault SHALL proceed.

#### Scenario: A log note during migration
- **WHEN** `o2b brain note` or `brain_note` runs on the migrating machine mid-migration
- **THEN** it is refused and no Brain log file is written or changed

#### Scenario: Another vault's migration
- **WHEN** the gate on this machine names another vault
- **THEN** writes into this vault proceed

#### Scenario: A hook during migration
- **WHEN** the session start, prompt or stop hook runs while the gate names the vault
- **THEN** the hook exits successfully, writes nothing into the vault, and shows at most one notice line

### Requirement: The refusal says what runs and what to do
The refusal SHALL name the run that holds the gate (a migration, its rollback or the legacy tree removal), since when it holds it, how far it is when the run reported that, and, when its process is gone, what continues it: the next start for an automatic migration, or the command. An MCP caller SHALL receive the structured refusal `migration_in_progress` saying whether to retry later or to recover the run first.

#### Scenario: A running migration
- **WHEN** a write is refused while the migration runs
- **THEN** the message names the migration, since when it runs and its progress, and an MCP caller is told to retry later

#### Scenario: A stopped migration still holds the gate
- **WHEN** the migration's process is gone and its gate remains
- **THEN** a write is refused with a message saying the run stopped, that the next start continues an automatic migration, and naming `o2b brain migrate-store --resume`

### Requirement: Verified counts
After converting, the migration SHALL re-scan every source and import whatever changed or grew since it was journaled, repeating until a pass imports nothing. It SHALL then verify that every source record exists in the store with the same content checksum, and SHALL report the counts.

#### Scenario: Verification mismatch
- **WHEN** one signal fails to appear in the store
- **THEN** the old tree is left in place, and the report names the missing item

### Requirement: Machine-data removal from the vault
After the legacy tree leaves the vault, the vault SHALL contain no Open Second Brain machine data; only the human view, if targeted there, SHALL remain. The legacy tree SHALL be archived to device-local state and never deleted automatically.

#### Scenario: Archived, not deleted
- **WHEN** the legacy tree leaves the vault
- **THEN** a dated copy exists in device-local state and nothing was deleted

### Requirement: Removal waits for the migration cohort
The legacy tree SHALL leave the vault only when every device in the durable migration cohort (every device id found in the legacy tree) has switched, been retired by a human record, or been retired by silence, or when the user forces it with a report naming the devices that will stop receiving data. The removal SHALL stay the user's command: nothing SHALL remove the tree automatically. The removal report (text and `--json`) SHALL name the devices that switched and, apart from them, each device retired by silence with its last evidence date, and the `legacy-tree-removed` record SHALL carry the devices retired by silence and the threshold.

#### Scenario: All machines switched
- **WHEN** every roster device has switched and the view target is inside the vault
- **THEN** the vault holds the view folder and the user's own notes, and no other Open Second Brain file

#### Scenario: One machine still on the old release
- **WHEN** machine B has not upgraded yet and wrote within the threshold
- **THEN** the legacy tree stays in the vault, B keeps working on it, and doctor on upgraded machines names B as pending with its last evidence date

#### Scenario: A device id of a machine that no longer exists
- **WHEN** the cohort names device C, whose last evidence is older than the threshold, and every other cohort device switched
- **THEN** the removal without `--force` moves the tree, its report names C as retired by silence with its last evidence date, and the `legacy-tree-removed` record lists C

#### Scenario: The rule turned off
- **WHEN** `migration.silent_device_days` is 0
- **THEN** no device is retired by silence and the cohort has no age limit

### Requirement: Machines migrate independently
Each machine SHALL switch to the store when the user runs the migration on it. A later machine SHALL wait until its copy of the store holds every record named in the first machine's completion record, then import its own legacy records that the store lacks (matched by checksum), move its own device-local state and record that it switched.

#### Scenario: Second machine holds records the first never saw
- **WHEN** machine B migrates after A, and B's legacy tree holds signals that never synced to A
- **THEN** B imports exactly those signals, the store holds every record once, and B records that it switched

#### Scenario: Completion record arrives before its data
- **WHEN** B receives A's completion record before the store files it names
- **THEN** B's migration waits and reports what it is waiting for, and proceeds once the files arrive

### Requirement: Transition reads
Until the legacy tree leaves the vault, a switched machine SHALL import new or grown legacy records written by machines not yet switched, line by line, exactly once. It SHALL never write into the legacy tree.

#### Scenario: Old machine keeps writing
- **WHEN** a not-yet-upgraded machine writes a signal into the legacy `Brain/inbox/`
- **THEN** an upgraded machine imports it into the store once, and doctor reports the old machine's device id as still on the legacy layout

### Requirement: Legacy tree regeneration is detected
Doctor SHALL report when a legacy `Brain/` machine directory reappears in the vault after migration, and SHALL name the writer when the file carries one. When the reappeared files name a device that the removal record lists as retired by silence, the report SHALL say so and SHALL tell the user to update that machine, whose migration then imports its legacy records as a later machine.

#### Scenario: Agent follows stale instructions
- **WHEN** an agent creates `Brain/preferences/` in the vault after migration
- **THEN** doctor reports the directory and the agent name found in it

#### Scenario: A device retired by silence comes back on an old release
- **WHEN** device C, retired by silence when the tree left, writes a legacy log shard into the vault again
- **THEN** doctor reports the directory, names C as retired by silence and says to update that machine and remove the tree again afterwards

### Requirement: A silent device counts as retired
A cohort device that has not switched SHALL count as retired by silence when its last evidence of life is older than the shared setting `migration.silent_device_days` (default 30; 0 turns the rule off). Its last evidence SHALL be the newest of its legacy shard name dates, their row times and the clocks of its store records, or else the earliest cohort record naming it; file modification times SHALL NOT be evidence. For every shard naming scheme the newest row time SHALL date the shard when it is later than the name's period (a day, a month, an ISO week), which SHALL only be a floor; a row time is any top-level ISO 8601 time field of the row (`ts`, `timestamp`, `time`, `at`, any `*_at` or `*At` field) except one that names a time still to come (an expiry, a retry, a schedule).

#### Scenario: A monthly shard whose rows are later than the month
- **WHEN** a device's only shard is a continuity shard named for the month and its newest row carries `createdAt` four days into that month
- **THEN** its last evidence is that row time, not the month's first day, wherever the status, the doctor and the dry run show it

#### Scenario: An id with no dated trace
- **WHEN** the cohort record names device D and no legacy shard or store record of D carries a date
- **THEN** D is retired by silence once the threshold has passed since the cohort record, and an id named by no cohort record and with no date is never retired by silence

### Requirement: The age of a device is measured against the evidence
The age of a device's last evidence SHALL be measured against the newest evidence of any device that is not later than this machine's wall clock, evidence later than the wall clock SHALL be left out of that reference rather than taken as the wall clock, and evidence later than the reference SHALL count as the reference, so a wrong clock is bounded by the dates actually written.

#### Scenario: A clock far in the future on another machine
- **WHEN** a device's rows carry a time years ahead of this machine's clock
- **THEN** that device counts as alive now and no other device is retired because of it

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

### Requirement: Path discovery for outside readers
The CLI and MCP server SHALL expose the current store root and view target, so skills, hooks and plugins resolve paths by asking instead of hard-coding them. Shipped skills SHALL refer only to tools and these commands, never to store file paths.

#### Scenario: Plugin asks for the store path
- **WHEN** a plugin runs the store path command
- **THEN** it receives the absolute store root and view target for the current config

### Requirement: Rollback
The user SHALL be able to roll a machine back to the legacy layout until the legacy tree leaves the vault. Rollback SHALL restore the snapshot and backups, then replay into the legacy layout, in fold order and idempotently, every store record whose identity is absent from the restored tree, including remote records delivered after the snapshot. Record kinds with no legacy form SHALL stay in the store and SHALL be listed in the report.

#### Scenario: Rollback after a bad migration
- **WHEN** the user rolls back a machine on which agents recorded feedback and notes after the switch
- **THEN** the legacy tree holds the pre-migration state plus those new records, and the machine runs on the legacy layout again

#### Scenario: Records with no legacy form
- **WHEN** topics were created after the switch and the user rolls back
- **THEN** the topics stay in the store, and the rollback report lists them

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

### Requirement: A start runs no subprocess to judge a running worker
A start, and the session notices, SHALL judge a held worker lock or migration gate by its process id and its age alone and SHALL start no subprocess to read a process's start identity; the exact identity check SHALL be left to the worker and the manual command.

#### Scenario: A live migration of another vault
- **WHEN** a session starts while a migration of another vault holds this machine's migration gate
- **THEN** no automatic migration of this vault starts, and this vault's managed-file upgrade still runs, because that gate refuses no write to this vault

#### Scenario: A start while a worker runs on a platform whose identity query is a subprocess
- **WHEN** a session starts on Windows or macOS while a worker holds the lock or a migration holds the gate, younger than the age a live holder is trusted for (a day; an hour for a worker claim that records no start identity)
- **THEN** the start reads files and signals the recorded process id only, starts no PowerShell or `ps`, and starts no worker; past that age it still starts no PowerShell or `ps`, and leaves the exact check to a worker it starts

#### Scenario: A start while a claim is being made
- **WHEN** a session starts while another process holds the worker claim's mutex (making a claim, or judging one by its start identity)
- **THEN** the start does not wait for it and starts no worker

### Requirement: The automatic migration keeps the migration's safeguards
The automatic path SHALL initialise the store when none exists yet, exactly as `o2b store init` does, SHALL refuse when the resolved store root lies inside the vault or cannot be created, SHALL stop before creating anything when the dry run lists an unmapped entry or an unparseable item, or when a cheap preflight fails (the device id, a store that holds `shared`, the free disk, the gate held by another migration), SHALL run the migration through the same function the command line uses, and SHALL resume an interrupted run instead of starting a new one.

#### Scenario: Unparseable legacy item
- **WHEN** the dry run lists an item it cannot parse
- **THEN** the attempt records a refusal that names the item and the dry-run command, and creates nothing; the person decides

#### Scenario: An unparseable item that appears after the dry run
- **WHEN** conversion meets an item it cannot parse that a legacy writer added after the dry run
- **THEN** the automatic attempt refuses before the switch and names the items, the machine stays on the legacy layout with the gate open, and a manual `o2b brain migrate-store` still keeps such items in its backup archive

#### Scenario: Unmapped legacy entry
- **WHEN** the legacy tree holds a file or folder no mapping covers
- **THEN** the attempt records the failure with the reason and the dry-run command, and the migration creates nothing (the managed-file upgrade that runs before the dry run may already have changed the managed files)

#### Scenario: Interrupted automatic run
- **WHEN** a worker is killed during conversion and the machine starts again
- **THEN** the new worker resumes the interrupted run, and the store holds every legacy record exactly once

### Requirement: A failed automatic attempt leaves the machine working
After any failure, throw or kill at any point of an automatic attempt, the machine SHALL be, without a human, either fully on the legacy layout and writable, or brought to fully switched (run done, vault bound, view writer claimed, gate open) by a later start; it SHALL NEVER stay frozen or half switched. The failure SHALL be recorded where the doctor and the status block show it, with the reason, the next automatic attempt and the manual command, and its text SHALL name no home directory. An attempt that cannot write its failure SHALL still hold the next starts off by the record it wrote when it started.

#### Scenario: Failure while the gate is closed
- **WHEN** the migration fails after the gate closed
- **THEN** the gate is open again, the machine reads and writes the legacy layout as before, and the doctor shows the failure with the manual command

#### Scenario: Refusal after a kill with the gate closed
- **WHEN** a worker was killed with the migration gate closed and the next attempt refuses before it takes the gate over (its dry run now lists an unmapped entry or an unparseable item that appeared since, or a preflight fails)
- **THEN** the attempt opens the gate the killed run left, the machine reads and writes the legacy layout, the run stays `in-progress` for a later resume, and the refusal is recorded with the reason and the manual command

#### Scenario: Killed after taking the gate, before the run is on record
- **WHEN** a worker is killed after it took the migration gate and before it saved its run state, so no run state names the gate's run
- **THEN** the next start recognises the gate as a migration run's by its run id and goes on at once, whatever the opt-out and the cooldown say: with the automatic migration on it migrates and takes the gate over; with it off it opens the gate and leaves the machine on the legacy layout, writable

#### Scenario: A stopped gate with nothing left to migrate
- **WHEN** a migration run's gate of this vault is left by a run that is gone and nothing is left to migrate (sync removed the last legacy item)
- **THEN** the next start opens the gate, whatever the opt-out and the cooldown say, and the machine stays on the legacy layout, writable; until then the doctor, the status block and the session notice say that content writes are refused and that the next start opens the gate

#### Scenario: Killed after the refusal was recorded
- **WHEN** an attempt recorded its refusal and was killed before it opened the stopped run's gate
- **THEN** the next start opens the gate whatever the opt-out says and without waiting out the cooldown, and the cooldown of the refusal still holds the next attempt off

#### Scenario: A run state that cannot be read
- **WHEN** this machine's migration run state is there and cannot be read, or the store or the device-local folder that keeps it cannot be read
- **THEN** no automatic attempt migrates (the run could be one the operator rolled back): a stopped migration run's gate of this vault is opened, and the attempt records a wait until the state can be read; a start starts no worker for it and runs the managed-file upgrade itself. On a machine that switched, the switch is not proven finished: nothing is finished, announced or cleared, and an attempt's record stays as it is until the state can be read

#### Scenario: A switched machine whose run state shows no switch
- **WHEN** this machine switched while its migration run state reads as absent or failed, and an automatic attempt's record is there
- **THEN** nothing finishes or announces the switch, which no later read can prove finished, and no start starts a worker for it (a stopped migration run's gate of this vault is still opened, once); the doctor and the status block never report the switch done and name `o2b brain migrate-store`, whose run ends the attempt's record

#### Scenario: A stopped manual run on an opted-out machine
- **WHEN** a manual migration run of this vault was killed with the gate closed and `auto_store_migration` is `false`
- **THEN** the next start opens the gate and starts no migration; the run stays `in-progress` for `o2b brain migrate-store --resume`

#### Scenario: A gate holder that cannot be told, past a day
- **WHEN** the migration gate of this vault was taken more than a day ago and its pid is alive (the run hung, or a later process reuses the pid)
- **THEN** a start, which reads no process identity, starts a worker whatever the opt-out says; the worker recovers the gate only when the holder's start identity shows it is gone, and leaves it closed when the holder still runs or cannot be told

#### Scenario: A gate the attempt could not open
- **WHEN** an attempt refuses or waits after a kill, and opening the stopped run's gate fails (the gate lock busy, or the file system refusing the removal)
- **THEN** the attempt's record keeps the gate owed, so every next start opens that gate at once, instead of honouring the opt-out or a cooldown, until a start finds it gone; once it is open the record is the failure it stands for, with its cooldown; a failed cleanup never replaces the reason the attempt stopped

#### Scenario: An interrupted rollback holds the gate
- **WHEN** an interrupted rollback, or an interrupted removal of the legacy tree, of this vault left the migration gate closed
- **THEN** no automatic attempt resumes the migration over that gate or takes it over, and no start finishes a switch across it; with the automatic migration on, the attempt refuses and names the rollback's or the removal's own command

#### Scenario: Killed between the completion record and the switch
- **WHEN** a worker is killed after `migration-done` was recorded but before `device-switched`
- **THEN** the gate it left is taken over by the next start at once, which resumes the run and finishes the switch without importing anything twice

#### Scenario: Stopped after the switch record
- **WHEN** a worker is killed, or a later step throws, after this device's `device-switched` record
- **THEN** the next start finishes the switch (the switch marker, the vault binding, the view writer, the gate) and announces the migration once

#### Scenario: A switch finished and stopped before its gate opened
- **WHEN** a run finished its switch and was killed before it opened the migration gate
- **THEN** the next start opens that gate

#### Scenario: Another vault's migration switches the machine during an attempt
- **WHEN** an automatic attempt of one vault passed its checks on the legacy layout and a migration of another vault switches this machine before the attempt's own migration starts
- **THEN** the attempt imports nothing of its vault (no settings, no items, no binding) and reports that nothing was needed; that vault's transition is the manual command's, and new legacy records of machines still on the legacy layout reach the store through the automatic transition import

#### Scenario: Another run acts between the checks and the gate
- **WHEN** a migration, a rollback, a removal of the legacy tree or the finish of an interrupted switch passed its checks, and before it takes the migration gate another run switches or unswitches this machine, records, finishes or rolls back a run, or a completion record arrives
- **THEN** once it holds the gate it reads those facts again, and when one changed it stops before its first write, opens only the gate it took and changes nothing else; an automatic attempt whose machine switched meanwhile reports that nothing was needed

#### Scenario: A gate release without the gate lock
- **WHEN** a run ends, finished or stopped, while another process holds the lock beside the migration gate past its wait
- **THEN** the run opens, removes or takes over nothing and reports the gate busy; the gate stays closed until the next start, after the run's process has ended, opens it (and, on a machine the run switched, announces the migration once)

#### Scenario: Another vault configured after the switch stopped
- **WHEN** an automatic attempt stopped after this device's `device-switched` record and another vault is configured before the next start
- **THEN** the next start binds the vault that run migrated and leaves the other vault unbound with nothing of it imported; that vault's transition is the manual command's

#### Scenario: The opt-out switched off after an attempt started
- **WHEN** an automatic attempt stopped after this device's `device-switched` record, or was killed while it held the migration gate, and `auto_store_migration` is then set to `false`
- **THEN** the next start still finishes it (the switch, or the resumed run and the switch), because finishing a started attempt is not a new migration; an attempt that ended on the legacy layout leaves the machine there, writable, and no start begins a migration while the setting is off

#### Scenario: A rolled-back machine
- **WHEN** the operator rolled the machine back with `o2b brain migrate-store --rollback`
- **THEN** no start migrates it again on its own, whatever the setting; status and doctor say it was rolled back (never that the automatic migration is off), and `o2b brain migrate-store` migrates it again

#### Scenario: A rollback that did not finish
- **WHEN** a rollback of this vault began and did not finish (it was killed, or a step failed before it recorded the run rolled back, before or after it cleared this device's switch), so its rollback record is still there, or that record cannot be read
- **THEN** no start migrates, resumes or finishes a migration over it, whatever the setting, because a rollback that began is the operator's choice as much as a finished one; with the automatic migration on the attempt refuses, and status, doctor, the session notice and `o2b update --dry-run` name the reason and `o2b brain migrate-store --rollback`, which finishes the rollback; a stopped migration run's gate of this vault is opened and nothing more; on a machine still switched they also name `o2b brain migrate-store`, which keeps the machine on the store; `o2b brain migrate-store` run by hand ends that rollback's record on either layout: it migrates the vault again, as asked, where the rollback had cleared the switch, and keeps the machine on the store where it had not

#### Scenario: A finished rollback's gate left closed
- **WHEN** a rollback finished every step and recorded the run rolled back, but could not open its migration gate (another process held the gate lock past its wait), and its process has ended
- **THEN** the next start opens that gate, whatever the setting, and migrates nothing, so the machine is writable again on the legacy layout; until then status and doctor say the next start opens it and name `o2b brain migrate-store --force-release-gate`, never a migration

### Requirement: Waiting for another device is not a failure
When this machine migrates after another one and its copy of the store does not yet hold the first machine's whole cut, the automatic path SHALL record a waiting state, SHALL start no cooldown and SHALL write no failure marker, and SHALL try again at a later start until the cut arrives. The waiting state SHALL say what the person does when what it waits for will not arrive.

#### Scenario: Another device's store has not arrived
- **WHEN** this machine has no store and the synced Brain log shows another device's `store-migration` snapshot
- **THEN** the attempt records `waiting`, naming that device and the commands that give this machine a store of its own should that store never arrive, and creates no store; the next starts start no worker until the store arrives or a day has passed

#### Scenario: The first machine's cut has not arrived
- **WHEN** the worker runs while store shards named by the first machine's completion record are still missing
- **THEN** the doctor and the status block show `waiting`, no failure is recorded, and a later start that finds the shards complete runs the migration

#### Scenario: A store that turns unreadable between two reads
- **WHEN** the store reads fine at the first look and cannot be read at the preflight (sync replacing it)
- **THEN** the attempt records a wait, not a failure, and starts no cooldown

### Requirement: The look for another device's migration is bounded
The look for another device's migration in the synced Brain log SHALL read a bounded amount per start however many log shards the vault holds: per other device only its newest shards, and only their ends. While this machine waits for another device's store to arrive, a start SHALL start no worker and read no log shard until that store is there or a day has passed.

#### Scenario: Years of log shards
- **WHEN** the vault holds years of log shards of several devices and this machine has no store
- **THEN** a start reads at most a fixed amount of them, and finds a migration mark another device wrote as its last legacy log line, also when the part read begins exactly at the mark's first byte or inside the mark's line

#### Scenario: A log shard that cannot be read
- **WHEN** this machine has no store and the Brain log folder, or a log shard of another device the look reads, cannot be read right now, comes back shorter than it was, ends in a line sync is still writing, or holds a line too long to read back to its start
- **THEN** the attempt records a wait that names what could not be read, creates no store, and looks again at the next start

### Requirement: Success is announced once
After a successful automatic migration the product SHALL append one line to the brain log and one metrics row, and the next session start SHALL show a one-time notice that the brain moved to the store, where the snapshot is, and how to roll back with `o2b brain migrate-store --rollback`.

#### Scenario: The next session start after a successful migration
- **WHEN** the machine starts a session after the automatic migration succeeded
- **THEN** the digest names the migration, the snapshot location and the rollback command, and a later session start shows none of it

#### Scenario: Two sessions start at once
- **WHEN** two session starts both find the one-time notice
- **THEN** only the session that consumes the notice (one atomic step on its file) shows it; the other leaves it out, and a session whose text could not be assembled leaves the notice for a later start

#### Scenario: A session killed while it consumes the notice
- **WHEN** a session start dies after it took the one-time notice and before it showed it, or a newer notice is written while a session consumes the older one
- **THEN** the next session start shows the notice the dead session took, unless a newer notice replaced it, and a newer notice is never overwritten by the mark of an older one; what the dead session left is removed by that next start

#### Scenario: A switch not proven finished
- **WHEN** an automatic attempt switched this machine, and its migration run state cannot be read when a later start begins, or the read that should show the switch finished fails right after a start finished it
- **THEN** nothing announces the migration (no brain log line, no metrics row, no notice) and the attempt stays pending; while the state cannot be read the doctor and the status block do not report the switch done, and once it reads back as done the next start announces the migration once

#### Scenario: Stopped while writing what announces it
- **WHEN** an attempt stops after the switch while writing its metrics row, its brain log line or its notice, or one of them cannot be written, or a session shows the notice before the attempt's record is cleared
- **THEN** the next start writes only what is missing, each once, and a notice a session already showed is not shown again

### Requirement: The automatic path respects privacy
The worker SHALL move data only between the vault, the store and device-local state on this machine, and SHALL send nothing to a provider. Private records SHALL keep their partition, and a machine that holds only the shared partition SHALL NOT receive private data through the automatic path.

#### Scenario: Private records after an automatic migration
- **WHEN** the migration imports a vault with private records
- **THEN** those records are in the store's private partition, and no provider was contacted

### Requirement: Every surface says what the decision does
The doctor, the status block, `o2b brain upgrade --dry-run`, the session notices, `o2b update --dry-run` and a start's own answer SHALL derive what they say the next step does from the one gate decision the worker takes (its answer and its reason), never from their own reading of the state, so none of them disagrees with what the next step does.

#### Scenario: A stopped run's gate the next start opens
- **WHEN** a recorded failure is shown while a stopped migration run's gate of this vault is to be opened by the next start
- **THEN** the doctor and the status block report a failure whose next step opens the gate, and the session notice says the next start opens the gate; none of them says which steps the stopped run completed, or that it changed nothing

### Requirement: The update runs the migration in the foreground
`o2b update` SHALL run the same check after updating and, when a migration is available and enabled, the same worker logic in the foreground, and SHALL report the outcome in its text and `--json` output. A migration failure SHALL NOT make the update report failure, but SHALL be named. A flag SHALL skip it once.

#### Scenario: Update on a legacy vault
- **WHEN** the operator runs `o2b update` on a machine with a migration available
- **THEN** the update's output names the migration it ran and its outcome, and the exit code answers the update alone

#### Scenario: Skipping it once
- **WHEN** the operator runs `o2b update --skip-store-migration`
- **THEN** no migration runs on that update, and the next start offers or runs it as before

#### Scenario: A dry run of a blocked migration
- **WHEN** the operator runs `o2b update --dry-run` while an interrupted rollback's or legacy tree removal's gate of this vault, or another vault's stopped migration, rollback or legacy tree removal, holds an enabled migration back
- **THEN** the dry run reports the migration as refused, with the reason and the command that finishes what holds the gate (for another vault's stopped run, the command names that vault and finishes that run: a migration is resumed, a rollback rolled back, a removal removed, so a rollback is never answered with a resume), runs no worker and records nothing; it reports `pending` when the update would migrate, finish a switch or open a stopped run's gate, and `not_needed` only when the update would do nothing
