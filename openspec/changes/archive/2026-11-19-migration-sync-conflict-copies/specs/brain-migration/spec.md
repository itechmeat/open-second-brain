# Spec Delta

## Purpose

A vault synced between machines by a sync tool collects that tool's conflict copies and in-flight temp files. They are not unknown files: a conflict copy is another version of a file the migration reads, and a temp file is that file on its way. This modifies the dry-run requirement of `brain-migration` so that these files no longer stop a migration, and adds the rule for what each becomes.

## MODIFIED Requirements

### Requirement: Dry run first
The migration command SHALL support a dry run that writes nothing and reports, per source path, how many items would move, to which stream or view page, and which items it cannot map. A sync tool's conflict copy of a file a mapping reads, and a sync tool's in-flight temp file, SHALL NOT be an unmapped entry; the dry run and the migration report (text and `--json`) SHALL carry a section that says, per surface, how many conflict-copy items would be or were imported as records, how many were identical to their original and added nothing, which copies were kept in the backup and not imported (each named with the file it is a version of), how many were dropped with their original's rule, and how many temp files were ignored. An entry the product does not know, a conflict copy of such an entry included, SHALL stay unmapped and SHALL stop the run. A file the product itself keeps beside a mapped file (the search index store's own database files and their journals, a writer's temp file, a lock) SHALL follow that file's rule and SHALL NOT be an unmapped entry.

#### Scenario: Dry run on a live install
- **WHEN** the user runs the migration with the dry-run flag
- **THEN** no file changes anywhere, and the report lists counts per source and every unmapped item

#### Scenario: A vault synced by Syncthing between two machines
- **WHEN** the legacy tree holds Syncthing conflict copies of log shards, audit week shards, signal pages, the pinned context, the freshen state and a lock, and a `.syncthing.*.tmp` file
- **THEN** the dry run exits 0, lists none of them as unmapped, and its sync conflict copies section names what each would become

#### Scenario: An unknown file and a copy of it
- **WHEN** the legacy tree holds a file no mapping covers and a conflict copy of it
- **THEN** both are unmapped entries and the dry run exits 1

## ADDED Requirements

### Requirement: Sync tool names are recognised in one place
One function SHALL recognise the conflict copies of the sync tools the product names (the Syncthing `.sync-conflict-<date>-<time>-<device>` marker, the Dropbox and Nextcloud `(... conflicted copy <date> ...)`) and give the name of the file a copy is a version of, and one sibling SHALL recognise their in-flight temp files (`.syncthing.<name>.tmp`, `~syncthing~<name>.tmp`, the Nextcloud `.<name>.~<hex>`). A name that only contains the word conflict SHALL match neither.

#### Scenario: A note about conflicts
- **WHEN** the legacy tree holds `Brain/inbox/conflict-notes.md`
- **THEN** it is read as the signal page it is, not as a conflict copy

### Requirement: A record-shaped conflict copy is imported exactly once
A conflict copy SHALL take the destination of the file it is a copy of. A JSONL copy's rows SHALL be imported like its original's; a row whose records its original or an earlier copy holds SHALL be stored once, and any other row SHALL be imported under a key built from the copy's own path and line, exactly once while the copy file is unchanged, across a resumed run, a later machine with the same copy and the transition import. A row a person later moves into the original, or a copy rewritten with its rows at other lines, is a new row and SHALL be imported as one. The rollback SHALL restore the copy byte for byte and SHALL NOT write its rows into the original.

#### Scenario: A row only the copy holds
- **WHEN** a Brain log shard and its conflict copy share one row and the copy holds one more
- **THEN** the store holds the shared row once and the copy's own row once, and a resumed run, a later machine and the transition import add no second record

#### Scenario: A copy that arrives after the switch
- **WHEN** sync delivers a conflict copy of a log shard to a machine that already switched
- **THEN** the transition import imports its own rows once

### Requirement: A differing version is kept, not merged
A copy of a one-item-per-file record (a signal page, a preference page, a lane entry) or of a single document (the pinned context, the settings file) that equals its original SHALL add nothing. One that differs SHALL be kept in the migration backup and named in the report as kept, not imported, never merged and never a second record; a record copy whose original is gone SHALL be imported as that item. After the switch the doctor SHALL name the kept copies once, as advice that stops nothing.

#### Scenario: Two versions of one signal
- **WHEN** a signal page has two conflict copies that differ from it
- **THEN** the signal is imported once, both copies are kept in the backup and named as kept, not imported, and the doctor names them once as advice

### Requirement: Dropped copies and temp files never block
A copy of a device-local, derived or dropped surface SHALL follow its original's rule and SHALL never be moved into device-local state. A sync temp file SHALL be ignored by the dry run, every import pass, the transition import and the removal's convergence check, and counted in the report; once it becomes the real file, the next pass SHALL import it. The removal SHALL move every conflict copy and temp file to its archive with the tree.

#### Scenario: A temp file that becomes the real file
- **WHEN** a `.syncthing.<name>.tmp` file is renamed onto its real name between two passes
- **THEN** the next pass imports the file and the migration verifies it

#### Scenario: The removal with copies present
- **WHEN** the legacy tree leaves the vault while it holds conflict copies and a temp file
- **THEN** the removal converges and every copy and the temp file are in its archive

### Requirement: A running migration says how far it is
While a migration of this machine runs, the status block and the doctor SHALL say how many legacy items its import has journaled of about how many its dry run planned, read from a small file the run rewrites after every batch it writes, never by counting the journal.

#### Scenario: Status during a long import
- **WHEN** the automatic migration has imported part of a large vault
- **THEN** the status block and the doctor name the run as running and say how many legacy items it has imported so far of about how many
