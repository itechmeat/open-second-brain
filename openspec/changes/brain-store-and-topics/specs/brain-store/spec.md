# Spec Delta

## Purpose

The brain store holds every piece of Open Second Brain machine data outside the user's notes, in an open documented format that several machines and many concurrent agents can write without conflicts and that converges to the same state everywhere.

## ADDED Requirements

### Requirement: Store location independent of the vault
The store SHALL live at a configurable root directory that is not inside a configured vault. When no root is configured, a per-user default data directory SHALL be used. A configured root inside the vault SHALL be refused, and doctor SHALL name the cause.

#### Scenario: Default root
- **WHEN** Open Second Brain starts with no store root configured
- **THEN** it uses the per-user default data directory and reports it in status

#### Scenario: Root inside the vault
- **WHEN** the store root is configured to a path inside the vault
- **THEN** every write refuses with an error naming the setting, and doctor reports the same

### Requirement: Store works without a vault
Every memory operation (feedback, evidence, notes to the log, pinned context, search over brain records, dream, briefs) SHALL work when no vault is configured.

#### Scenario: No vault configured
- **WHEN** an agent records feedback and later searches for it on a machine with no vault configured
- **THEN** both calls succeed and the search returns the record

### Requirement: One writer device per stream file
Stream records SHALL be appended to files named by partition, stream, device and month (`<partition>/<stream>/<device>/<YYYY-MM>.jsonl`). A device SHALL write only files that carry its own device id. Concurrent agents on one device SHALL append to the same device file.

#### Scenario: Two machines write at once
- **WHEN** agents on machines A and B each record feedback within the same second
- **THEN** A's record is in a file named with A's device id and B's in one named with B's, and file sync creates no conflict copy

#### Scenario: Two agents on one machine
- **WHEN** two agent processes on one device append records concurrently
- **THEN** both records are present, each as one complete line, in that device's file

### Requirement: Record envelope
Every stream record SHALL carry a format version, a unique id, a hybrid logical clock stamp, the device id, the agent identity, the record kind and a content checksum. The envelope SHALL be documented in a public format document shipped with the product.

#### Scenario: Record shape
- **WHEN** any record is written
- **THEN** the line parses as JSON with the fields `v`, `id`, `hlc`, `device`, `agent`, `kind`, `sum` and a kind-specific body, and the checksum verifies

### Requirement: Torn and unverified lines
A reader SHALL skip a trailing line that is incomplete or fails its checksum, and SHALL read it again on a later pass. It SHALL NOT treat the line as deleted. A middle line that fails verification SHALL be reported by doctor.

#### Scenario: Half-synced last line
- **WHEN** a shard arrives by file sync with its last line cut mid-record
- **THEN** reads return every complete record before it, and after the rest arrives the next read returns the completed record

### Requirement: Deterministic order and fold
All machines SHALL order records by hybrid logical clock, then device id, then record id. Every catch-up SHALL raise the local clock to the largest clock ingested, so a record written in reply to a remote record orders after it. Reading the same set of records in any delivery order SHALL produce the same folded state.

#### Scenario: Different delivery order
- **WHEN** machine A receives B's shard before C's and machine D receives C's before B's
- **THEN** after both have all three shards, A and D compute the same folded state

#### Scenario: Reply from a machine with a slow clock
- **WHEN** machine B, whose wall clock is two minutes behind, records a correction to a decision it received from machine A
- **THEN** every machine folds the correction after A's decision

#### Scenario: Duplicate delivery
- **WHEN** the same record arrives twice, for example after a file was restored
- **THEN** the fold applies it once

### Requirement: Mutable entities resolve by authority then time
Entities that change over time (preferences, pinned context, topic fields, assignments) SHALL be folded from their records. A human record SHALL beat an agent record, which SHALL beat a decision-model record. Within one authority, the later clock SHALL win. Removal SHALL be a tombstone record; nothing SHALL be physically deleted by a fold.

#### Scenario: Concurrent edits to pinned context
- **WHEN** agents on two machines replace pinned context at nearly the same time
- **THEN** every machine shows the replacement with the later clock, and the other remains in the history

#### Scenario: Human beats a later agent edit
- **WHEN** the user retires a preference and an agent later records evidence that would confirm it
- **THEN** the preference stays retired and the evidence is kept in its history

### Requirement: Large bodies as content-addressed blobs
Bodies too large for a stream line (reports, source summaries, distillations, payloads, archived source text) SHALL be stored as immutable files named by their content hash and referenced from a record. A blob SHALL never be rewritten.

#### Scenario: Blob not yet arrived
- **WHEN** a record arrives that references a blob file not yet delivered
- **THEN** reads show the record with its body marked pending, the next catch-up fills it in, and doctor reports blobs still missing after a day

#### Scenario: Report stored
- **WHEN** an agent saves a research report
- **THEN** its text is in a blob named by its hash, a record references the blob, and the human view shows the report after the next render

### Requirement: State digest across machines
Each machine SHALL publish, per partition, a digest of each fold together with the exact cut of records it covers, excluding digest records from the cut. Doctor SHALL compare only digests with identical cuts and SHALL report a mismatch. The roster SHALL be the devices with records in the last 30 days minus retired devices.

#### Scenario: Offline device does not stall checks
- **WHEN** one laptop has been offline for two weeks
- **THEN** the other machines keep comparing digests among themselves, and doctor reports the laptop as silent, not as divergent

#### Scenario: Divergence detected
- **WHEN** a fold bug makes machine A's preference state differ from machine B's for the same records
- **THEN** doctor on either machine reports the divergence with both device ids and the stream

### Requirement: Device-local state stays local
Locks, caches, leases on local resources, hook state, the derived index and snapshots SHALL live in a device-local directory that is not part of the synced store. The setup guide SHALL list the `shared` and `private` partition folders as separate sync folders and SHALL say never to sync the store root or the device-local directory as a whole.

#### Scenario: Cache never syncs
- **WHEN** the store folder is synced to another machine
- **THEN** no lock, cache, index or snapshot file of the first machine appears on the second

### Requirement: Bounded growth
Caches SHALL be pruned by age or count. Stream files of closed months SHALL never be rewritten except by compaction on their owning device, which SHALL write the same records to a new file, then a `compacted` record naming the old and new files, then remove the old file. Readers SHALL treat a shard named in a `compacted` record as replaced and SHALL not report its disappearance.

#### Scenario: Prompt cache does not grow without bound
- **WHEN** an agent runs thousands of turns over a month
- **THEN** the context-pack cache holds no entries older than its time to live after the next prune

### Requirement: Snapshots per device
Snapshots and rollback SHALL keep working with the store. Snapshots SHALL be device-local and unsynced. Every snapshot reason, upgrades included, SHALL obey the retention limit, and retention SHALL keep the newest recovery points by the creation time recorded in each manifest, not by file mtime.

#### Scenario: Upgrade snapshots are pruned
- **WHEN** more upgrade snapshots exist than the retention count
- **THEN** the oldest ones by manifest order are removed, and the most recent recovery point that rollback needs is kept

### Requirement: Transport agnostic
The store SHALL work on a single machine with no sync, and with any file-sync tool that copies whole files (for example Syncthing, a cloud drive folder or a network share). It SHALL NOT require a server, a specific sync tool or a network connection to write.

#### Scenario: Single machine
- **WHEN** a user runs Open Second Brain on one laptop with no sync configured
- **THEN** every operation works and doctor reports no sync warning

#### Scenario: Offline write
- **WHEN** a laptop with no network records feedback and later reconnects
- **THEN** the record reaches the other machines through the user's sync tool and every machine converges

### Requirement: Sensitivity partitions
The store SHALL keep records in partitions by sensitivity, at least `shared` and `private`, each a separate top-level folder. Records SHALL go to the partition of their visibility, and personal-scope topics SHALL default to `private`. A user SHALL be able to sync each partition to a different set of machines, for example keeping `private` off a server. A machine without a partition SHALL work on the partitions it has and SHALL never move records between them.

#### Scenario: Private partition kept off a server
- **WHEN** a user syncs `shared` to a server but not `private`
- **THEN** agents on the server see shared records and topics only, and personal topics are absent there without errors

#### Scenario: Private record written on a machine without the partition
- **WHEN** an agent on a machine that has no `private` partition records a private item
- **THEN** the write is refused with a message saying this machine does not hold the private partition

### Requirement: Threat model is documented
The product SHALL document what the store contains in plain text, which partitions exist, what leaves the machine through sync and decision models, and that encryption at rest is the user's sync or disk layer's job.

#### Scenario: Docs read before setup
- **WHEN** a user reads the setup guide
- **THEN** it states, per partition, what is stored, where it goes and how to keep it off a given machine

### Requirement: Shared store settings
Settings that every machine must agree on (the view writer, topic thresholds, the view language, decision-model use modes for shared folds) SHALL be stored as records in the store, not in device-local config.

#### Scenario: Setting changed on one machine
- **WHEN** the user changes the topic creation threshold on machine A
- **THEN** machine B applies the new threshold after the record syncs
