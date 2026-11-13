# held-partitions Specification

## Purpose
Which partitions of the brain store a machine holds, how a partition it
held and lost makes the store fail closed, and how the operator takes a
partition off a machine on purpose.

## Requirements

### Requirement: A lost held partition fails closed and names the remedies

A machine that held a partition whose `store.json` is now missing SHALL
refuse to open the store, and the refusal and the doctor finding
`store-partition-lost` SHALL name the remedies: restore the partition's
`store.json` from sync or a backup, or, for a partition other than
`shared`, run `o2b store partition leave <partition>`. For a lost
`shared` partition the refusal SHALL name only the restore, because
leaving `shared` is refused.

#### Scenario: private/store.json lost without the verb

- **GIVEN** a machine that held both partitions
- **WHEN** `private/store.json` disappears and the operator runs any store
  command
- **THEN** the command refuses and names
  `o2b store partition leave private`

#### Scenario: shared/store.json lost

- **GIVEN** a machine that held both partitions
- **WHEN** `shared/store.json` disappears and the operator runs any store
  command
- **THEN** the command refuses and names the restore of
  `shared/store.json`, but names no `o2b store partition leave` command

#### Scenario: shared/store.json and private/store.json both lost

- **GIVEN** a machine that held both partitions
- **WHEN** `shared/store.json` and `private/store.json` both disappear and
  the operator runs any store command
- **THEN** the command refuses and names the restores of
  `shared/store.json` and `private/store.json`, but names no
  `o2b store partition leave` command: with `shared/store.json` gone, a
  leave cannot read the store id and would refuse without changing
  anything

### Requirement: Leaving a partition makes the machine hold the rest

`o2b store partition leave <partition>` SHALL take the partition off this
machine's held list once its folder carries no `store.json`; from then on
the store SHALL open with the remaining partitions, with no refusal.

#### Scenario: Leaving private

- **GIVEN** a machine that held both partitions, and the `private` folder
  removed
- **WHEN** the operator runs `o2b store partition leave private`
- **THEN** the verb exits 0
- **AND** the next store command treats the machine as shared-only

### Requirement: Leaving refuses what it cannot do safely

The verb SHALL refuse with exit code 1 and a named reason: `shared`
(leaving it is leaving the store); `still-held` while the partition's
`store.json` is present; `files-left` while the partition's folder still
holds anything, unless `--force` is given, and always when the folder
cannot be listed, so what is left cannot be checked. A partition name
that is not a store partition SHALL be a usage error (exit 2).

#### Scenario: Leaving shared

- **WHEN** the operator runs `o2b store partition leave shared`
- **THEN** the verb exits 1 with reason `shared`

#### Scenario: Files left in the folder

- **GIVEN** a `private` folder with shards and no `store.json`
- **WHEN** the operator runs the verb without `--force`
- **THEN** it exits 1 with reason `files-left` and the machine still
  refuses to open the store
- **AND** with `--force` the verb leaves the partition

#### Scenario: The folder cannot be listed

- **GIVEN** the place of the `private` folder taken by a regular file, so
  the folder cannot be listed
- **WHEN** the operator runs the verb
- **THEN** it exits 1 with reason `files-left`, with or without `--force`

### Requirement: What each refusal changes

On a `shared`, `still-held`, `files-left` or `no-store-id` refusal the
verb SHALL change nothing. On a `clear-failed` refusal it MAY already
have cleared device-local caches or seen-shard entries, but SHALL keep
the held marker, so the machine still fails closed.

#### Scenario: A failed clearing keeps the marker

- **GIVEN** a machine that holds `private` and whose device-local state
  of it cannot be cleared
- **WHEN** the operator runs the verb
- **THEN** it exits 1 with reason `clear-failed`, and the machine still
  holds `private` (the store still refuses to open)

### Requirement: Leaving fails closed without the shared store id

The verb SHALL read the store id from the shared partition's
`store.json` before it removes anything, and SHALL refuse with exit code
1 and reason `no-store-id`, changing nothing, when that file is missing
or unreadable: without the store id it cannot find the partition's
device-local state, so it SHALL NOT report a leave it could not clear.
It SHALL remove the held marker last, so a failed clearing (reason
`clear-failed`) leaves the machine still holding the partition.

#### Scenario: The shared identity file cannot be read

- **GIVEN** a machine that held both partitions, the `private` folder
  removed, and `shared/store.json` missing or not valid JSON
- **WHEN** the operator runs `o2b store partition leave private`
- **THEN** it exits 1 with reason `no-store-id` and a message that says to
  restore the shared partition's identity file first
- **AND** the machine still holds `private` (the store still refuses to
  open), and no seen-shard entry or digest cache is removed

### Requirement: Leaving is idempotent

The `still-held` check (whether the partition's `store.json` is present)
comes before the not-held answer. When that file is absent and this
machine does not hold the partition, the verb SHALL exit 0, say there is
nothing to leave and change nothing; under `--json` it SHALL answer
`{ "ok": true, "left": false }`. So a folder that was synced in without
a writing open recording it is refused as `still-held`, not reported as
nothing to leave.

#### Scenario: Leaving twice

- **WHEN** the operator runs the verb a second time
- **THEN** it exits 0 and reports `left: false`

### Requirement: Leaving clears what this machine kept of the partition

Leaving SHALL clear this machine's device-local state of the partition:
its record of shards seen and the cached digests that may hold its text.
The search index SHALL hold no record of the partition after its next
catch-up.

#### Scenario: The index forgets the partition

- **GIVEN** a private record that the search index returns
- **WHEN** the operator leaves `private` and the index catches up
- **THEN** the index no longer returns the record

### Requirement: A partition that comes back is held again

A left partition whose `store.json` later arrives again (by sync or a
restore) SHALL be held again from the next writing open, under the same
rule as any partition; the verb's output and the documentation SHALL say
so.

#### Scenario: private returns

- **GIVEN** a machine that left `private`
- **WHEN** `private/store.json` and its shards arrive again and a store
  write runs
- **THEN** the machine holds `private` again, and losing its `store.json`
  later fails closed again
