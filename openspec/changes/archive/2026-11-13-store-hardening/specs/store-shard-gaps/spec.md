# Spec Delta

## Purpose

How the brain store reports a shard that a machine reads only in part,
and how an operator releases one bad line on one machine without editing
a shard another device owns.

## ADDED Requirements

### Requirement: Doctor names each shard read only in part

`brain_doctor` SHALL report every shard of a held partition that reads
only in part, one finding per gap, naming the shard as
`<partition>/<shard path>`, the byte offset of the line, what fails closed
on it, and the command that repairs it. A line cut short by a crash and
closed by the next append is not a gap and SHALL NOT be reported.

#### Scenario: A corrupt line in the middle

- **GIVEN** a shard whose middle line is not a valid record
- **WHEN** the operator runs the doctor
- **THEN** it reports an error `store-shard-corrupt-line` naming the shard,
  the offset and `o2b store shard quarantine <partition>/<shard> --offset <n>`

#### Scenario: A record of a newer format

- **GIVEN** a shard with a record whose format version this release does
  not know
- **WHEN** the operator runs the doctor
- **THEN** it reports a warning `store-shard-newer-format` naming the shard
  and the offset and saying to upgrade Open Second Brain, with no
  quarantine command

#### Scenario: A blob that has not arrived

- **GIVEN** a shard with a record whose body blob is absent
- **WHEN** the operator runs the doctor
- **THEN** it reports `store-shard-blob-pending`, a warning while the
  record is younger than seven days and an error from then on, naming the
  quarantine command once it is allowed

#### Scenario: A pending record whose clock stamp does not parse

- **GIVEN** a shard with a record whose body blob is absent and whose
  clock stamp does not parse as a time
- **WHEN** the operator runs the doctor
- **THEN** it reports an error `store-shard-blob-pending` saying the clock
  stamp does not parse, with no quarantine command and no write time

### Requirement: A corrupt line too long to quarantine names no quarantine command

The doctor SHALL name the quarantine command for a corrupt line only when
the verb can hash that line; a corrupt line past the quarantine hash cap,
which the verb always refuses as `line-too-long`, SHALL be reported as an
error `store-shard-line-too-long` whose message names repair at the
line's source and whose next step names no command.

#### Scenario: A corrupt line too long to quarantine

- **GIVEN** a shard whose middle line is not a valid record and runs past
  the quarantine hash cap
- **WHEN** the operator runs the doctor
- **THEN** it reports an error `store-shard-line-too-long` naming the
  shard, the offset and repair at the line's source
- **AND** neither the finding nor its next step names a quarantine command

### Requirement: A gap no quarantine can release names no quarantine command

A gap no quarantine can release (the shard was swapped for a link, or cut
below the offset, since the partition read) and a shard read only in part
that cannot be read again for any reason other than its removal SHALL be
reported as an error `store-shard-unreadable` naming the shard, whose next
step names no command; the second case SHALL name the error code. A shard
removed since the partition read SHALL give no finding.

#### Scenario: A shard swapped for a link

- **GIVEN** a shard read only in part that is replaced by a symbolic link
  before the doctor reads it again
- **WHEN** the operator runs the doctor
- **THEN** it reports an error `store-shard-unreadable` naming the shard
- **AND** neither the finding nor its next step names a quarantine command

#### Scenario: A shard that cannot be read again

- **GIVEN** a shard read only in part that the doctor cannot open again
  (a permission, a lock)
- **WHEN** the operator runs the doctor
- **THEN** it reports an error `store-shard-unreadable` naming the shard
  and the error code

### Requirement: The doctor withholds private store findings below local reach

Below local reach (a caller whose reach is not local, or one marked as
withheld from private data), every surface that runs the doctor
(`brain_doctor`, `brain_brief view=operator`, `brain_status` and the
repair pass) SHALL compute the store findings as if this machine did not
hold the `private` partition, and that partition SHALL NOT change the
caller's `ok`, counts or `trust_verdict`. Local reach and the CLI doctor
SHALL report everything as before.

#### Scenario: A gap in a private shard below local reach

- **GIVEN** a shard of the `private` partition with a corrupt middle line
- **WHEN** a remote caller runs `brain_doctor`, `brain_brief view=operator`
  or `brain_status`
- **THEN** no finding names the shard, its offset or a record's time
- **AND** `ok`, the error and warning counts and `trust_verdict` are what
  they would be without the gap
- **AND** a local caller's doctor reports the gap

### Requirement: Every store finding about the private partition is withheld below local reach

The findings withheld below local reach SHALL be every store finding that
names the `private` partition or a shard, offset, record id, record time
or device clock of it: a gap, a held tail, an unreadable shard, a record
id conflict, a clock ahead, a digest divergence or silence, a record id
found in both partitions, a loose permission and a reserved device
folder; the removal backlog SHALL count only `shared`. Failed writes
follow the next requirement.

#### Scenario: A private record whose clock is ahead

- **GIVEN** records of the `private` partition whose clock is days ahead
  of now
- **WHEN** a remote caller runs the doctor
- **THEN** no `store-clock-ahead` finding names the `private` partition
- **AND** a local caller's doctor reports it

### Requirement: A failed private write is withheld below local reach

Below local reach the write failure findings (`store-dual-write-failures`,
`store-write-fail-open`) SHALL show only the failures known to concern
only `shared`: every record of the operation was placed in `shared` when
its append failed. For any other failure they SHALL NOT show its count,
time, error text or path, since the error text can name a private shard.
The skipped dual writes SHALL be reported below local reach without their
count.

#### Scenario: A failed private write below local reach

- **GIVEN** a dual write and a fail-open store-only write into the
  `private` partition that failed with an error naming the private path
- **WHEN** a remote caller runs `brain_doctor`
- **THEN** no `store-dual-write-failures` or `store-write-fail-open`
  finding is reported, and nothing names the path
- **AND** a local caller's doctor reports both, with the error text
- **AND** once a write into `shared` fails too, the remote caller sees
  that one failure, with its own error text and time only

### Requirement: A lost private identity file is reported below local reach without its name

A lost `private` identity file follows the same rule: the store is not
opened and every protection fails closed for `shared` too, so below local
reach the `store-partition-lost` error SHALL still be reported, but
without naming the `private` partition. With `shared` lost as well it
SHALL name `shared` and "another partition".

#### Scenario: A lost private identity file below local reach

- **GIVEN** a machine that held the `private` partition whose
  `private/store.json` is gone
- **WHEN** a remote caller runs the doctor
- **THEN** it reports an error `store-partition-lost` that does not name
  the `private` partition

### Requirement: A quarantined line releases the protection reads on this machine

`o2b store shard quarantine <partition>/<shard> --offset <n>` SHALL
record, on this machine only, that the line at that offset with exactly
its current bytes is skipped; the shard SHALL then read as whole on this
machine, the line SHALL stay in the file, and no other machine SHALL be
affected.

#### Scenario: Capture reopens

- **GIVEN** a store-only machine whose capture is closed by a corrupt line
  in a shared shard
- **WHEN** the operator quarantines that line
- **THEN** capture writes again on this machine
- **AND** the shard's bytes are unchanged

Every quarantine mark, of a corrupt line and of a pending blob alike,
SHALL require both the byte offset and the hash of the line's bytes to
match one ledger entry of the matching kind: a `corrupt-line` entry marks
only a corrupt line, a `blob-pending` entry only a pending record, and a
pending record of a `settings` shard SHALL never be marked. The shard or
the offset alone SHALL never mark a line.

#### Scenario: An entry of another kind

- **GIVEN** a `corrupt-line` entry whose offset and line hash match a
  record whose blob is pending
- **WHEN** the shard is read
- **THEN** the pending record is a gap

### Requirement: Quarantining the same bytes as the other kind replaces the entry

Quarantining a line SHALL answer `already` only when the ledger holds an
entry for that offset with the same bytes and the same kind; an entry of
the other kind SHALL be replaced, so the line is marked by its current
kind.

#### Scenario: The same bytes quarantined as the other kind

- **GIVEN** a `corrupt-line` entry whose offset and line hash match a
  record whose blob is pending
- **WHEN** the operator quarantines that record
- **THEN** the verb answers `quarantined`, the entry's kind becomes
  `blob-pending`, and the record no longer counts as a gap

#### Scenario: The line changes

- **GIVEN** a quarantined line
- **WHEN** a different line appears at the same offset (the shard was
  replaced)
- **THEN** the new line is a gap again and the doctor reports it

#### Scenario: A second corrupt line in the same shard

- **GIVEN** a shard with one quarantined corrupt line
- **WHEN** another corrupt line appears at a different offset of the same
  shard
- **THEN** that line is a gap: the protection reads fail closed again and
  the doctor reports it

### Requirement: Some gaps are never quarantined

The verb SHALL refuse, with exit code 1 and a named reason: a line of a
newer format; a pending blob younger than seven days; a pending blob in a
`settings` shard; a pending blob whose record's clock stamp does not parse
as a time; the last line of a shard of this machine's own device, whether
the reader reports it or holds it back for a retry; an offset that holds
no gap.

#### Scenario: A newer-format line

- **WHEN** the operator quarantines a newer-format line
- **THEN** the verb exits 1 with reason `newer-format` and records nothing

#### Scenario: A young pending blob

- **WHEN** the operator quarantines a pending blob written one day ago
- **THEN** the verb exits 1 with reason `blob-too-young`

#### Scenario: A pending blob with an unreadable clock stamp

- **WHEN** the operator quarantines a pending blob whose record's clock
  stamp does not parse as a time
- **THEN** the verb exits 1 with reason `blob-clock-unreadable` and records
  nothing

#### Scenario: A held corrupt last line of this machine's own shard

- **WHEN** the operator quarantines the last line of a shard this machine
  writes, which does not verify and which the reader holds back
- **THEN** the verb exits 1 with reason `own-tail`

### Requirement: A line the verb cannot hash the same way twice is refused by cause

The verb SHALL hash the line before and after it is judged. A line that
runs past the hash cap both times SHALL be refused as `line-too-long`,
which stays so until the shard's bytes change, so the refusal SHALL NOT
say to run the command again. Hashes that differ, or a line that could not
be read through to its end once, SHALL be refused as `shard-changed`,
which is transient: running the command again checks it once more.

#### Scenario: A corrupt line too long to hash

- **WHEN** the operator quarantines a corrupt line longer than the hash cap
- **THEN** the verb exits 1 with reason `line-too-long`, records nothing,
  and does not say to run the command again

### Requirement: Every refusal of the verb has a named reason

The JSON reasons of the verb's refusals SHALL be exactly: `not-held`,
`unknown-shard`, `no-gap`, `newer-format`, `blob-too-young`,
`settings-blob`, `blob-clock-unreadable`, `own-tail`, `line-too-long`,
`shard-changed`, `ledger-unreadable`, and the store open errors
`no-store`, `partition-lost`, `store-open-error`, `store-root-in-vault` and
`config`.

#### Scenario: A refusal under --json

- **WHEN** the operator quarantines an offset that holds no gap with
  `--json`
- **THEN** the verb exits 1 and answers `{ ok: false, reason: "no-gap", error }`

### Requirement: A ledger this release cannot rewrite is left as it is

A ledger file that cannot be read, does not parse, has another version,
or holds an entry this release does not read SHALL be refused with
`ledger-unreadable` and left as it is; a file that cannot be read SHALL
be named as unreadable, not as one that does not parse.

#### Scenario: A ledger this release cannot rewrite

- **GIVEN** a ledger file of another version
- **WHEN** the operator quarantines or releases a line
- **THEN** the verb exits 1 with reason `ledger-unreadable` and the ledger
  file is unchanged

### Requirement: The reader applies entries only from a ledger of the supported version

The reader SHALL apply quarantine entries only from a ledger file that is
a JSON object of the version this release writes with a list of lines. A
ledger of another version, one with no version, one that is not an
object, has no list of lines, cannot be read or does not parse SHALL
quarantine nothing, so every line it names stays a gap.

#### Scenario: A ledger of another version

- **GIVEN** a ledger holding a valid entry for a corrupt line whose
  version is changed to 2
- **WHEN** the shard is read
- **THEN** the line is a gap again, and `o2b store shard list` lists no
  entry

### Requirement: Each ledger entry stands on its own

Within a ledger of the supported version an entry this release does not
read SHALL apply nothing, and the other entries SHALL still apply. A
skipped entry only leaves its line a gap, so it never makes a shard read
as whole.

#### Scenario: An entry this release does not read

- **GIVEN** a ledger of the supported version holding a valid entry and
  an entry of a kind this release does not know
- **WHEN** the shard is read
- **THEN** the valid entry still marks its line, and the unknown entry
  marks nothing

### Requirement: A quarantined pending blob reads normally once it arrives

A record whose pending blob was quarantined SHALL be left out of every
read while the blob is absent, and SHALL read as any other record as soon
as the blob arrives, with no operator action.

#### Scenario: The blob arrives late

- **GIVEN** a quarantined pending blob
- **WHEN** the blob file arrives
- **THEN** readers return the record with its body

### Requirement: Rollback and the late import still refuse on a pending blob

The legacy rollback, the late import of the transition, the migration
preflight and the legacy removal SHALL keep refusing while any held shard
outside the digest stream holds a record whose blob has not arrived,
whether or not it was quarantined; none of them waits for it. A shard of
the digest stream holds published digests, no record any of them imports
or restores, and is not counted. The legacy removal's existing `--force`
goes past such a shard, as it goes past any shard read only in part.

#### Scenario: Rollback with a quarantined pending blob

- **GIVEN** a quarantined pending blob
- **WHEN** the operator runs the rollback
- **THEN** it refuses and names the shard

### Requirement: Quarantines can be listed and released

`o2b store shard list` SHALL print every quarantined line of this
machine's store with its state (`held`, `resolved` when the line now reads
as a record, `stale` when other bytes stand at the offset);
`o2b store shard release <partition>/<shard> --offset <n>` SHALL remove
the entry. Both, and `quarantine`, SHALL take `--config` and `--json`,
exit 0 for an answer, 1 for a refusal and 2 for a usage error, and under
`--json` answer `{ ok: false, reason, error }` for each refusal.

#### Scenario: Releasing an entry

- **GIVEN** a quarantined corrupt line
- **WHEN** the operator releases it
- **THEN** the shard is a gap again and capture closes again

#### Scenario: Releasing what is not quarantined

- **WHEN** the operator releases an offset with no entry
- **THEN** the verb exits 0 and says nothing was quarantined there
