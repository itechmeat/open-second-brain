# Spec Delta

## Purpose

The brain index gives every machine fast local search and reads over the brain store, and over the user's notes when a vault is configured, as a derived per-device cache that can always be rebuilt and is never synced.

## ADDED Requirements

### Requirement: Derived and device-local
The index SHALL be built only from the store and, when configured, the vault. It SHALL live in device-local state and SHALL NOT be synced. Deleting it SHALL lose no information.

#### Scenario: Index deleted
- **WHEN** the index file is deleted and a search runs
- **THEN** the index is rebuilt from the store and the vault, and the search returns the same results as before

### Requirement: Catch-up before reads
Before answering a read, the index SHALL ingest every record appended to store files since its last watermark for each file. When nothing changed, the check SHALL cost one metadata lookup per stream file and no file reads. A shard whose file identity changed, that shrank, or whose verified prefix no longer matches SHALL be re-read from the start, and the re-read SHALL be idempotent.

#### Scenario: Record from another machine
- **WHEN** a record from machine B arrives by file sync and an agent on machine A searches right after
- **THEN** the search on A includes B's record without a manual reindex

#### Scenario: Same-size replacement
- **WHEN** a shard file is replaced by a different file of the same size
- **THEN** the next catch-up detects the new identity, re-reads it, and the index holds each record once

#### Scenario: Nothing changed
- **WHEN** no store file changed since the last read
- **THEN** the read opens no store file

### Requirement: Cheap change probe
The index SHALL expose a "what is new since watermark W" query that returns new record ids by stream, scope and topic, so agents and hooks can poll without running a search.

#### Scenario: Probe after a neighbour's write
- **WHEN** another agent records a decision on topic T after watermark W
- **THEN** the probe for W returns that record id under topic T

### Requirement: Rebuild on format change
When the record format version, the index schema or the chunker changes, the index SHALL rebuild in the background into a new file and swap it in only when complete. Reads during the rebuild SHALL use the old index.

#### Scenario: Upgrade with a new schema
- **WHEN** a new release raises the index schema version
- **THEN** reads keep working on the old index while the new one builds, and the swap happens without a failed read

### Requirement: Unknown record versions
A record whose format version is newer than the reader understands SHALL be skipped and reported by doctor. It SHALL NOT stop the rest of the file from being indexed.

#### Scenario: Older binary meets newer records
- **WHEN** a machine running an older release reads a record with a higher version
- **THEN** that record is skipped, the rest are indexed, and doctor tells the user to upgrade that machine

### Requirement: Search covers brain and notes separately
Search SHALL distinguish brain records from user notes, and SHALL let a caller limit a query to either. Brain records SHALL never be indexed as if they were user notes.

#### Scenario: Notes only
- **WHEN** a user asks for notes about a subject
- **THEN** the results contain user notes only, with no signals, log events or preferences
