# Design

## Context

The migration catalogue (`store-migration/catalogue.ts`) maps every
legacy surface to a destination through locators; `legacy-claims.ts`
reports every legacy file no locator claims as unmapped, and
`legacy-scan.ts` reads the items of the claimed files. A Syncthing
conflict copy was excluded from every claim on purpose (to be merged by
hand), so a synced vault always had unmapped entries. Every legacy item is
imported under a key (`<vault-relative path>#<line>` for a JSONL row, the
path for a whole-file item) and a content checksum, journaled per item; a
later machine, the transition import and the rollback match items by that
key and checksum.

## Decisions

### D1. One place knows the names

`isSyncConflictName`, `syncConflictOriginalName` and `isSyncTempName` in
`brain/ledger-shards.ts` are the only code that knows the names. The
tools are those the product already names: Syncthing (`.sync-conflict-...`
segment; `.syncthing.<name>.tmp` and `~syncthing~<name>.tmp`), Dropbox and
Nextcloud (`<stem> (... conflicted copy <date> ...).<ext>`; the Nextcloud
`.<name>.~<hex>` in-flight file). iCloud and OneDrive appear in the
product only as folder locations and file lockers, not as conflict names,
so no pattern is invented for them. A name that merely contains the word
(`conflict-notes.md`, `notes (conflict).md`) does not match.

### D2. A copy takes its original's surface

`sync-leftovers.ts` lists the leftovers beside the files the catalogue
reads: a conflict copy whose original a locator claims (directly, or as the
`.lock` sibling of a claimed file) gets the rule of that surface:

- `rows` (a JSONL ledger or log shard): each row is built into records as
  the original's row would be (the original's path and shard device). A
  row whose record contents (`contentKey` of every record) the original or
  an earlier copy of the same original holds adds nothing: it is neither
  journaled nor imported. Any other row is an item under the COPY's key,
  `<copy path>#<line>`, with the row's checksum.
- `file` (one item per file: signal pages, preference pages, lane
  entries): a copy whose item checksum equals the original's adds nothing.
  A copy that differs is a second version of one record (two versions of
  one signal id), an edit conflict a person resolves, not two records: it
  is kept. A copy whose original is gone is the only version and is
  imported as that item under the copy's key.
- `document` (a single document: the pinned context, the settings file,
  a backup-class file): the original goes as before; a copy equal byte for
  byte adds nothing, a differing one is kept.
- `dropped` (device-local, derived or dropped: the freshen state, a lock,
  caches, log day pages): the copy is not carried over, and is never moved
  into device-local state where it would stand beside the real file.

A copy whose original no locator claims stays an unmapped entry, as an
unknown file does. A leftover inside a folder a mapping takes whole moves
with that folder.

### D3. Exactly once by the copy's own key

A conflict copy's name never changes, so its key is stable: the journal
skips a row it holds complete, a resumed run finds it, a later machine
importing its own copy of the same file matches it by key and checksum
across devices, and the transition import sees the same key. The rollback
(`restoredIdentity`) adds the copy keys of the restored tree, so a record
imported from a copy is held by the restored copy and is not written back
into the original; the copy itself comes back from the snapshot byte for
byte. A row shared with the original is matched by record content, not by
key (the original is always read before its copies), so it is stored once.

The key includes the line, so this holds while the copy file is
unchanged. A row a person later moves into the original after the switch,
or a copy rewritten with its rows at other lines, is a new row and is
imported as one; the store can then hold that event twice. Nothing is
lost, and a content match across the whole family was judged not worth a
persisted index of copy-row contents (review of this change, R2).

The per-reference privacy verdicts of D7 are forgotten after every import
batch (`endPrivacyBatchChunk`), and in the dry run after as many rows, so
a page made private while a pass runs is seen within one batch (review,
R1); the preference pages are then found through the folders the batch
resolved once, which keeps the cost within a few percent.

### D4. Kept copies

Every kept copy is copied, verified by checksum, into
`<migration dir>/backup/sync-conflict-copies/<vault-relative path>` and
listed in `backup/sync-conflict-copies.json` with its original, surface
and reason. Once the device switched, the doctor reads that list and
reports `sync-conflict-copies-kept` once, as advice (the uncertain
channel), with the folder; removing the list ends the advice. Nothing
waits on it.

### D5. Temp files, the transition and the removal

A temp file is never claimed, never reported unmapped and never read; the
report counts and names it. When it becomes the real file, the existing
re-scan until a pass imports nothing reads that file. The transition
watermark stamps record-shaped conflict copies too, so a copy that
arrives after the switch is new content for the transition import. The
removal's convergence check is a pass that imports nothing, so neither a
copy already imported nor a temp file keeps it from converging; both move
to the archive with the tree.

### D6. Reports

`sync_copies` on the dry run and the migration result: `surfaces` (per
surface `copies`, `imported`, `identical`, `kept`, `dropped`), `kept`
(each with `path`, `original`, `surface`, `reason`), `temps_ignored`
and `temps`; the migration result adds `sync_copies_archive`. The text
report prints the same as a "Sync conflict copies" section. "Unmapped
entries" is unchanged.

### D7. Performance

On a synthetic fixture of the real vault's shape (360,360 log rows in 396
shards, 400 day pages, 10,090 signal pages, generated under the temp
directory) the dry run took 169 s; 99 percent of it was building the
record of each Brain log row, and in that the privacy judge: every row
made a fresh row judge, which re-read the machine configuration to learn
whether this machine is store-only and re-resolved (realpath) every Brain
folder. `withPrivacyBatch` (`store/reference-privacy.ts`) runs the dry
run and each import pass as one operation: the store-only verdict and the
folder scope are worked out once per vault, and on a machine that judges
by the legacy pages (which a migration only reads) every distinct
reference is judged once. On a store-only machine (the transition import)
the per-reference memory stays off, because the folds it judges from may
change during the pass. The dry run then takes about 2 s with the same
partition counts. The import passes run as one batch too.

### D8. The import writes in batches

The import was bound by synced writes: every record ticked the hybrid
logical clock with an atomic write (temp file, fsync, rename, folder
fsync) and appended its line with an fsync, so an item cost about three
synced writes, 52 ms on this machine's disk under load: 18 to 19 items
per second, flat as the journal grew (2,151 items in 119 s on a small
fixture, 19.5 items per second at 12,500 journal rows on the large one),
about 5.4 hours for 370,000 items. The pass now plans items as it reads
them and writes them in batches of 512 (`import-batch.ts`): one clock
tick for the batch (`tickClockMany`: consecutive stamps under one lock,
the last persisted), then each shard's lines in one write and one fsync
under its lock (`appendRecords`), then the journal rows in one append.
Exactly once holds as before: a record is in the store before its
journal row and carries its `migrated` mark, so a run killed after a
batch's records and before its rows is resumed from the store
(`journalFromStore`); the crash tests kill inside a batch of four. A
crash mid-write leaves each shard a prefix of its lines and at most one
torn last line, which readers report, as a crash between single appends
does. On the 370,000-item fixture a start-to-switch now takes about two
minutes: the dry run about 5 s, then the migration about 120 s (its own
dry run and the snapshot and backups about 30 s, the first pass about 65 s
at about 5,700 items per second, steady to the end, the delta pass, the
verification and the switch about 28 s).

### D9. Progress while it runs

The run keeps one progress file, the one the migration gate's refusal
reads (`migration-gate.ts`, beside the gate in the device-local state,
removed when the gate is released): its step in a few words and, once its
import began, the items journaled and the record items its dry run
planned, rewritten after every batch. One reader
(`readMigrationGateProgress`) serves the status block and the doctor,
which say "N of about M legacy items imported so far" in the running
state, and a refused writer, which names the step and the counts. Nothing
counts the journal to answer.
