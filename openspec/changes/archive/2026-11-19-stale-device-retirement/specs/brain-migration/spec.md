# Spec Delta

## Purpose

A cohort device that has not written for longer than a threshold every
machine agrees on counts as retired, so a vault that carries ids of machines
that no longer exist can lose its legacy tree without `--force`. The doctor
and the status block show each cohort device's state, and a device that
comes back loses nothing it synced. This modifies the removal and the
regeneration requirements of `brain-migration` and adds the silence rule.

## MODIFIED Requirements

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

### Requirement: Legacy tree regeneration is detected
Doctor SHALL report when a legacy `Brain/` machine directory reappears in the vault after migration, and SHALL name the writer when the file carries one. When the reappeared files name a device that the removal record lists as retired by silence, the report SHALL say so and SHALL tell the user to update that machine, whose migration then imports its legacy records as a later machine.

#### Scenario: Agent follows stale instructions
- **WHEN** an agent creates `Brain/preferences/` in the vault after migration
- **THEN** doctor reports the directory and the agent name found in it

#### Scenario: A device retired by silence comes back on an old release
- **WHEN** device C, retired by silence when the tree left, writes a legacy log shard into the vault again
- **THEN** doctor reports the directory, names C as retired by silence and says to update that machine and remove the tree again afterwards

## ADDED Requirements

### Requirement: A silent device counts as retired
A cohort device that has not switched SHALL count as retired by silence when its last evidence of life is older than the shared setting `migration.silent_device_days` (default 30; 0 turns the rule off). Its last evidence SHALL be the newest of its legacy shard name dates, their row times and the clocks of its store records, or else the earliest cohort record naming it; file modification times SHALL NOT be evidence.

#### Scenario: An id with no dated trace
- **WHEN** the cohort record names device D and no legacy shard or store record of D carries a date
- **THEN** D is retired by silence once the threshold has passed since the cohort record, and an id named by no cohort record and with no date is never retired by silence

### Requirement: The age of a device is measured against the evidence
The age of a device's last evidence SHALL be measured against the newest evidence of any device that is not later than this machine's wall clock, evidence later than the wall clock SHALL be left out of that reference rather than taken as the wall clock, and evidence later than the reference SHALL count as the reference, so a wrong clock is bounded by the dates actually written.

#### Scenario: A clock far in the future on another machine
- **WHEN** a device's rows carry a time years ahead of this machine's clock
- **THEN** that device counts as alive now and no other device is retired because of it

### Requirement: The state of each cohort device is shown and derived
The retirement by silence SHALL be derived on every read and never recorded: a device that writes again SHALL be pending again at once when what it writes carries a date within the threshold of the reference (a date later than the reference counts as the reference), and a write stamped older than that SHALL leave it retired by silence. Doctor and the store status SHALL list each cohort device as switched, pending with its last evidence date, or retired by silence with the date and the threshold, and once none is pending SHALL say, as advice and not as a warning, that the legacy tree can leave the vault and name the removal command.

#### Scenario: A stale id stops holding the tree
- **WHEN** device C last wrote 40 days before the newest evidence of the store and the threshold is 30
- **THEN** doctor lists C as retired by silence with its last evidence date and the threshold, and says the legacy tree can leave the vault with `o2b brain migrate-store --remove-legacy`

#### Scenario: A retired device writes again
- **WHEN** device C, retired by silence, writes a legacy log shard dated today while the tree is still in the vault
- **THEN** doctor lists C as pending again and the removal without `--force` refuses and names it

#### Scenario: A device that returns on the new release after the removal
- **WHEN** device C, retired by silence, updates after the tree left the vault and its local copy of the tree is gone
- **THEN** it writes the store only by the no-legacy-tree rule and its start records no switch from the removal record, because a vault without its tree carries no identity marker to match that record to and another vault whose tree has not arrived yet looks the same; `o2b init --vault` on that machine records its switch, and only records it wrote after its last sync and never synced are lost
