# Tasks: sync conflict copies and temp files never stop a migration

Work in order. For every behaviour: write the failing test first, run it
and see it fail, then the code. Temp data only under
`~/.cache/osb-conflict-copies`. Fixtures only, never a real vault.

## 1. Names

- [x] 1.1 `isSyncConflictName`, `syncConflictOriginalName`, `isSyncTempName`
  in `brain/ledger-shards.ts` (D1); the view reads the same function.
  Table test of real-world names, including names that merely contain the
  word conflict.

## 2. What each leftover becomes

- [x] 2.1 `store-migration/sync-leftovers.ts`: the finder and the rules (D2);
  `legacy-claims.ts` claims a copy through its original and skips temp
  files.
- [x] 2.2 The pass (`convert.ts`) and the dry run: rows deduplicated by record
  content, copy keys (D3), whole-file verdicts; the backup of kept copies
  (D4); the rollback identity; the transition watermark (D5).
- [x] 2.3 The report section, text and `--json` (D6); the doctor advice.

## 3. Tests

- [x] 3.1 A fixture vault with every kind from the real dry run's list
  (`tests/core/store-migration/fixtures/sync-leftovers.ts`): the dry run
  exits 0 with the section, the migration switches.
- [x] 3.2 Exactly once: a resume after a kill, a later machine, the transition
  import, the rollback restoring every copy byte for byte.
- [x] 3.3 A differing single-document copy kept and named, the doctor advice;
  a temp file that becomes real between passes; a copy that appears after
  the switch; the removal with copies present; an unknown file and a copy
  of it still stop the run.

## 4. Performance

- [x] 4.1 Measure the dry run and the start-to-switch on a synthetic fixture
  of the real shape; `withPrivacyBatch` (D7), with a test that a batch
  judges every row as it is judged alone.
- [x] 4.2 Measure the import (items per second per phase, before and after);
  the batched import (D8): `appendRecords` and `tickClockMany` with tests,
  the crash child killing inside a small batch.
- [x] 4.3 Progress in the running state (D9), with a test of the report and
  the doctor during a run.

## 5. Documents

- [x] 5.1 `docs/brain-store.md` (the dry run, the migration steps, "When a
  person has to step in"), `docs/cli-reference.md`, the `CHANGELOG.md`
  Unreleased entry.
- [x] 5.2 `brain-store-and-topics` `specs/brain-migration/spec.md` carries
  the delta word for word; archive the change inside the branch with the
  spec update skipped (`brain-migration` is not in `openspec/specs/` yet).

## 6. The gate

- [x] 6.1 `bun run fmt`, `fmt:check`, `typecheck`, `lint`,
  `scripts/sync-version.ts --check`, `sync-plugin-mirrors:check`, the full
  suite once.
