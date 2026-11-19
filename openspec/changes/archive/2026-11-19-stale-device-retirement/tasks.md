# Tasks: a silent device stops holding the legacy tree

Work in order. For every behaviour: write the failing test first, run it
and see it fail, then the code. Temp data only under
`~/.cache/osb-device-retire`. Fixtures only, never a real vault; a test that
runs the CLI does so as a subprocess with every host home inside the
fixture.

## 1. The rule

- [x] 1.1 `src/core/store-migration/device-silence.ts`: the pure rule
  (D1-D3): per device its last evidence, the reference, the verdict.
  Table test: evidence kinds (shard date, row time, store record, cohort
  record only, none) x ages (inside, at, past the threshold) x threshold 0
  x clock cases (a peer's evidence in the future, this machine's clock
  behind the evidence, this machine's clock ahead of every evidence).
- [x] 1.2 The setting `migration.silent_device_days` (D4): the fold rule
  (integer 0 to 3650, default 30) and the store-native, operator-only
  setting. Tests: the fold validation, the CLI set and get.

## 2. Evidence and cohort status

- [x] 2.1 `src/core/store-migration/device-evidence.ts`: legacy shard
  dates and row times (tail read), store record clocks, cohort record
  clocks. Tests on a fixture vault and store.
- [x] 2.2 `src/core/store-migration/cohort-status.ts`: per cohort device
  switched, pending or retired by silence, the reference and the
  threshold, `can_leave`.

## 3. Effects

- [x] 3.1 The removal (D6): retired by silence is not pending; the result,
  the record and the marker carry the lists. Tests: a retired and a pending
  device, the record body, `--force` naming only pending devices.
- [x] 3.2 The CLI report, text and `--json`. Tests: both shapes.
- [x] 3.3 The doctor (D7): the per-device list, `legacy-tree-can-leave`
  advice. The store status `cohort` block. Tests: wording, channel.
- [x] 3.4 The returning device (D8): the reappeared-tree message; no
  switch guessed from a removal record on a vault with no tree; a device
  pending again after it writes; a later machine importing its offline
  legacy records from its local copy.

## 4. Documents

- [x] 4.1 `docs/brain-store.md` (the removal section, the cost of the
  threshold, "When a person has to step in"), `docs/cli-reference.md`,
  `src/core/store/FORMAT.md`, the `CHANGELOG.md` Unreleased entry.
- [x] 4.2 Design D11a of `brain-store-and-topics` points at this change;
  its `specs/brain-migration/spec.md` carries the delta word for word.
- [x] 4.3 Archive the change inside the branch. `brain-migration` is not in
  `openspec/specs/` yet (it lives in the unarchived `brain-store-and-topics`
  change), so the delta was applied word for word to that change's
  `specs/brain-migration/spec.md` and the archive skipped the spec update.

## 5. The gate

- [x] 5.1 `bun run fmt`, `fmt:check`, `typecheck`, `lint`,
  `scripts/sync-version.ts --check`, `sync-plugin-mirrors:check`, the full
  suite once.
