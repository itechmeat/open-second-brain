# Tasks: automatic store migration after an update

Work in order. For every behaviour: write the failing test first, run it
and see it fail, then the code. Temp data only under
`~/.cache/osb-auto-migrate`. Never run the migration against a real vault
on this machine; fixtures only.

## 1. State, settings and opt-out

- [x] `resolveAutoStoreMigration` in `src/core/config.ts`: the machine
  config key `auto_store_migration` (default on) with the
  `OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION` environment override.
- [x] `src/core/store-migration/auto-state.ts`: the worker lock (claim by
  exclusive create with a token, pid and start time; staleness takeover;
  release by token), the failure and waiting state file with the doubling
  cooldown, and the one-time success notice.
- [x] Tests: the opt-out ladder, the lock claim and takeover, the
  cooldown, the waiting state (no cooldown), the notice.

## 2. The worker

- [x] Store init through the existing core module the init verbs share
  (`ensureBrainStore` in `src/core/brain/init-store.ts`: identity files,
  format document, view writer claim, device binding); no extraction was
  needed. The fresh-install switch record is deliberately not written:
  a machine with legacy data switches through the migration.
- [x] `src/core/store-migration/auto-worker.ts`: the dry-run gate, the
  init step, the `migrateStore` run with `resume: true`, the waiting
  outcome, the failure points, the success records (brain log line,
  metrics row, notice).
- [x] Tests on the migration bench: a clean run, the opt-out, an unmapped
  entry, a store root inside the vault, each failure point of B.5 (before
  backup, after backup, during convert, during verify, after
  migration-done, killed mid-run resumed), the waiting outcome, the
  privacy of the imported records, and a start on a switched machine
  leaving no trace.

## 3. Detection and the worker verb

- [x] The migration step in `ensureVaultCurrent`: probe, lock, detached
  spawn in the background; the worker logic in the process in the
  foreground mode.
- [x] The managed-file upgrade and the migration never race: the
  migration worker runs the upgrade first; a start that started (or
  found running) the migration worker starts no upgrade worker; the
  upgrade worker's lock and the search index rebuild's staging journal
  are mapped surfaces, so neither stops the dry run.
- [x] `o2b brain migrate-store --auto <token>`: the worker entry point.
- [x] A manual `o2b brain migrate-store` run refuses while the automatic
  worker holds the lock; the dry run stays available.
- [x] Tests: the spawn decisions per state, a start not delayed by a
  running worker, the fresh install that starts nothing, the switch
  machine that leaves no trace, the manual-run refusal.

## 4. Foreground paths

- [x] `o2b update`: the check after updating, the foreground run with
  progress on stderr, the outcome in the text and `--json` output,
  `--skip-store-migration`.
- [x] `o2b brain upgrade --dry-run` and its plan output name a pending
  migration and what the next start will do.
- [x] Tests: the update on a fixture vault (applied, failed, skipped,
  opt-out), the dry-run output.

## 5. Reporting

- [x] `autoMigrationReport()`: not-needed, pending, running, waiting,
  failed, done.
- [x] The `migration` block of the store status carries it; the doctor's
  migration finding words its message from it and warns on a failure.
- [x] The runtime notices carry at most one short line about a failed or
  waiting migration; the one-time success notice is shown at a session
  start and then cleared.
- [x] Tests: the report states, the status block, the doctor finding, the
  notice lines and the one-time clearing.

## 6. Documents

- [x] Design D11 of `brain-store-and-topics` points at this change.
- [x] `docs/brain-store.md`: how the automatic migration works, how to
  turn it off, how to roll back.
- [x] `docs/cli-reference.md`: `o2b update`, `migrate-store --auto`,
  the config key.
- [x] `docs/updating.md`: what an update now does.
- [x] The skill that mentions the store switch (`skills/open-second-brain`),
  then `bun run sync-plugin-mirrors`.
- [x] The Unreleased section of `CHANGELOG.md`.
- [x] The change archived inside this branch, the change folder moved to
  the archive. `brain-migration` is not in `openspec/specs/` yet (it
  lives in the unarchived `brain-store-and-topics` change), so the delta
  was applied to that change's `specs/brain-migration/spec.md` and the
  archive skipped the spec update; the requirement reaches
  `openspec/specs/` when `brain-store-and-topics` is archived.
