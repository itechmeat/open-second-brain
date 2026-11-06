# Spec Delta

## Purpose

Brain migration moves an existing install whose machine data lives in `<vault>/Brain/` into the brain store and the human view, safely for every user of the public product, without losing evidence and without breaking agents mid-transition.

## ADDED Requirements

### Requirement: One migration command
The product SHALL ship one migration command that converts an existing legacy brain (every `Brain/` lane and the per-vault state under `.open-second-brain/`) into the brain store and the human view. The command SHALL be idempotent and resumable: re-running it after an interruption SHALL continue where it stopped and SHALL never duplicate records. An upgrade SHALL offer it but SHALL NOT run it without the user's consent.

#### Scenario: Interrupted migration
- **WHEN** the migration is killed halfway and run again
- **THEN** it continues from the last verified item, and the store holds every legacy record exactly once

#### Scenario: Upgrade on a legacy install
- **WHEN** a user upgrades to the release on a legacy layout
- **THEN** status and doctor say a migration is available and name the command, and nothing moves until the user runs it

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
The legacy tree SHALL leave the vault only when every device in the durable migration cohort (every device id found in the legacy tree, with no age limit) has switched or been retired, or when the user forces it with a report naming the devices that will stop receiving data.

#### Scenario: All machines switched
- **WHEN** every roster device has switched and the view target is inside the vault
- **THEN** the vault holds the view folder and the user's own notes, and no other Open Second Brain file

#### Scenario: One machine still on the old release
- **WHEN** machine B has not upgraded yet
- **THEN** the legacy tree stays in the vault, B keeps working on it, and doctor on upgraded machines names B as still on the legacy layout

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
Doctor SHALL report when a legacy `Brain/` machine directory reappears in the vault after migration, and SHALL name the writer when the file carries one.

#### Scenario: Agent follows stale instructions
- **WHEN** an agent creates `Brain/preferences/` in the vault after migration
- **THEN** doctor reports the directory and the agent name found in it

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
