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
- Receive rule: whenever a device ingests records from other devices, it raises its local clock to at least the largest stamp it ingested. A record written in reply to a remote record therefore orders after it, even when the replying machine's wall clock is behind. A stamp whose physical part is more than one day (86400000 ms) ahead of the device's wall clock is not adopted, so one record from a broken clock cannot move every later stamp into the far future. Reading a record counts as ingesting it: a record that replaces or removes one its writer read orders after it.

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

The field `text` carries the preference page's body, the Markdown below its frontmatter, when the body holds prose the other fields do not render: an imported memory's text, a person's notes under the page's headings, or a writer's guidance on how to apply the rule. A body that is only the `## Origin` list of `evidenced_by` (and, once retired, the `## Retired` section built from the retire fields) carries no prose, and its `text` is absent or `null`. Like every field, `text` is a register resolved by authority, then clock, so prose a human wrote is not replaced by a later agent write. A page rebuilt from the fold carries `text` as its body, not as a frontmatter key; with no `text`, the body is rendered from the fields.

The counters `applied_count`, `violated_count` and `outdated_count` are derived by counting `preference-evidence` records by their `result`. They are never written back: a `preference-set` that names a counter field is ignored for that field, and a `preference-set` that names only counter fields is not applied.

### Pinned context

Pinned context is one register per partition. A `pinned-set` replaces the whole text; an append is written as a `pinned-set` of the full new text. A `pinned-clear` is the tombstone. When two machines replace it at nearly the same time, the replacement with the later clock is shown and the other stays in the history.

### Shared settings

Settings every machine must agree on are records in the `settings` stream of the `shared` partition, never device-local config. Each key is one register, resolved by authority, then clock; a `setting-unset` is the tombstone and the key falls back to its default. Keys are dot-separated lowercase words. Keys this version knows, with their values:

- `view.language`: the language tag (for example `en`, `ru` or `pt-BR`) of generated prose in the human view. No default; the renderer decides.
- `topics.new_min_records`: how many related unassigned records start a new topic, a positive integer. Default 5.
- `topics.new_min_sessions`: from how many sessions those records must come, a positive integer. Default 2.

Keys `brain.<block>.<field>` (and `brain.<key>` for a scalar) hold the settings of a vault's legacy `_brain.yaml` that every machine must agree on. The migration from the legacy layout writes only the values the user changed from the shipped default, with `authority` `human`; a value equal to its default is not written, and the key falls back to that default. Their values are the JSON the file held.

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

## Removal

A tombstone takes an entity out of every read at once: `signal-removed` forgets a signal, `preference-remove` removes a preference (the fold then keeps no field of it, so neither the principle nor the prose `text` is read), and `lane-entry-remove` removes a lane entry. Readers, rendered pages and the search index never show voided content: the index takes every voided record out once it has read the tombstone.

The shards are append-only, so the original lines stay in them, on this machine and on every machine the shards sync to, until store compaction exists (a later phase; see "Compaction"). Compaction is what will rewrite a closed shard without the voided lines. Until then `o2b brain doctor` reports how many records of removed content still await compaction (`store-removed-awaiting-compaction`). A lane tombstone that is the old half of a move (an archive move writes the tombstone and the new entry together) removes nothing and is not counted.

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
- `preference-evidence`: `{ "preference": "<id>", "result": "applied" | "violated" | "outdated", "artifact": "<reference>" (optional), "merged_from": "<record id>" (optional) }`, written to `events`. One application of a preference; it carries no authority. A merge copies each evidence record of the dropped preference to the kept one with `merged_from` naming the copied record, so a merge retried after a partial run copies each record once.
- `pinned-set`: `{ "authority", "content": "<text>" }`, written to `events`. Replaces the pinned context.
- `pinned-clear`: `{ "authority" }`, written to `events`. The tombstone of the pinned context.
- `setting-set`: `{ "authority", "key": "<key>", "value": <json, not null> }`, written to `settings` in `shared`.
- `setting-unset`: `{ "authority", "key": "<key>" }`, written to `settings` in `shared`. The tombstone of a setting.

Kinds of the state digests:

- `device-retire`: `{ "authority": "human", "device": "<device id>", "reason": "<text>" (optional) }`, written to `settings` in `shared`. Takes a device off the digest roster, and out of the devices a removal of the legacy tree waits for. The user writes it (`o2b store device retire`) on a machine other than the one retired; the record's own `device` field is the writing machine, the body's `device` the retired one. A reason that would route the record to `private` is refused, since every machine reads retirements from `shared`. A retired device that writes a record after its retire record is on the roster again and is reported by doctor.
- `state-digest`: `{ "partition": "shared" | "private", "cut": [<entry>, ...], "cut_hash": "<sha256>", "folds": { "preferences": "<sha256>", "pinned": "<sha256>", "settings": "<sha256>" } }`, written to `digests` in its partition.

Kinds written by the dual writes of format version 1 (a trial: while the dual-write setting is on, the release's existing writers also append these records beside their legacy files). Mutable entities reuse the fold kinds above: preference writes and retires are `preference-set` records of the `pref-<slug>` id (a retire sets `status` to `retired`), apply-evidence is `preference-evidence`, and pinned context is `pinned-set` or `pinned-clear`. Pinned context goes to `private` when the writing machine holds that partition and to `shared` when it does not; a text that carries a `<private>` region (or the placeholder a stripped one leaves) or links a private page goes to `private` only. A `pinned-clear` is judged by the text it clears, so it lands where that text's `pinned-set` did. The two partition registers are not merged: a machine that holds `private` writes its sets and clears there, a machine that does not writes them to `shared`, and each partition's register (and its digest) reflects only the records in that partition.

All records one write produces land in one partition. The write is judged once: it is private when the page it writes or is about is private (or cannot be read), or when any of its content fields (a signal's principle, sources and raw text, a preference's principle, evidence and relationship fields, an event's text or artifact) carries a `<private>` region, links a private page, or names a preference whose page is not on disk; its own id, generated paths, hashes, timestamps, keys and agent names are not judged as links. That one verdict places every record of the write: a signal and its `idempotency` receipt, the records of a preference write, an apply-evidence event with its `preference-evidence` record and receipt, a pin's `preference-set` and its event, and every event and receipt of a write batch.

One exception: a `lane-entry-remove` carries no content, so it lands in the partition of the entry it removes, whatever the rest of its write is. A folder move or removal places each entry and its tombstone in that entry's own partition (a moved entry can still be raised to `private`, never lowered), and a write that raises a shared lane entry to `private` writes the entry's shared tombstone first, in the same write. A device that holds only `shared` then sees a shared entry go, and a device that holds both reads the private value, whose clock is later.

Every dual-written body also carries `"vault_id": "<id>" | null`: the id in the `Brain/vault-id.json` marker of the vault the legacy write went to, or `null` when that vault has no marker. One store serves every vault on a machine. In format version 1 the field only records where a record came from: the search index of each vault reads every record of the store, and nothing filters by it yet. A later version decides whether a vault reads only its own records.

The other kinds:

- `signal`: `{ "id": "<signal id>", "path": "<vault-relative path of the signal file>", "staged": <bool>, "frontmatter": { ... }, "raw": "<text>" | null, "raw_shape": "bare" | "page" }`, written to `events`. One captured taste signal, with the frontmatter its file carries and its raw text. `raw_shape` says what `raw` holds: `bare`, the raw text a writer captured, or `page`, the whole body of an imported page (its `## Raw` heading included, still compressed when the page carried `_raw_codec`). A record written before the field existed is read as `page` when one of its first three lines is the `## Raw` heading. A switched machine mints the id with a device tag, the first six hex characters of the SHA-256 of its device id (`sig-<date>-<slug>-<tag>`, then `-2`, `-3` on that device), because it checks a new id only against its own view of the fold; an id minted before the tag, and every imported legacy id, stays as written. Write-session lane entries take the same tag (`ws-<yyyymmdd>-<hhmmss>-<tag>`).
- `log-event`: `{ "timestamp": "<ISO-8601>", "event_type": "<kind>", "body": { ... } }`, written to `log`. One operational log event, including notes and apply-evidence. An event goes to `shared`, except one that names a private page (a preference, or any page it links, in any field or inside its text), carries a `<private>` region, or belongs to a private write, which goes to `private` only; a preference id whose page is not on disk counts as private.
- `ledger-row`: `{ "row": <json> }`, written to `ledgers/<name>`. One row of an append-only ledger, as the ledger wrote it. Rows go to `shared`, with these exceptions. A row that names a private page goes to `private` only: every string the row carries is judged, at any depth, so a `<private>` region, a link or path to a private page, a preference id whose page is private or not on the writing machine (it cannot be judged), or a path outside the vault sends the row to `private` only. This covers `idempotency` receipts (a receipt for a write about a private preference too), `recurrence` events (a source that is a private page, or a link or `.md` path that names no page, as for a truth claim), `continuity`, `metrics`, `maintenance-journal`, `verifier-rejections` (also when a session turn the rejected proposal was drawn from is flagged `private`), `edit-history` and `decision-receipts` rows. A `continuity` row flagged `private` (a `<private>` region was stripped from it, or its writer said so) goes to `private` only. `lineage` rows (which sessions ran in which working directory, repository and branch), `query-demand` rows (what the user searched for), `permissions` rows (which writes were allowed or refused, and on what) and `git-commits` rows (commit messages and paths) go to `private` when the writing machine holds that partition and to `shared` when it does not. `truth-claims` rows go to `private` when the writing machine holds that partition and to `shared` when it does not; a claim whose source is a private page, or a link or `.md` path that names no page on the writing machine, goes to `private` only. Audit rows, `preference-audit` and `reliability-audit` (which every audit trail shares, secret custody included, named by the row's `audit_dir`), follow the same rule: `private` when the writing machine holds it, else `shared`; an audit row about a private preference still goes to `private` only. Ledger names: `idempotency`, `continuity`, `metrics`, `lineage`, `permissions`, `git-commits`, `reliability-audit`, `maintenance-journal`, `verifier-rejections`, `preference-audit`, `edit-history`, `decision-receipts`, `truth-claims`, `query-demand` and `recurrence`.

Kinds of the signal lifecycle (a captured signal moves on after its `signal` record: the dream pass consumes or archives it, a user retires it, the write approval lane approves or rejects it):

- `signal-state`: `{ "authority", "signal": "<signal id>", "state": <state> (optional), "fields": { "<name>": <json>, ... } (optional) }`, written to `events`. One move of the signal `signal`, a change of some of its frontmatter fields (`null` removes a field), or both; at least one of `state` and `fields` is present. The states: `consumed` (the dream pass used it), `archived` (it left the contradiction window unused), `retired` (retired by hand, with the retire metadata as `fields`), `expired` (its lifetime ended), `staged` (waiting for write approval), `approved` (approved, so active again) and `rejected` (rejected, out of the brain). A record lands in the partition of the signal it moves.

The signal fold: a signal starts active, or staged when its `signal` record says `staged`. Its state is one register and each field one register per signal, resolved by the clock alone, the later record winning whoever made it, since a lifecycle is a sequence of moves; `authority` says who decided and is kept for the history. A `signal-state` record without a valid `authority`, signal id, state or fields is not applied. A record whose `signal` record has not arrived is kept until it does.

- `signal-removed`: `{ "authority", "signal": "<signal id>" }`, written to `events`. The signal is forgotten: a user asked for it to be removed (for example `o2b brain delete-by-source`), not merely retired. Every record of the signal before the tombstone in fold order is void: the fold drops the signal, its frontmatter and its raw text, and no reader, page or search index shows them. A `signal` record later in fold order is a new capture under the same id and starts the signal over. The record lands in the partition of the signal it forgets: one tombstone in each partition that holds the signal, the `shared` one first, so a removal is the one operation whose records span two partitions. A removal interrupted between its tombstones is finished by running it again. See "Removal" for what the shards still hold.

Kinds of the human view (the readable Markdown pages one device, the view writer, renders into a folder the user chooses). The view writer is named by the three `settings` records below, all in `shared`, folded in order: when no writer is known the first claim in fold order (the lowest clock, then device) takes the role and every later claim is ignored; a request with no writer known takes the role at once, a forced request takes it at once, any other request waits until the current writer releases it, a newer request replaces a waiting one, and a request by the current writer cancels it. Claims and requests carry `authority` `human` and name the device that writes them; a release counts only when the current writer wrote it for the waiting request. No setting key names the view writer; the role lives in these records only. A device whose own claim gave it the role renders only from its second catch-up after the claim, so a rival claim with a lower clock has one catch-up to arrive; when sync takes longer than that, both devices may render once before the lower claim reaches the other, and the loser stops at its first catch-up after it.

- `view-writer-claim`: `{ "authority": "human", "device": "<device id>" }`, written to `settings` in `shared` by the first machine that creates or migrates the store.
- `view-writer-request`: `{ "authority": "human", "device": "<device id>", "force": <bool> }`, written to `settings` in `shared`: the user asks for the role on that device.
- `view-writer-released`: `{ "request": "<request record id>", "device": "<the releasing writer>", "to": "<device id>" }`, written to `settings` in `shared` by the writer once it has finished any render in progress.
- `view-render`: `{ "page": "<page path>", "sum": "<sha256 of the page bytes>", "base": "<blob sha256>", "bytes": <length> }`, written to `log` in `shared` after the page holds those bytes. The blob is the canonical JSON of `{ "page", "text", "keys" }`: the page text and, per line, the key of the record it shows (or `null`), the merge base of the next render.
- `view-pass`: `{ "written": 0 }`, written to `log` in `shared` by a writer whose pass found every page of its view folder already as rendered (an idle pass), at most once a day. A pass with no view folder, or with a page it could not write, records none.
- `view-replaced`: `{ "page", "sum", "blob": "<blob sha256>", "bytes", "reason": "edit" | "race" | "conflict-copy" | "foreign" }`, written to `log`: page bytes that were not the writer's own render, kept as a blob of `{ "page", "text" }`. It lands in the partition of the edit's privacy verdict, with the human records the edit produced.
- `view-correction`: `{ "authority", "page", "key", "text" }` or `{ "authority", "page", "key", "hidden": true }`, written to `events`: the user reworded or deleted the line of a page that shows `key`. One register per page and key, resolved by authority, then clock.
- `view-addition`: `{ "authority", "page", "after": "<key>" | null, "text" }`, written to `events`: a line the user added below the line that shows `after`.

Page paths are relative to the view folder and use `/`. Pages are rendered from `shared` records only; a preference with any record in `private` is left out of every page. A reworded rule line of `about-me.md` is a `preference-set` of the rule's `principle`, a deleted one a `preference-set` that sets `status` to `retired`.

Ledgers the migration from the legacy layout writes (`ledger-row` records, the same shape): `capture-decisions` (one row per inbound capture the capture bot accepted, rejected or found malformed), `search-feedback` (which search results an agent used, per query) and `search-reinforce` (which vault paths were reinforced by use). Their rows go to `private` when the writing machine holds that partition and to `shared` when it does not; a row that names a private page goes to `private` only.

A `search-reinforce` row is either one reinforcement, `{ "ts": <unix ms>, "paths": ["<vault-relative path>", ...] }`, or a reset, `{ "ts": <unix ms>, "reset": true }`. The ledger is append-only, so a reset is a row too: the reinforcement fold counts only the rows after the newest reset row in fold order, and a reset lands in the partition its writer would put a reinforcement in.

Kinds of attestations (a signed statement of the state one machine measured, made with that machine's signing key):

- `attestation`: `{ "record": { ... } }`, written to `events` in `shared`. The whole signed attestation as its writer produced it: its id (`attest-<UTC instant>`, unique), creation time, signing device, the measured manifest, the store digest, the seal and the signature. An attestation names no page, so it always goes to `shared`, where every machine that verifies it can read it. The key that signed it is never a record: it stays in the signing machine's device-local state, and a verifier needs only its public half. When two records carry the same attestation id, the first in fold order is the attestation and the others are ignored.

Kinds of record lanes (the Brain record lanes that have no kind of their own: decisions, obligations, pledges, theses, tensions, gap tasks, attention flows, entities, procedures, procedural memory, skill proposals and benchmarks, captures, write sessions, exact-state pages, standing rules and the rest):

- `lane-entry`: `{ "authority", "lane": "<lane>", "entry": "<entry id>", "fields": { ... }, "text": "<Markdown>", "raw": "<file text>" (optional) }`, written to `events`. The whole current entry: `fields` are the structured fields the entry carried (a page's frontmatter, or the object a JSON file held), `text` its Markdown body. `raw`, when present, is the file's text byte for byte, written only when `fields` and `text` do not reproduce it (a page without frontmatter, a quoted value, CRLF line ends, the formatting of a JSON file). A reader serves `raw` only when it parses back to the record's own `fields` and `text`, and renders `fields` and `text` otherwise; a reader that does not know `raw` ignores it. The rollback export serves `raw` under the same rule: it writes `raw` into the restored file when it parses back, and the rendering of `fields` and `text` otherwise. `raw` counts for the entry's privacy like `fields` and `text`, and spills into a blob with the rest of the body. A lane name is 1 to 64 lowercase letters, digits and hyphens, starting with a letter or digit; an entry id is a non-empty single line of at most 512 characters, unique within its lane. Standing rules are entries of the lane `standing-rule` and carry `authority` `human`. An entry goes to `private` when its page is private by its visibility markers, or when its fields or text name a private page or one that cannot be judged; the text of a large entry spills into a blob like any other body.
- `lane-entry-remove`: `{ "authority", "lane": "<lane>", "entry": "<entry id>" }`, written to `events`. The tombstone of an entry.

Entries fold by lane and entry id: each entry is one register, resolved by authority, then clock.

Kinds of the migration from the legacy layout, written to `settings` in `shared` with `authority` `human` (the user ran the migration):

- `migration-cohort`: `{ "authority": "human", "vault_id": "<id>" | null, "devices": ["<device id>", ...] }`. Every device id found in the legacy tree when the migration started, with no age limit.
- `migration-done`: `{ "authority": "human", "vault_id", "device": "<device id>", "cuts": { "<partition>": { "cut": [<entry>, ...], "cut_hash": "<sha256>" } }, "imported": <items> }`. The device finished importing; `cuts` holds the digest cut (see "State digests") of each partition it holds, taken right after the import.
- `device-switched`: `{ "authority": "human", "vault_id", "device": "<device id>" }`. The device moved to the store; a device that holds its own `device-switched` record writes the store only.
- `device-unswitched`: `{ "authority": "human", "device": "<device id>", "run_id": "<migration run>" }`. A rollback took the device back to the legacy layout. Of a device's own `device-switched` and `device-unswitched` records, the latest in fold order decides whether it is switched.
- `legacy-tree-removed`: `{ "authority": "human", "vault_id", "device": "<device id>", "forced": <bool>, "stopped": ["<device id>", ...] }`. The device moved the vault's legacy tree into its device-local archive; `forced` says the cohort had not all switched, and `stopped` names the devices still on the legacy layout then. A legacy tree seen in the vault after this record is reported by the doctor.

Every record the migration imports carries, beside `vault_id`, the field `legacy_device` (the device id in the name of the legacy shard the item came from, or the empty string for a legacy un-sharded file and for a page) and the field `migrated`: `{ "key": "<vault-relative path>[#<line>]", "sum": "<sha256>", "part": <index>, "parts": <count> }`, the legacy item it came from (with the line for an append-only file), the checksum of that item's content, and which of the item's records this is (an item can become more than one record, such as a preference whose human-decided fields and derived fields carry different authorities). Two legacy items with identical content have different keys and stay two records. A legacy item that a dual write had already put in the store is not imported again: the migration matches this device's unmarked records by kind and body (without `vault_id`, `legacy_device` and `migrated`) as a multiset, one copy per item record.

Every other kind is defined by the feature that writes it, and a reader that does not know a kind keeps the record and leaves its body alone.

## Device-local state

Each machine keeps a device-local directory outside the store, keyed by the store id: append locks, the persisted clock, blob temp files, the search index, caches, hook state and snapshots. It is never synced.

Some state that a legacy install kept inside the vault is device-local once a machine writes the store only, because no other machine needs to agree on it and it is never a record:

- search activation: the access events of this machine's searches and the activation state folded from them, which decay and are swept;
- dream workruns: the per-pass checkpoint files of this machine's dream process, kept as crash evidence;
- the learned search weights: a cache folded from the `search-feedback` rows, recomputed at will.

Sync only the partition folders, each as its own sync folder; never sync the store root or the device-local directory as a whole.

## Versioning

The format version is the integer `v` in every record and the `format` field of `store.json`.

- A change that every reader of the current version can still read keeps the version.
- A change that an older reader would misread raises the version. An older reader then skips the newer records and reports them, and never rewrites them.
- A release may refresh `FORMAT.md` in a partition only with a document of the same or a newer format version; an older release never replaces a newer document.
