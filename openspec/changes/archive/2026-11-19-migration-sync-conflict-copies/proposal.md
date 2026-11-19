# Proposal: sync conflict copies and temp files never stop a migration

## Why

`o2b brain migrate-store --dry-run` on a copy of a real two-machine vault
synced by Syncthing exited 1 with "Unmapped entries: 42": 41 Syncthing
conflict copies (of the freshen state, a lock, signal pages, Brain log
shards and their day pages, audit-trail week shards and the pinned
context) and one Syncthing temp file. The migration deliberately never
claimed a conflict copy, so each one was an unmapped entry, the automatic
migration refused on every real multi-machine install, and the person had
no idea what to do with 42 files. The same dry run took 178 s, and the
automatic worker runs it before every attempt.

## What Changes

- One place (`brain/ledger-shards.ts`) knows the conflict and in-flight
  names of the sync tools the product names: `isSyncConflictName`,
  `syncConflictOriginalName` (the marker removed) and `isSyncTempName`.
- A conflict copy takes the destination of the file it is a copy of. Rows
  of a JSONL copy are imported like the original's, stored once when the
  original holds the same records; a differing version of a record page or
  of a single document is kept in the migration backup and named, never
  merged and never a second record; a copy of a device-local, derived or
  dropped surface goes with its original's rule.
- A sync temp file is ignored and counted everywhere the legacy tree is
  read: the dry run, every pass, the transition import, the removal.
- The dry run and the migration report (text and `--json`) gain a
  `sync_copies` section; the doctor names the kept copies once as advice.
  "Unmapped entries" keeps its meaning and still stops the run.
- The dry run and every import pass judge reference privacy once per
  vault and once per distinct reference on a machine that still judges by
  the legacy pages, instead of re-reading the configuration and
  re-resolving every Brain folder for every row: the dry run of a vault of
  370,000 items drops from about 170 s to about 2 s.
- The import writes items in batches (one clock write, and one write and
  one fsync per shard, per batch of 512) instead of three synced writes
  per item: the import of that vault goes from about 19 items per second
  (about 5.4 hours) to about 5,700, and a start-to-switch takes about two
  minutes.
- While a migration runs, the status block and the doctor say how many
  legacy items it has imported of about how many.

## Capabilities

### Modified Capabilities

- `brain-migration`: the dry-run requirement no longer counts sync
  leftovers as unmapped and gains the report section; new requirements
  say what each sync leftover becomes and that a running migration says
  how far it is.

## Impact

- `src/core/brain/ledger-shards.ts` (names), `src/core/view/page-io.ts`
  and `vault-guard.ts` (read the same function).
- `src/core/store-migration/`: `sync-leftovers.ts` (new), `legacy-claims.ts`,
  `legacy-scan.ts`, `convert.ts`, `dry-run.ts`, `backup.ts`, `migrate.ts`,
  `rollback.ts`, `transition-watermark.ts`, `device-state-layout.ts`.
- `src/core/store/reference-privacy.ts`: `withPrivacyBatch`.
- `src/core/store/appender.ts` (`appendRecords`), `clock-store.ts`
  (`tickClockMany`); `store-migration/import-batch.ts`, the gate's progress file (`migration-gate.ts`),
  `auto-report.ts`; `brain/doctor-exits.ts`.
- `src/core/brain/doctor/migration-check.ts`: `sync-conflict-copies-kept`.
- `src/cli/brain/verbs/migrate-store.ts`: the report section.
- Docs: `docs/brain-store.md`, `docs/cli-reference.md`, `CHANGELOG.md`.
