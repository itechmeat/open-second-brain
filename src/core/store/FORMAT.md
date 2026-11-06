<!-- open-second-brain-store-format: 1 -->

# Open Second Brain store format

Format version: 1

This document describes the on-disk format of an Open Second Brain brain store: the folder that holds every piece of Open Second Brain machine data outside the user's notes. The format is open and plain text so that any tool, in any language, can read it, and so that several machines and many concurrent agents can write it through an ordinary file-sync tool without conflicts.

A copy of this document is written into the store root and into every partition when a store is created, and refreshed when a newer release ships a newer format version. The copy in a partition travels with the data it describes.

## Contents of the store

The store contains records in plain text JSON. Nothing in it is encrypted. Encryption at rest is the job of the disk or the sync layer the user chooses.

## Layout

```
<store>/
  FORMAT.md                                  this document
  shared/                                    partition, synced to every working machine
    FORMAT.md
    store.json                               store identity
    events/<device>/<YYYY-MM>.jsonl          signals, evidence, notes, feedback
    log/<device>/<YYYY-MM>.jsonl             operational log, lifecycle, continuity
    ledgers/<name>/<device>/<YYYY-MM>.jsonl  idempotency, audit, metrics, receipts, lineage
    topics/<device>/<YYYY-MM>.jsonl          topic events
    settings/<device>/<YYYY-MM>.jsonl        shared settings
    digests/<device>/<YYYY-MM>.jsonl         state digests
    blobs/<sha256[0:2]>/<sha256>             large bodies, immutable
  private/                                   same shape, for private-visibility records
```

### Partitions

A partition is a top-level folder that holds records of one sensitivity. There are two:

- `shared`: records every working machine may hold.
- `private`: records of private visibility, for example personal-scope topics.

Each partition is synced as its own folder, so a user can keep `private` off a given machine (for example a server). The store root itself is never a sync folder, and records never move between partitions. A machine that does not hold a partition works on the partitions it has; a write to a partition the machine does not hold is refused.

### Store identity

Every partition holds `store.json`:

```
{ "store_id": "<ulid>", "format": 1 }
```

The store id is the same in every partition of one store. It keys the device-local state directory on each machine. The file is created once, with an exclusive create, and never rewritten.

A store is created only by an explicit command (`o2b store init`), on one machine; writers never create one. Every other machine receives the partitions, identity files included, through sync. Creation writes the identity file of every partition it was asked for (both by default, or `shared` alone for a machine that must not hold private records) before it reports success. When some of the requested partitions already carry an identity file, creation adds the missing ones with that store id and never mints a second one; the file's content depends only on the store id, so a copy created locally and one delivered by sync are identical. Creation refuses when every requested partition is already held, when the partitions name different store ids, and when a partition folder holds store files without `store.json` (the identity has not arrived yet, or was lost). A writer that finds no store skips its write rather than creating one.

### Streams

A stream is a family of shards inside a partition:

- `events`: signals, evidence, notes and feedback.
- `log`: the operational log, lifecycle and continuity records.
- `ledgers`: named append-only ledgers, one directory per ledger name (`ledgers/<name>/...`). A ledger name is 1 to 64 lowercase letters, digits and hyphens, starting with a letter or digit.
- `topics`: topic events.
- `settings`: settings every machine must agree on.
- `digests`: state digests that let machines compare their folded state.

### Shards

A shard is one file of one stream, written by one device, for one month:

```
<partition>/<stream>/<device>/<YYYY-MM>.jsonl
<partition>/ledgers/<name>/<device>/<YYYY-MM>.jsonl
```

- `<device>` is the writing device's id: lowercase letters, digits and hyphens, at most 32 characters, never starting with `sync-conflict`.
- Every machine accepts the same device ids in records and shard paths, whatever its platform, so folds and digests agree across platforms. Only a machine's choice of its own id depends on the platform: a new id is never a name Windows reserves for a device (`con`, `prn`, `aux`, `nul`, `com1` to `com9`, `lpt1` to `lpt9`), and an existing id that is one of them is refused only on Windows. Such a directory cannot exist on NTFS, so on Windows a peer's device directory under a reserved name is skipped, its records are not read on that machine, and the doctor reports it.
- `<YYYY-MM>` is the UTC month of the physical part of the record's clock.
- A device writes only shards that carry its own device id. Concurrent agents on one device append to the same file. Two machines therefore never write the same file, and a file-sync tool never has to merge one.
- A compaction output may carry a suffix before the extension: `<YYYY-MM>.<suffix>.jsonl`, where the suffix is 1 to 40 lowercase letters, digits and hyphens, starts with a letter or digit, and never starts with `sync-conflict`.
- Any other file name in a stream directory (for example a sync tool's conflict copy) is not a shard and is not read as one.

Every line of a shard is one record, encoded as UTF-8 JSON and terminated by a newline (`\n`). A record is written with a single append, under a lock that is local to the writing device and never stored inside the store. A line, newline included, is at most 16384 bytes long (the line-size cap); a record whose line would be longer has its body spilled into a blob.

## Record envelope

Every record has this shape:

```
{ "v": 1, "id": "<ulid>", "hlc": "<physical_ms>.<counter>", "device": "<device id>",
  "agent": "<agent name>", "kind": "<kind>", "scope": "<scope>" | null,
  "topic": "<topic id>" | null, "sum": "<sha256>", "body": { ... } }
```

Fields:

- `v`: format version of the record, an integer. This document describes version 1.
- `id`: the record id, a ULID (26 Crockford base32 characters, uppercase). Unique across all machines without coordination.
- `hlc`: the record's hybrid logical clock stamp, `<physical_ms>.<counter>`: milliseconds since the Unix epoch, a dot, and a counter. Both parts are non-negative integers without leading zeros.
- `device`: the id of the device that wrote the record. It matches the device segment of the shard path.
- `agent`: the identity of the agent that wrote the record: a non-empty, single-line string of at most 200 characters.
- `kind`: the record kind, 1 to 64 lowercase letters, digits and hyphens, starting with a letter. The kind decides the shape of the body.
- `scope`: the soft category of the record (a non-empty, single-line string of at most 200 characters), or `null`.
- `topic`: the id (a ULID) of the topic the record belongs to, or `null`.
- `sum`: the lowercase hex sha256 of the body's canonical JSON.
- `body`: a JSON object whose shape depends on `kind`.

### Canonical JSON and the checksum

The canonical JSON of a value is its JSON text with object keys sorted by code unit order at every level, array order kept, no whitespace, and object entries whose value is undefined omitted. `sum` is the sha256 of the canonical JSON of `body`, encoded as UTF-8, written as 64 lowercase hex characters. A reader recomputes it from the parsed body, so a body serialised with a different key order still verifies. A body nests objects and arrays at most 64 levels deep, the body object itself counting as one level: a writer never writes a deeper body, and a reader reports a record whose body (inline or in its blob) is deeper as a corrupt line and skips it.

### Blob references

When a line would exceed the line-size cap, the writer stores the body as a blob and writes a blob reference as the line's body:

```
{ "$blob": "<sha256>", "bytes": <length of the blob in bytes> }
```

The key `$blob` is reserved: no record body may use it. The reference's hash equals the record's `sum`, and `bytes` is a non-negative integer.

## Blobs

A blob is an immutable file at `<partition>/blobs/<sha256[0:2]>/<sha256>`. Its content is the canonical JSON of a record body, encoded as UTF-8, and its name is the sha256 of that content, so the name of a blob that holds a record's body is the record's `sum`.

- A blob is written once, with an exclusive create, and never rewritten or appended to. A writer prepares the content in a temp file and links it to the final name; where the filesystem has no hard links (FAT, exFAT) it creates the final name directly, so a reader may briefly see a partly written blob, which it treats as pending.
- A temp file never takes a blob name. A writer keeps it outside the store when it can; otherwise it sits in the blob's folder under a name that starts with `.tmp-`. Readers ignore every name in `blobs/` that starts with a dot, and a sync setup should ignore them too (for example a Syncthing ignore pattern `.tmp-*`).
- A blob file that exists but does not hash to its name can only ever hold one content, so a writer that needs that blob may rewrite it with that content.
- A blob that is referenced but absent, or whose content does not hash to its name, or whose length is not the `bytes` of the reference, is pending: a reader shows the record with its body marked pending and fills the body in on a later read, once the sync tool has delivered the whole file. A reader sizes a blob before it reads it and does not load one larger than 64 MiB.
- A blob that hashes to its name but is not the canonical JSON of a JSON object can never change, since its name fixes its content. A reader skips the record that references it and reports it as a corrupt line.

## Clock rules

Every device keeps a hybrid logical clock and persists it in its device-local state, so it survives restarts.

- Send rule: for each new record, when the wall clock is ahead of the local clock's physical part, the stamp is the wall clock with counter 0; otherwise the physical part stays and the counter increments. The result becomes the local clock. A device's stamps are therefore strictly increasing even when its wall clock steps backwards.
- Receive rule: whenever a device ingests records from other devices, it raises its local clock to at least the largest stamp it ingested. A record written in reply to a remote record therefore orders after it, even when the replying machine's wall clock is behind. A stamp whose physical part is more than one day (86400000 ms) ahead of the device's wall clock is not adopted, so one record from a broken clock cannot move every later stamp into the far future.

Stamps compare by physical part, then by counter.

## Order and folds

All machines order records by `hlc`, then `device`, then `id`, each compared as written (numbers for the clock, code unit order for the strings). The same set of records gives the same order on every machine, in any delivery order. A record that is delivered twice (for example after a file was restored) is applied once, by its `id`.

Entities that change over time (preferences, pinned context, topic fields, assignments and settings) are folds over their records:

- Precedence by authority: a human record beats an agent record, which beats a decision-model record.
- Within one authority, the record with the later clock wins.
- Removal is a tombstone record. A fold never deletes a record; the losing records stay in the history.

A record whose body is still a pending blob is not folded until its body arrives. A record of a fold kind whose body is malformed is not applied; the fold reports it. When two deliveries share an `id` but differ in content, the fold keeps the one that comes first in fold order (then by canonical JSON) and reports the conflict.

### Authority

A record of a mutable entity carries its authority in its body, in the field `authority`. It is part of the body, so the checksum covers it. It is never inferred from the `agent` name, and a mutable-entity record without a valid `authority` is not applied. The values, from the strongest to the weakest:

- `human`: the user decided, through a command, a tool call made on the user's explicit request, or an edit of the human view.
- `agent`: an agent decided on its own.
- `model`: a decision model decided.

### Preferences

A preference is identified by the string in its records' `preference` field. Each field of a preference is its own register, resolved by authority, then clock, so a human change to one field (for example `status`) is not undone by a later agent change while an agent may still change a field no human has set. Whether the preference exists is one more register: every `preference-set` proposes that it exists, a `preference-remove` proposes that it does not. Evidence records never change a field or the existence.

The counters `applied_count`, `violated_count` and `outdated_count` are derived by counting `preference-evidence` records by their `result`. They are never written back: a `preference-set` that names a counter field is ignored for that field, and a `preference-set` that names only counter fields is not applied.

### Pinned context

Pinned context is one register per partition. A `pinned-set` replaces the whole text; an append is written as a `pinned-set` of the full new text. A `pinned-clear` is the tombstone. When two machines replace it at nearly the same time, the replacement with the later clock is shown and the other stays in the history.

### Shared settings

Settings every machine must agree on are records in the `settings` stream of the `shared` partition, never device-local config. Each key is one register, resolved by authority, then clock; a `setting-unset` is the tombstone and the key falls back to its default. Keys are dot-separated lowercase words. Keys this version knows, with their values:

- `view.writer`: the device id of the one device that renders the human view. No default. Moving the role follows the view writer protocol of the release that defines it.
- `view.language`: the language tag (for example `en`, `ru` or `pt-BR`) of generated prose in the human view. No default; the renderer decides.
- `topics.new_min_records`: how many related unassigned records start a new topic, a positive integer. Default 5.
- `topics.new_min_sessions`: from how many sessions those records must come, a positive integer. Default 2.

A record that sets a known key to an invalid value is not applied. A key this version does not know is kept as the JSON value written, so an older reader keeps a newer release's setting instead of losing it.

## Reading

A reader parses each line, checks the envelope and verifies the checksum.

- An incomplete last line (no terminating newline) or a last line that fails verification is skipped and read again on a later pass. It is not treated as deleted: a sync tool may still be delivering the rest of the file.
- A line in the middle of a shard that fails verification is reported as a diagnostic and skipped.
- A record whose `v` is greater than the version a reader understands is skipped and reported, and the reader goes on with the next line.
- A run of bytes longer than the line-size cap without a newline can never be a record. It is reported as a corrupt line and skipped up to the next newline, or to the end of the shard; it is never held back as an incomplete last line. A reader reads a shard in bounded chunks, never whole.
- A record whose `device` is not the device segment of its shard's path is reported as a corrupt line and skipped.
- A record id appears in one partition only: records never move between partitions. A reader that finds an id already read from the other partition keeps the first copy and ignores the second, and a doctor reports the id.

## Trust

Records carry no signature. The checksum detects damage, not forgery: any machine that can write a partition folder, and anything the sync tool delivers into it, can write records under any device id, agent or authority. A machine that syncs a partition is therefore trusted with everything in that partition. The reader's checks (envelope, checksum, line-size cap, device segment, blob shape and size) keep one bad file from stopping the store or reaching outside it; they do not authenticate a peer. Keep `private` only on machines you trust with private records.

A writer never follows a symbolic link (or, on Windows, a junction) below a partition folder: it refuses a stream, ledger, device or blob folder that is a link, and a shard that is a link or has more than one hard link, and writes nothing. A reader opens a shard or blob only when it is a regular file: a link or a special file (a FIFO) under that name is reported and never read through or waited on. The partition folder itself may be a link. Folders the store creates are readable by their owner only (mode `0700`), and so are shards, blobs and `store.json` (mode `0600`), in both partitions; the format document stays readable by everyone.

## Compaction

Shards of closed months are never rewritten, except by compaction on their owning device. Compaction writes the same records to a new shard, then appends a record of kind `compacted` to the same stream of the same device, then removes the old shards. Its body is:

```
{ "replaces": ["<shard path>", ...], "into": ["<shard path>", ...] }
```

Shard paths in the body are relative to the partition and use `/` as the separator, for example `events/dev-a/2026-01.jsonl`. A reader treats a shard named in `replaces` as replaced: its disappearance is expected and is not reported as missing.

## State digests

Machines compare their folded state through digests, one per partition, published in the partition's `digests` stream.

A digest covers an explicit cut: one entry for every shard the publishing machine holds in the partition, excluding the `digests` stream itself, so publishing a digest never changes the cut it is compared on. Shards with no verified record yet are left out. An entry, and the cut, sorted by shard path:

```
{ "shard": "<partition-relative shard path>", "count": <verified records>,
  "last": "<id of the last verified record>", "pending": <records whose blob has not arrived> }
```

`pending` is part of the cut because a record whose blob has not arrived cannot be folded yet; two machines that differ only in a delivered blob have different cuts. The digest carries the sha256 of the canonical JSON of the cut, and for each fold (`preferences`, `pinned`, `settings`) the sha256 of the canonical JSON of the fold's resolved state computed from exactly the records in the cut.

- Comparison: only digests whose cuts are identical are compared, each device's latest digest per cut, among the digests of the last 7 days. A fold whose hash differs between two such digests is reported as divergent, with the devices, the partition and the fold.
- Roster: the devices with records in the partition during the last 30 days, minus the devices retired by a `device-retire` record with `authority` `human`. A retired device that writes a record after its retire record is on the roster again. Retire records are read from the `settings` stream of `shared` and apply to every partition.
- Silence: a roster device that has published no digest in the partition for 7 days is reported as silent, never as divergent. A device first seen less than 7 days ago is not reported yet.

An offline device, an idle device or a machine without a partition therefore never stalls the comparison and never raises a false alarm.

## Record kinds

Record kinds are defined by the stream and the feature that writes them. Kinds this version of the format defines at the store level:

- `compacted`: a compaction replaced the shards in `replaces` with the shards in `into`.

Kinds of the mutable-entity folds, with their bodies (fields marked optional may be absent):

- `preference-set`: `{ "authority", "preference": "<id>", "fields": { "<name>": <json>, ... } }`, written to `events`. Proposes a value for each named field (lowercase words joined by underscores) and that the preference exists.
- `preference-remove`: `{ "authority", "preference": "<id>" }`, written to `events`. The tombstone of a preference.
- `preference-evidence`: `{ "preference": "<id>", "result": "applied" | "violated" | "outdated", "artifact": "<reference>" (optional) }`, written to `events`. One application of a preference; it carries no authority.
- `pinned-set`: `{ "authority", "content": "<text>" }`, written to `events`. Replaces the pinned context.
- `pinned-clear`: `{ "authority" }`, written to `events`. The tombstone of the pinned context.
- `setting-set`: `{ "authority", "key": "<key>", "value": <json, not null> }`, written to `settings` in `shared`.
- `setting-unset`: `{ "authority", "key": "<key>" }`, written to `settings` in `shared`. The tombstone of a setting.

Kinds of the state digests:

- `device-retire`: `{ "authority": "human", "device": "<device id>", "reason": "<text>" (optional) }`, written to `settings` in `shared`. Takes a device off the digest roster.
- `state-digest`: `{ "partition": "shared" | "private", "cut": [<entry>, ...], "cut_hash": "<sha256>", "folds": { "preferences": "<sha256>", "pinned": "<sha256>", "settings": "<sha256>" } }`, written to `digests` in its partition.

Kinds written by the dual writes of format version 1 (a trial: while the dual-write setting is on, the release's existing writers also append these records beside their legacy files). Mutable entities reuse the fold kinds above: preference writes and retires are `preference-set` records of the `pref-<slug>` id (a retire sets `status` to `retired`), apply-evidence is `preference-evidence`, and pinned context is `pinned-set` or `pinned-clear`. Pinned context goes to `private` when the writing machine holds that partition and to `shared` when it does not; a text that carries a `<private>` region (or the placeholder a stripped one leaves) or links a private page goes to `private` only. A `pinned-clear` is judged by the text it clears, so it lands where that text's `pinned-set` did. The two partition registers are not merged: a machine that holds `private` writes its sets and clears there, a machine that does not writes them to `shared`, and each partition's register (and its digest) reflects only the records in that partition.

All records one write produces land in one partition. The write is judged once: it is private when the page it writes or is about is private (or cannot be read), or when any of its content fields (a signal's principle, sources and raw text, a preference's principle, evidence and relationship fields, an event's text or artifact) carries a `<private>` region, links a private page, or names a preference whose page is not on disk; its own id, generated paths, hashes, timestamps, keys and agent names are not judged as links. That one verdict places every record of the write: a signal and its `idempotency` receipt, the records of a preference write, an apply-evidence event with its `preference-evidence` record and receipt, a pin's `preference-set` and its event, and every event and receipt of a write batch.

Every dual-written body also carries `"vault_id": "<id>" | null`: the id in the `Brain/vault-id.json` marker of the vault the legacy write went to, or `null` when that vault has no marker. One store serves every vault on a machine. In format version 1 the field only records where a record came from: the search index of each vault reads every record of the store, and nothing filters by it yet. A later version decides whether a vault reads only its own records.

The other kinds:

- `signal`: `{ "id": "<signal id>", "path": "<vault-relative path of the signal file>", "staged": <bool>, "frontmatter": { ... }, "raw": "<text>" | null }`, written to `events`. One captured taste signal, with the frontmatter its file carries and its raw text.
- `log-event`: `{ "timestamp": "<ISO-8601>", "event_type": "<kind>", "body": { ... } }`, written to `log`. One operational log event, including notes and apply-evidence. An event goes to `shared`, except one that names a private page (a preference, or any page it links, in any field or inside its text), carries a `<private>` region, or belongs to a private write, which goes to `private` only; a preference id whose page is not on disk counts as private.
- `ledger-row`: `{ "row": <json> }`, written to `ledgers/<name>`. One row of an append-only ledger, as the ledger wrote it. Rows go to `shared`, with these exceptions. A row that names a private page goes to `private` only: every string the row carries is judged, at any depth, so a `<private>` region, a link or path to a private page, a preference id whose page is private or not on the writing machine (it cannot be judged), or a path outside the vault sends the row to `private` only. This covers `idempotency` receipts (a receipt for a write about a private preference too), `recurrence` events (a source that is a private page, or a link or `.md` path that names no page, as for a truth claim), `continuity`, `metrics`, `maintenance-journal`, `verifier-rejections` (also when a session turn the rejected proposal was drawn from is flagged `private`), `edit-history` and `decision-receipts` rows. A `continuity` row flagged `private` (a `<private>` region was stripped from it, or its writer said so) goes to `private` only. `lineage` rows (which sessions ran in which working directory, repository and branch), `query-demand` rows (what the user searched for), `permissions` rows (which writes were allowed or refused, and on what) and `git-commits` rows (commit messages and paths) go to `private` when the writing machine holds that partition and to `shared` when it does not. `truth-claims` rows go to `private` when the writing machine holds that partition and to `shared` when it does not; a claim whose source is a private page, or a link or `.md` path that names no page on the writing machine, goes to `private` only. Audit rows, `preference-audit` and `reliability-audit` (which every audit trail shares, secret custody included, named by the row's `audit_dir`), follow the same rule: `private` when the writing machine holds it, else `shared`; an audit row about a private preference still goes to `private` only. Ledger names: `idempotency`, `continuity`, `metrics`, `lineage`, `permissions`, `git-commits`, `reliability-audit`, `maintenance-journal`, `verifier-rejections`, `preference-audit`, `edit-history`, `decision-receipts`, `truth-claims`, `query-demand` and `recurrence`.

Every other kind is defined by the feature that writes it, and a reader that does not know a kind keeps the record and leaves its body alone.

## Device-local state

Each machine keeps a device-local directory outside the store, keyed by the store id: append locks, the persisted clock, blob temp files, the search index, caches, hook state and snapshots. It is never synced. Sync only the partition folders, each as its own sync folder; never sync the store root or the device-local directory as a whole.

## Versioning

The format version is the integer `v` in every record and the `format` field of `store.json`.

- A change that every reader of the current version can still read keeps the version.
- A change that an older reader would misread raises the version. An older reader then skips the newer records and reports them, and never rewrites them.
- A release may refresh `FORMAT.md` in a partition only with a document of the same or a newer format version; an older release never replaces a newer document.
