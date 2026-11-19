# Proposal: a device that has been silent for a long time stops holding the legacy tree

## Why

After the store migration the legacy `Brain/` tree stays in the vault until
every device of the migration cohort (every device id found in the legacy
tree, with no age limit) has switched or been retired by hand, or the owner
forces the removal. A real vault carries device ids of machines that no
longer exist (a reinstalled laptop, an old phone id, a test device), so the
cohort never completes and the tree stays forever unless the owner knows to
run `o2b store device retire` for each id or `--force`. The owner decided on
2026-11-19 that a device that has not written for longer than a set time
counts as retired, and that the doctor shows it.

## What Changes

- A pure rule derives, per cohort device that has not switched, its last
  evidence of life (the newest dated trace it left in the legacy tree or
  the store) and whether it is retired by silence: its last evidence is
  older than the threshold, measured against a reference time that never
  runs ahead of the evidence actually present. The answer is derived on
  every read, never recorded: a device that writes again is pending again
  at once when what it writes is dated within the threshold of the
  reference; a write stamped older than that leaves it retired by silence.
- A store-native shared setting `migration.silent_device_days` (default
  30, `0` turns the rule off and the cohort has no age limit, as before),
  set by the operator with `o2b brain settings set`; every machine of the
  store reads the same value.
- `o2b brain migrate-store --remove-legacy` without `--force` treats a
  device retired by silence as not pending; its text and `--json` report
  name each retired device with its last evidence date, apart from the
  devices that switched. The `legacy-tree-removed` record names the devices
  retired by silence and the threshold, so every machine can tell why the
  tree left.
- The doctor and the `migration` block of the store status list each
  cohort device as switched, pending (with its last evidence) or retired
  by silence (with the date and the threshold), and say that the legacy
  tree can leave the vault, with the command, once nothing is pending. It
  is advice, never a warning. Nothing is removed automatically.
- A device retired by silence that comes back is handled without silent
  loss: on an old release the doctor's warning about a legacy directory
  that is back names it as retired by silence and says to update it; on
  the new release its automatic migration imports its own legacy records
  from its local copy of the tree as a later machine, and a machine whose
  tree is gone after a removal writes the store only, its switch recorded
  by `o2b init --vault` rather than guessed from a removal record.

## Capabilities

### Modified Capabilities

- `brain-migration`: the removal requirement gains the silence rule; the
  regeneration requirement gains the returning device.

## Impact

- `src/core/store-migration/`: a new pure rule (`device-silence.ts`), the
  evidence reader (`device-evidence.ts`), the cohort status
  (`cohort-status.ts`), the removal and its record, the automatic worker's
  answer on a vault whose tree was removed.
- `src/core/store/`: the setting key, its validation and its default; the
  status block.
- `src/core/brain/policy/settings-names.ts`: the store-native setting.
- `src/core/brain/doctor/migration-check.ts`: the per-device list, the
  advice, the returning device.
- `src/cli/brain/verbs/migrate-store-forms.ts`: the removal report.
- Docs: `docs/brain-store.md`, `docs/cli-reference.md`,
  `src/core/store/FORMAT.md`, `CHANGELOG.md`, design D11a of
  `brain-store-and-topics`.
