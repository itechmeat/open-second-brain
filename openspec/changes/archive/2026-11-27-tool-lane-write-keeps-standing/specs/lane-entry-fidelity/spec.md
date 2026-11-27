## ADDED Requirements

### Requirement: A sequential rewrite keeps the standing of the entry it replaces

On a store-only machine a lane write that replaces the entry this machine
holds SHALL be stored at the stronger of the writer's own authority and
the authority of the record that holds the entry, so the next read shows
it whoever wrote the entry before. This holds for the obligation, pledge,
intention, handoff and entity lanes and every other lane.

#### Scenario: An obligation completed by a tool

- **GIVEN** a store-only machine and an obligation added by an operator's
  command
- **WHEN** an agent completes it through the obligation tool
- **THEN** the next read shows the completion date, the next due date one
  cadence later and the completion in the list, as the tool answered

#### Scenario: A pledge fulfilled by a tool

- **GIVEN** a store-only machine and a pledge written by an `o2b` process
- **WHEN** an agent fulfils it through the pledge tool
- **THEN** the next read shows it fulfilled on that date

#### Scenario: A pledge re-anchored by the intake

- **GIVEN** a store-only machine and a pledge written by an `o2b` process
- **WHEN** the pledge intake tool re-anchors its counterparties
- **THEN** the next read shows the counterparties the intake answered

#### Scenario: An intention set by a tool

- **GIVEN** a store-only machine and an intention chain set by an
  operator's command
- **WHEN** an agent sets a new intention for the same scope through the
  intention tool
- **THEN** the next read shows the new text, the next version and the
  prior text in the history

#### Scenario: A handoff note re-derived in place

- **GIVEN** a store-only machine and a handoff note written by an `o2b`
  process
- **WHEN** an agent's process re-derives the note at the same path
- **THEN** the next read shows the re-derived note

#### Scenario: An entity upserted by a tool

- **GIVEN** a store-only machine and an entity page written by an
  operator's command
- **WHEN** an agent upserts the same entity with a new alias through the
  entity tool
- **THEN** the tool's answer and the next read both show the alias

#### Scenario: An entity related or archived by an agent's process

- **GIVEN** a store-only machine and entity pages written by an
  operator's command
- **WHEN** an agent's process relates two of them, or archives one
- **THEN** the next read shows the relation, or the entity archived

#### Scenario: A stronger writer is not lowered

- **GIVEN** a store-only machine and an entry written by an agent
- **WHEN** an operator's command rewrites it
- **THEN** the new record is stored at the operator's authority

### Requirement: A removal or a move keeps the standing of the entry it removes

On a store-only machine the tombstone of a removed or moved lane entry,
and the shared tombstone a write adds when it raises a shared entry to
`private`, SHALL be stored at the stronger of the writer's own authority
and the authority of the record that holds the entry. A moved entry SHALL
be stored at the stronger of that authority and the authority of the
record that holds its new path, an entry or a removal. The next read
finds the entry gone from its old path and present at its new one.

#### Scenario: An obligation removed by a tool

- **GIVEN** a store-only machine and an obligation added by an operator's
  command
- **WHEN** an agent removes it through the obligation tool
- **THEN** the next list of active obligations does not show it, and its
  archived page does

#### Scenario: An intention moved to history by a tool

- **GIVEN** a store-only machine and an intention chain set by an
  operator's command
- **WHEN** an agent moves it to history through the intention tool
- **THEN** the next read finds no active chain for that scope

#### Scenario: A move onto a path a person's entry holds

- **GIVEN** a store-only machine, an entry an agent wrote at one path and
  an entry an operator's command wrote at another
- **WHEN** an agent's process moves the first entry onto the second path
- **THEN** the next read finds no entry at the first path and the moved
  entry at the second

#### Scenario: A raise to private over a person's shared entry

- **GIVEN** a store-only machine and a shared entry written by an
  operator's command
- **WHEN** an agent's write replaces it with a private version
- **THEN** the shared tombstone written with it is stored at the
  operator's authority, so a device that holds only the `shared`
  partition no longer reads the old version

### Requirement: A create over a removed entry keeps the removal's standing

On a store-only machine a lane write that creates an entry at a path
whose last record is a removal SHALL be stored at the stronger of the
writer's own authority and the removal's, so the created entry reads back
as it does on a machine that has not switched, where the removal emptied
the place the create writes into.

#### Scenario: An obligation added again by a tool after an operator removed it

- **GIVEN** a store-only machine and an obligation an operator's command
  added and then removed
- **WHEN** an agent adds an obligation of the same title through the
  obligation tool
- **THEN** the next read shows the new obligation, as the tool answered

#### Scenario: A pledge added again by a tool after an `o2b` process removed it

- **GIVEN** a store-only machine and a pledge an `o2b` process wrote and
  then removed
- **WHEN** an agent adds the same pledge through the pledge tool
- **THEN** the next read shows the pledge, as the tool answered

### Requirement: A retry does not repeat a completion or a fulfilment

Because a kept rewrite reads back, a retry of a completion or a
fulfilment on a store-only machine SHALL compute from the state the first
call wrote, as on a machine that has not switched.

#### Scenario: A pledge fulfilled twice

- **GIVEN** a store-only machine and a pledge written by an `o2b` process
  that an agent's tool call has fulfilled
- **WHEN** the agent fulfils it again
- **THEN** the call is refused as already fulfilled, naming the date

#### Scenario: An obligation completed twice on one date

- **GIVEN** a store-only machine and an obligation added by an operator's
  command that an agent's tool call has completed on a date
- **WHEN** the agent completes it again on the same date
- **THEN** the next read shows the next due date one cadence past that
  date, not two

### Requirement: A version that changed since the read is refused visibly

On a store-only machine a read-modify-write of a lane entry (a
completion, a fulfilment, a re-anchor, an intention set, an entity
upsert, relation or archive) SHALL write nothing and fail with an error
of its own that names the entry when the store no longer holds the
version the writer read, or could not be read whole, a gap that opens
after the read included; the answer SHALL report that error and its
remedy, never the computed state or a generic store write failure.

#### Scenario: A human version arrives between the read and the write

- **GIVEN** a store-only machine where an agent's completion has read an
  obligation
- **WHEN** another device's human version of that obligation is read into
  the store before the completion writes
- **THEN** the completion writes no record and its answer is an error
  that names the obligation, says it changed since it was read and tells
  the caller to read it again, not to repair the store, and the next read
  shows the other device's version

#### Scenario: A store that cannot be read whole

- **GIVEN** a store-only machine whose lane fold misses a record (an
  unreadable shard or a pending body blob)
- **WHEN** an agent completes an obligation
- **THEN** no record is written and the answer is an error that says the
  store could not be read in full and names `o2b brain doctor`

#### Scenario: A gap that opens after the read

- **GIVEN** a store-only machine where a write read an entry while the
  lane fold was whole
- **WHEN** the fold misses a record before the write
- **THEN** no record is written and the error says the store could not be
  read in full, not that the entry changed

#### Scenario: An entity upsert builds on the entity it locked

- **GIVEN** a store-only machine where an agent's upsert has resolved an
  entity from the registry index
- **WHEN** another version of that entity, with an alias of its own, is
  written before the upsert takes the entity's lock
- **THEN** the upsert writes the entity with both that alias and its own

### Requirement: A write the store does not apply fails visibly

On a store-only machine, after every lane write the entry SHALL be read
back, and when the store does not hold what the write wrote (a value, or
no entry after a removal), the call SHALL fail with an error that names
the entry, says whether a version or a removal holds it and names that
record's authority, so no answer reports a state the next read does not
show.

#### Scenario: A competing version stamped ahead of this machine

- **GIVEN** a store-only machine whose store holds a human version of an
  obligation stamped further ahead of this machine's clock than the
  clock accepts
- **WHEN** an agent completes the obligation
- **THEN** the answer is an error that names the obligation, a version
  and the `human` authority that holds it, and the next read shows that
  version

#### Scenario: A removal stamped ahead of this machine holds the path

- **GIVEN** a store-only machine whose store holds a human removal of an
  obligation stamped further ahead of this machine's clock than the
  clock accepts
- **WHEN** an agent adds an obligation at that path
- **THEN** the answer is an error that names the path, a removal and the
  `human` authority that holds it, and the next read shows no obligation
  there

### Requirement: Versions written apart on two devices are arbitrated by the authority order

The kept standing SHALL apply only to what the writing device read. A
lane version written on another device and read into the store after the
write SHALL be arbitrated by the authority order, then the clock, with
no refusal and no error on either device.

#### Scenario: A person's version with a later clock

- **GIVEN** an agent's completion kept on a store-only machine
- **WHEN** another device's human version of that obligation, stamped
  later, syncs in
- **THEN** that version wins, and the earlier answer stays true for the
  reads made before it arrived

#### Scenario: A person's version with an earlier clock

- **GIVEN** an agent's completion of an obligation an operator's command
  added, kept on a store-only machine at the operator's standing
- **WHEN** another device's human version of that obligation, stamped
  earlier than the completion, syncs in
- **THEN** the completion stays, by the clock between two human records,
  and neither device reports an error, as two edits of one file meet in
  a sync conflict on machines that have not switched

### Requirement: The record names who acted

A `lane-entry` or `lane-entry-remove` record stored at a stronger
authority than its writer's own SHALL carry the writer's own authority in
the optional body field `acted_by`; a record at the writer's own
authority SHALL carry no such field. The field SHALL NOT change the fold,
and a reader that does not know it SHALL ignore it.

#### Scenario: An agent's completion of a human entry

- **WHEN** an agent's tool call completes an obligation an operator's
  command added, on a store-only machine
- **THEN** the new record has `authority` `human` and `acted_by` `agent`

#### Scenario: An operator's rewrite

- **WHEN** an operator's command rewrites an entry an operator's command
  wrote
- **THEN** the new record has `authority` `human` and no `acted_by`

### Requirement: A tool's lane write below local reach that meets a private holder gets the fixed answer

Below local reach a lane write whose key is held in `private` (live or
removed), or whose fold may miss a record, SHALL get the fixed answer
before any record is written, the reach check before the version check;
no answer for such a key, the read-back's included, SHALL name a path,
holder, authority, gap or doctor (the write paths of the 2.0.4 scenario
"A write reported as not applied names no private holder"). A completion
of an entry the caller cannot see SHALL answer as for an absent one.

#### Scenario: Completing an obligation whose winning version is private

- **GIVEN** an obligation whose winning version is a `human` version held
  in `private`
- **WHEN** a caller below local reach completes it
- **THEN** no record is written, the raw records of both partitions are
  unchanged, and the answer is the one an absent obligation gets, naming
  nothing of the entry

#### Scenario: A create over a private removal

- **GIVEN** an obligation key held by a `human` removal held in `private`
- **WHEN** a caller below local reach adds an obligation at that key
- **THEN** the answer is the fixed answer, not an error naming the path,
  a removal or the `human` authority

#### Scenario: An entry raised to private after the base

- **GIVEN** a caller below local reach whose completion took its base
- **WHEN** a local writer raises the obligation to `private` before the
  write
- **THEN** the answer is the fixed answer, never an error saying the entry
  changed since it was read

#### Scenario: A read-back that meets a private holder

- **GIVEN** a caller below local reach whose write passed the reach check
- **WHEN** a `human` record held in `private`, stamped further ahead than
  the clock accepts, holds the key when the write is read back
- **THEN** the answer is the fixed answer, not an error naming the path,
  a version or the `human` authority

#### Scenario: A remote write while the store cannot be read whole

- **WHEN** a caller below local reach adds an obligation or a pledge, or
  completes an obligation, while the lane fold of every partition may
  miss a record
- **THEN** nothing is written, the add gets the fixed answer and the
  completion the answer an absent obligation gets, with no gap and no
  doctor text in either

### Requirement: A machine that has not switched is unchanged

On a machine that has not switched, a lane write SHALL behave as before:
the file is written, the answer and the next read come from the file,
and no refusal or read-back error of this change applies. The one
exception is the entity overwrites, which read the entity again under
its lock in every mode (scenarios below).

#### Scenario: The entity overwrites read the entity again under its lock in every mode

- **GIVEN** a machine with a legacy `Brain/` tree
- **WHEN** an entity overwrite (`upsertEntity`'s update,
  `relateEntities`, `archiveEntity`) writes an entity
- **THEN** the written fields are built from the entity read again under
  its lock, not from the entity index entry, so an upsert that met a
  stale entity index keeps the alias another writer added in between,
  where it used to write over it from the index entry
- **AND** the overwrite takes the entity page's lane lock, which such a
  machine did not take before: it is what makes the read again sound,
  and while the write runs a lock file sits beside the page

#### Scenario: A completion through a tool on an unswitched machine

- **GIVEN** a machine with a legacy `Brain/` tree
- **WHEN** an agent completes an obligation an operator's command added
- **THEN** the file shows the completion and the answer is the page it
  shows

#### Scenario: A fulfilment through a tool on an unswitched machine

- **GIVEN** a machine with a legacy `Brain/` tree
- **WHEN** an agent fulfils a pledge an `o2b` process wrote
- **THEN** the file shows it fulfilled

#### Scenario: An entity upsert over a stale index on an unswitched machine keeps the other writer's alias

- **GIVEN** a machine with a legacy `Brain/` tree and an entity whose page
  another writer gave the alias B after this writer's entity index was
  read
- **WHEN** this writer upserts the entity with the alias C
- **THEN** the page holds both B and C (the one change of this release
  on a machine that has not switched)
