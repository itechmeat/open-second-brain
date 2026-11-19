# Design

## Context

The removal of the legacy tree (`src/core/store-migration/removal.ts`,
design D11a of `brain-store-and-topics`) waits for the migration cohort:
every device id the first machine found in the legacy tree
(`migration-cohort`), plus every device id seen in legacy shard names since,
minus the devices that recorded their own `device-switched` and the devices
a human retired with `device-retire` (`legacyDevices` in
`migration-records.ts`). The "no age limit" rule is deliberate: a device
that returns after the removal writes into a tree no store imports. In
practice a vault carries ids of machines that are gone, so the cohort never
completes. The owner decided on 2026-11-19 that a device that has not
written for longer than a set time counts as retired, and that the doctor
shows it.

Facts that shape the design:

- Legacy per-device ledgers are named `<base>.<device>.jsonl`
  (`brain/ledger-shards.ts`). For the Brain log the base is the day
  (`2026-11-01.dev-b.jsonl`), for several ledgers a month (`2026-11`), a
  week (`2026-W45`) or a fixed stem; rows carry their own time fields
  (`ts`, `timestamp`, `run_at`, ...). Legacy pages (signals, preferences)
  do not record the device that wrote them.
- File modification times are not evidence: the sync tool rewrites them.
- Store records carry a hybrid logical clock (`store/hlc.ts`) whose
  physical part is the writing device's wall clock; a receiving device does
  not adopt a stamp more than one day ahead of its own wall clock.
- Shared settings live as `setting-set` records in the `settings` stream of
  `shared`. Settings with no `_brain.yaml` home are store-native
  (`STORE_NATIVE_SETTINGS` in `brain/policy/settings-names.ts`) and are set
  with `o2b brain settings set <key> <value>`; known keys are validated in
  the fold (`SETTING_RULES` in `store/fold-settings.ts`).

## Goals / Non-Goals

**Goals:** a stale device id stops holding the tree after a threshold every
machine agrees on; the doctor, the status block and the removal report say
which device is switched, pending or retired by silence and why; a device
that comes back loses nothing it synced, and the docs state exactly what it
can lose.

**Non-Goals:** an automatic removal (the removal stays the owner's
command); a change to the human `device-retire` record or the digest
roster; a recorded retirement.

## Decisions

### D1. Evidence of life

The last evidence of life of a device is the newest of:

1. the date in the name of each of its legacy shards, for every per-device
   JSONL ledger the migration catalogue maps (a day `YYYY-MM-DD` counts as
   that day at 00:00 UTC, a month `YYYY-MM` as its first day; a week or a
   fixed stem carries no date);
2. the time fields of the rows in those shards (`ts`, `timestamp`, `at`,
   `created_at`, `recorded_at`, `run_at`, `written_at`, ISO 8601 strings),
   read from the last 64 KiB of each shard, where an append-only ledger
   keeps its newest rows, widened until it holds the whole newest row, so
   a row longer than that never leaves its device dated by the shard name
   alone;
3. the physical clock of every store record whose envelope names the device,
   in every partition this machine holds (a machine on an old release that
   dual-writes, or a device that writes again after a retirement).

A device "switched" is told only by its own human `device-switched` record
not undone by a later `device-unswitched` (`switchedDevices`, unchanged): a
switched device is never pending and never judged. Any other store record
of the device is evidence of life, not a switch: a release that dual-writes
writes store records while it keeps the legacy layout.

Legacy pages carry no device id, so they are no evidence of any device.
File modification times are never read.

### D2. A device with no evidence

An id with no dated trace anywhere (it appears only in the cohort record,
for example because its only shard had no date and no time field, or the
shard was deleted by hand) takes the clock of the earliest
`migration-cohort` record that names it as its evidence: that record proves
only that the id existed in the tree when the migration began. It is then
retired by silence one threshold after the migration began, which gives a
device that was alive at preflight the same grace as any other device. An
id with neither a trace nor a cohort record is never retired by silence (no
date to measure from); it stays pending, and `o2b store device retire` or
`--force` remain the remedies. Blocking such an id forever is what the
change removes for every id that carries a date, and an id with no date at
all cannot be shown silent.

### D3. Which clock is compared with what

The rule compares each device's last evidence with a reference time:

- reference = the newest evidence of any device the store or the tree
  records (this machine's own store records included) that is not later
  than this machine's wall clock; evidence later than the wall clock is left
  out of the reference, not clamped to it;
- evidence later than the reference counts as the reference (a device that
  stamps the future is alive now);
- a device is retired by silence when reference − last evidence is greater
  than the threshold (strictly), and the threshold is not 0.

Why this and not the wall clock alone: the wall clock decides only which
evidence may set the reference, so a clock that is wrong in either
direction is bounded by the dates actually written.

- A clock far in the future on another machine: its records and rows are
  later than this machine's wall clock, so they are left out of the
  reference, which stays the newest evidence this machine has seen that is
  not in the future. It retires no device and keeps itself alive. Clamping
  them to the wall clock instead would turn relative judging into absolute
  on a machine whose own view is stale (its vault sync paused), and retire
  devices the relative rule keeps pending.
- A clock far behind on this machine: evidence later than it is left out of
  the reference, so fewer devices are retired; nothing is lost.
- A clock far in the future on this machine: nothing changes until this
  machine writes a record under it, because the reference is the newest
  evidence present, not the wall clock. Once it has, every device that has
  not switched looks silent: from this machine's records alone that case
  has the same shape as a machine that really outlived the others, and no
  rule over the records can tell them apart. It is bounded three ways: the
  removal is still the owner's command and nothing moves on its own; every
  retired device is printed with the reference date (`as of`), so a date in
  the future is visible before the owner acts; the doctor of every other
  machine already reports this machine's records as `store-clock-ahead`.
  And a device wrongly retired that is in fact alive keeps writing: its new
  evidence is later than its old, so it is pending again on the next read
  (D5), and if the tree did leave, D8 applies.

The rejected alternatives: the wall clock alone (one wrong clock retires
every device); the newest evidence of other devices only (a single live
machine with stale ids could then never retire the newest of them, which is
exactly the case the owner wants solved); a second-witness rule (the same:
it cannot work on a store with one live machine).

### D4. The threshold is a shared setting

`migration.silent_device_days`, a store-native setting (no `_brain.yaml`
home, the legacy layout has no removal), validated in the settings fold as
an integer from 0 to 3650, default 30. `0` turns the rule off: no device is
retired by silence and the cohort has no age limit, as before. It is
operator-only: an agent lowering it could make a removal pass that the
owner did not mean. Set with `o2b brain settings set
migration.silent_device_days 60`.

### D5. Derived, never recorded

Nothing records a retirement by silence. Each surface (the removal, the
doctor, the status block) derives it from the evidence it reads at that
moment. A device that writes again (a legacy shard or a store record) has
new evidence and is pending again at once, on every machine that has
received the write, when that evidence is dated within the threshold of the
reference (a date later than the reference counts as the reference); a
write stamped older than that leaves it retired by silence.

### D6. The removal

`removeLegacyTree` takes the devices the transition import still counts as
on the legacy layout and splits them: retired by silence, or pending. Only
pending devices refuse the removal without `--force`. The result, in text
and `--json`, carries `switched` (cohort devices that switched),
`retired_by_silence` (each with `last_evidence`), `silence_threshold_days`
and `as_of` (the reference), and on a refusal the same lists beside
`pending`. The `legacy-tree-removed` record in `shared` and the device-local
marker gain `retired_by_silence` and `silence_threshold_days`, so the
doctor of every machine can say why the tree left. `stopped` keeps its
meaning: the devices still pending that a forced removal leaves behind.

### D7. The doctor and the status block

The doctor's transition finding on a switched machine lists every cohort
device (the cohort, the devices seen in legacy log shard names, the
switched ones) with its state: `switched`, `pending (last evidence <date>)`
or `retired by silence (last evidence <date>, more than <n> days before
<as of>)`. While a device is pending it is the existing
`legacy-devices-pending` advice. Once none is pending and the tree is still
in the vault, a new advice `legacy-tree-can-leave` says the tree can leave
the vault and names `o2b brain migrate-store --remove-legacy`. Both stay in
the non-counting channel. The `migration` block of the store status gains
`cohort`: `null` when this machine has not switched or the vault holds no
tree, else `{ threshold_days, as_of, devices: [{ device, state,
last_evidence }], can_leave }`.

### D8. The returning device

A device retired by silence that comes back:

a. **On an old release** it writes into `Brain/` again. Before the removal
   it is pending again (D5). After the removal its directory is back in the
   vault and the doctor's `legacy-tree-reappeared` warning fires; when the
   reappeared shards name a device that a `legacy-tree-removed` record lists
   as retired by silence, the warning says so and what to do: update Open
   Second Brain on that machine, its migration then imports its new legacy
   records as a later machine; then remove the tree again with
   `o2b brain migrate-store --remove-legacy`. Meanwhile the switched
   machines' transition import keeps importing what it writes, so nothing
   it writes there is lost.
b. **On the new release** its automatic migration runs as a later machine.
   While its local copy of the tree still exists (the sync tool has not
   removed it), the later-machine pipeline imports every legacy item the
   store lacks, which includes what it wrote offline. When its local tree is
   gone (the sync tool applied the removal), the machine is store-only by
   the no-legacy-tree rule. Its start records no `device-switched` from a
   `legacy-tree-removed` record: the identity marker left with the tree,
   so a vault without its tree cannot be matched to the record, and one
   store serves every vault of a machine; a switch recorded while the
   machine serves another vault whose tree has not arrived yet would leave
   that vault's legacy records unimported (a switched machine's other
   vault is the manual command's). `o2b init --vault` on that machine
   records its switch, on the owner's word. What is lost in that case:
   records that device wrote into its legacy tree after its last sync and
   that never synced before its tree was removed. That is the cost of the
   threshold, stated in the docs.
c. **Retired while the tree is still in the vault, then writes again**:
   pending again at once when the write is dated within the threshold of
   the reference (D5); the doctor shows it pending and the removal
   refuses without `--force`.

## Risks / Trade-offs

- A far-future clock on the only live machine can retire every device that
  has not switched (D3); bounded by the owner's command, the printed `as of`
  date and the peers' `store-clock-ahead`.
- The evidence read costs one listing and a 64 KiB tail read per legacy
  per-device shard (more only for a newest row longer than that), and one read of the held partitions, on every doctor
  run on a switched machine whose vault still holds the tree. Both are
  reads the doctor already pays in other checks of the same state.
- A device whose only rows carry no time field and whose shard names carry
  no date (a fixed stem) is judged by its store records or its cohort
  record (D2).
