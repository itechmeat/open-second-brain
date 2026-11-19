# Design

## Context

The migrator (`src/core/store-migration/`) ships with the product and is
reached only by hand: `o2b brain migrate-store`. The doctor and the store
status block answer `migrationAvailability()` (the vault holds legacy data
and this device holds no `device-switched` record of its own), but nothing
acts on the answer. `ensureVaultCurrent` already runs hands-off maintenance
at every full-scope MCP server start and at the SessionStart hook: its
managed-file upgrade step claims a per-vault worker lock and starts a
detached `o2b brain upgrade --self-heal <token>` process, with a failure
marker, a cooldown and a metrics row. The automatic migration copies that
pattern instead of inventing a new one.

Facts that shape the design:

- The migration writes only under the vault, the store and this machine's
  device-local state. It never touches a provider.
- The switch is the last step of `runMigration`, after the verified
  backups, the converged journal and a clean verification; the migration
  gate is lifted in a `finally`. A thrown failure before the
  `device-switched` record therefore leaves the machine on the legacy
  layout with the gate open. A throw after that record (the switch marker,
  the vault binding, the view writer claim, the final save) leaves the
  machine switched with its run still `in-progress`, and a kill anywhere
  after the gate closed leaves the gate held by a dead process.
  `finishInterruptedSwitch` (reached through `migrateStore` on a switched
  device) finishes such a switch; the automatic path must call it (D3).
  No failure point needs an automatic rollback.
- The hook and the server start have a wall-time ceiling. The detection
  step must be a cheap read when nothing is to do.

## Decisions

### D1. Detection rides `ensureVaultCurrent`

A new step in the same not-store-only branch as the managed-file
upgrade, decided before it. It asks `migrationAvailability()` (the same read
the doctor and the status block already pay: one directory probe of the
legacy tree, the store identity files, this device's own `settings`
shards) and the opt-out setting, and on "available and enabled" claims
the worker lock and spawns the detached worker. A recorded failure's
cooldown holds the spawn off, except when the attempt that recorded it
was killed while it held the migration gate (content writes are refused
until it resumes); that resume runs with the opt-out on too, because it
finishes an attempt that already started. Only a migration run's gate
counts (its run id says so): its own run still `in-progress` is resumed,
and a gate whose run never put itself on record (killed between taking the
gate and saving its state) is opened with the opt-out on, or taken over by
a migration with it off. A gate an interrupted rollback or legacy tree
removal left is that command's to finish: the worker refuses and names it.
So is a rollback that began and did not finish whose gate is gone (it
failed after it cleared the switch and before it recorded the run rolled
back): its record (`rollback.json`) is still there, and the worker refuses
and names `o2b brain migrate-store --rollback`; a record that cannot be
read is answered the same way. A gate a finished rollback could not
release (its run state reads rolled back) is opened by the next start
whatever the setting, and nothing is migrated.
A gate the worker could not open keeps the attempt's record, so the next
start comes back to it whatever the opt-out and the cooldown say. A machine the operator rolled
back is never spawned for, whatever the setting. On a switched machine the
step only asks whether something is left to finish (its own run still
`in-progress` after the switch record, or a record of an automatic attempt
that did not write its success records) and spawns the same worker for
that whatever the opt-out says (finishing a switch is not a new migration
and asks no consent; the opt-out governs only starting one); otherwise it
costs the store's identity files, one small JSON file and one `stat`, and
writes nothing. A live migration holding the gate, or a gate file that
cannot be read, starts no worker on either layout: a worker could only
answer that it is not its turn, and an unreadable gate would otherwise
start one at every start.

The start never starts a subprocess to judge a holder. It judges a held
worker lock or migration gate by the process id (one signal probe) and the
age: a live pid's lock claim is never taken over by a start; past an hour
when no start identity was recorded, or a day when one was, the start
leaves the claim as it is and spawns a worker that claims it itself with
the exact judgement, which can afford the identity query (a `/proc` read on
Linux, PowerShell on Windows, `ps` on macOS) and takes the claim over only
from a holder that is gone; a worker whose claim was taken over writes
nothing more (D2). A start takes the claim's mutex without waiting: a
busy mutex is a claim being made or judged, and the start starts nothing.
A live pid holds the gate for a day. The start's own
claim records no identity; the worker stamps its own. A live migration of
another vault starts no migration of this one but holds none of this
vault's work back: its managed-file upgrade still runs. In
the foreground mode of `ensureVaultCurrent` (`background: false`, used by
tests and explicit callers) the same worker logic runs in the process.
`o2b update` does not go through `ensureVaultCurrent`: it calls the same
worker logic itself (`updateStoreMigration`, D4). The start's decision is
one function (`planAutoMigrationStart`), so a test follows exactly what a
start would do.

What a start, the worker, `o2b update` and the manual verb decide when they
meet the migration gate is ONE pure function of an explicit state
(`decideGate`, `gate-decision.ts`): the gate (absent, unreadable, torn, this
vault's migration run, this vault's rollback or removal, another vault's),
its holder as the asker's judgement sees it (a start sees only the pid, so
every live pid is unknown to it; the exact judgement sees a reused pid as
gone) and whether the gate is older than a day, this vault's run state
(an unreadable one included), this machine's rollback record (none,
there, unreadable; read once with the run state), whether the machine switched and anything
is left to migrate, the attempt record (an attempt, one that owes a gate,
a failure cooling down or due, a remembered wait), the setting and the
asker. The callers gather that state (`gate-state.ts`; a start reads the
gate, the record and the setting first and walks the legacy tree only when
they do not decide) and act on the answer; the worker decides once before
it claims, to exit cheaply, and again under its claim, acting only on the
second answer. Its rules: a holder that may still run keeps its gate; a
gate that is not this vault's migration run is never opened or taken over
by the automatic path; a gone holder's gate of this vault's migration run
is recovered by the next step allowed to write whatever the setting, the
cooldown and the payload (resumed when the attempt may go on: the setting
on, or off with the attempt's own run that did not report how it ended;
opened otherwise, which leaves the machine on the legacy layout, writable,
its run resumable); with the setting off no new migration starts; a run
state that cannot be read is never migrated over (it could be a rolled-back
run), and neither is a rollback that began and did not finish, nor a
rollback record that cannot be read; a finished rollback's gate whose
holder is gone is opened; a holder that cannot be told past a day reaches a worker whenever the
automatic path would act on the gate were its holder gone, and the worker
never acts on an answer it cannot be sure of; a switched machine with
nothing left decides nothing from its cheap reads; a start and the worker
it spawns decide the same on the same state, except where the worker's
exact judgement knows more. `o2b update` and the foreground mode are
explicit runs: like the manual verb they wait out neither a cooldown nor a
remembered wait. A table test enumerates the whole state space against
these invariants.

A start whose migration worker was just started, or is running, starts no
managed-file upgrade worker: the migration worker runs the upgrade itself
(D3), and a second worker would race it into the migration gate, which
refuses the upgrade's writes. Every other start (opted out, a failure
cooling down, nothing to migrate) starts the upgrade worker as before.

### D2. One worker per vault per machine

The lock, the failure marker and the waiting state live in the
device-local folder of all stores, which exists before any store does, is
never inside a vault and never syncs:
`<state dir>/open-second-brain/stores/auto-migration/<vault key>/`, the
vault key a digest of the vault's resolved path. They do not follow the
machine-state root, which is the vault itself on the legacy layout and
moves at the switch: a file written before the switch would otherwise be
released and cleared at the wrong place, and synced to other machines.
One file each: `auto-store-migration.lock` (a JSON record with the claim
token, the holder's pid and start identity, and the claim time, so the
doctor can say since when and which process), `auto-store-migration.json`
(the last failure, the record of an attempt in flight, or the waiting
state), and `store-migration-notice.json` (the one-time success notice).

The lock is claimed with an exclusive create and a fresh token under a
short device-local mutex, so a takeover can never leave two holders. The
folder is keyed by the vault's canonical path (links resolved, case folded
on Windows), so every spelling of one vault shares one lock. The
parent hands the claim to the worker's pid right after the spawn; the
worker stamps its own start identity on it and releases it when it ends.
A claim is stale as soon as its holder is provably gone (the pid is not
alive, or now names another process: the migration gate's rule in
`quiesce.ts`), and a provably live holder keeps it however long the run
takes. Only when the holder cannot be told apart (no identity recorded or
readable) does the one-hour age rule of the other workers apply, and then
an mtime in the future counts as stale. That is the exact judgement of the
worker, the manual verb and the doctor; a start and the session notices
use the cheap judgement of D1, with no identity query. A fresh claim of a
live process is never taken over by either: with no identity readable,
its age is under the hour. A claim file that holds no record (empty, or a
claim being written) holds for ten seconds; one that cannot be read at
all (a permission or an I/O error) says nothing of its holder and is
never taken over. Who may claim, take over, hand over and release is one
pure function of the claim file, its holder as the asker's judgement sees
it, the mutex and the asker (`decideClaim`); a reader (the manual verb,
the doctor, the session notices) says a worker runs exactly when the
claimer of its judgement would leave the claim, and names no process
when the file holds none.

What the claim guards, and what the gate guards: the migration itself
(the store's records, the legacy tree, the switch) runs inside the
migration gate, which no automatic path takes over from a holder that
may still run, so two migrations of one vault never overlap whatever the
claim says. Before a run holds the gate it writes only what is the same
whoever writes it (the store's format notes and held-partition list, the
opening of a gate whose run is gone); the vault identity marker is read,
or written when missing, under the gate, so two runs that both found no
marker cannot record different ids. Everything else a worker writes (its attempt record and what
replaces it, waits, failures, success outputs and their marks, the
notice, the metrics row, the log line, a store it creates) is guarded by
the claim alone, and the exact judge may take a claim over while its
holder still runs (no identity, past the hour). So each of those writes
is made under the claim's mutex after checking that the claim is still
the writer's (`auto-claimed-writes.ts`): once a claim is taken over, its
old holder writes nothing more. The worker gets these writes only with
its claim, so its first decision, taken before the claim, writes
nothing; an answer that writes (a moot record to clear, a wait to
remember) is decided again and written under the claim. A start releases
the claim it made only when no worker started; once a worker runs, the
claim is the worker's even when the hand-over fails.

Each attempt records itself before it does anything else: a failure
record with the cooldown a failure would start, marked as an attempt in
flight. Its outcome replaces it (cleared on success, the waiting state, or
the failure with its reason). A killed attempt, or one that cannot write
its outcome (a full disk), leaves that record, so the next starts do not
each spawn a worker; no other way exists that needs no disk write at the
moment of failure, because the cooldown has to outlive the process. A
failure starts a cooldown that doubles per consecutive failure, like the
self-heal upgrade's; the waiting state starts no cooldown, because waiting
for another device's cut is not a failure.

### D3. The worker

`o2b brain migrate-store --auto <token>` runs
`runAutoStoreMigration` in its own process with its streams ignored. It
never throws: every state, notice, row and log write is guarded, and one
guard around the whole attempt turns anything left into `failed`.

1. The opt-out is honoured (D5): it stops a migration from starting, not
   the completion of an attempt that already started (rules 2 and 10). A
   vault with no legacy data writes nothing beyond dropping a moot state
   record. (The spawner, not the
   worker, leaves a vault that is not initialised alone.)
2. On a switched machine the worker finishes what is left (D1), read
   again once it holds the lock: an interrupted switch through
   `finishInterruptedSwitch` (unless a live run still holds the gate),
   which binds the vault that run migrated and never imports a vault
   configured since, then the success outputs; or only the success
   outputs an automatic attempt did not write. Each output (the metrics
   row, the brain log line, the notice) is marked on the attempt's record
   once written, so a pass writes only the unmarked ones, looks for the
   row and the log line of the run first, and never shows again a notice
   a session already showed. A failure while finishing is
   recorded with a cooldown; the record a switching attempt left is
   finished at once.
3. A machine the operator rolled back (its run `rolled-back`) is not
   migrated again on its own, whatever the setting (outcome
   `rolled_back`); `o2b brain migrate-store` migrates it again.
4. The gate of another live migration is left alone (outcome `running`,
   nothing recorded). The managed-file upgrade runs first, through
   `runSelfHealUpgrade` and its own lock, unless a migration gate exists
   (an interrupted run this attempt resumes, whose gate refuses the
   upgrade's writes); a `MigrationInProgressError` inside the upgrade is
   `running`, not a recorded upgrade failure. An upgrade worker of an
   earlier start still running holds the attempt off (outcome `running`,
   the attempt's record taken back).
5. The dry run is computed first; an unmapped entry or an unparseable item
   stops the attempt with a failure that names them and
   `o2b brain migrate-store --dry-run`: unattended, the person decides
   whether keeping an item only in the backup archive is acceptable.
6. The cheap preflights run before anything is created: the store root
   outside the vault, a readable store (one that cannot be read right now
   is a wait, not a failure), the device id, a store that holds `shared`,
   the gate of another vault's migration, the free disk. A refusal there
   writes nothing but the failure record.
7. With no store yet: when the synced Brain log holds another device's
   `store-migration` snapshot event, that device already started
   migrating this vault into a store this machine has not received; the
   attempt waits (D7). Otherwise the store is initialised at the resolved
   root through the code `o2b store init` runs (identity files, format
   document, view writer claim, the device binding).
8. The migration runs through `migrateStore`, the one entry point the CLI
   verb uses, always with `resume: true`, so an interrupted run continues
   instead of starting again.
9. Outcome `waiting` records the waiting state and starts no cooldown and
   no failure marker; the next start tries again.
10. A failure before the switch record reopens the gate (the migrator's
    own `finally`, or the takeover of a dead run's gate on the next
    attempt) and leaves the machine on the legacy layout; the attempt
    writes the failure marker with the reason and the manual command. A
    failure after the switch record keeps the attempt's record, so the
    next start finishes the switch (rule 2). No automatic rollback is
    taken.
11. Success appends one `auto_store_migration` metrics row and one line to
    the brain log and writes the one-time notice (the snapshot; none named
    when no snapshot was taken), marking each on the attempt's record once
    written, then clears the record once all three are written.
    The log line lands in the store's `shared` partition, so it names the
    run, the device and the snapshot, never a local path. Failure texts
    are kept and shown with control characters replaced and home
    directories reduced to `~`.
12. A run that failed after its backups is not resumed, so each retry
    takes a backup of its own; the backup folder keeps only the copy of
    the newest snapshot, and the vault's `Brain/.snapshots/` keeps its own
    retention.

### D4. Foreground paths

`o2b update` ends with the same check and, when a migration is available
and enabled, the same worker logic in the process, with progress lines on
stderr. The outcome is reported in the text and in a `store_migration`
field of the `--json` output. A migration failure does not change the
update's exit code; it is named. `--skip-store-migration` skips it once.
`o2b brain upgrade --dry-run` names a pending migration and what the next
start will do (and the opt-out when it is off). A manual
`o2b brain migrate-store` run refuses with a message while the automatic
worker of this vault runs (a lock whose worker is gone refuses nothing);
the dry run stays available. A manual migration that succeeds clears the
automatic migration's state.

### D5. Opt-out and control

The machine config key `auto_store_migration` defaults to on; consent is
per machine, so the key lives in the machine config, never in the synced
store or vault. It is a consent switch, so it fails closed: on only for
`true`, `1`, `yes`, `on`; off for `false`, `0`, `no`, `off` (any case,
surrounding space and a trailing inline comment ignored); any other value,
a key with no value, or a machine config that cannot be read is off, and
the doctor and the status block name the value they did not recognise.
`OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION` (CI, tests) takes the same values,
and off wins: when either the key or the variable says off, it is off; the
variable can never turn the migration on over a config opt-out, and a
blank variable counts as unset. With it off, the migration is offered
where it is offered today (doctor, status, the session start notice,
`o2b update`, `brain upgrade --dry-run`) and never started. The setting
governs starting a migration only: finishing an automatic attempt that
already started (a switch that did not finish, a run killed while it held
the migration gate) is not a new migration, asks no consent, and runs
whatever it says. A machine that ended on the legacy layout stays there.

### D6. Reporting

`autoMigrationReport()` answers with one state:
`not_needed` (no legacy data, or nothing to move), `pending` (will run at
the next start, or the switch left to finish, or the opt-out with any
unrecognised value named in `setting_problem`), `running` (since when, which process), `waiting` (for
another device's cut), `failed` (reason, next automatic attempt, the
manual command; an attempt killed with the gate closed says that the next
start finishes it), `done` (this machine switched) or `rolled_back` (the
operator rolled it back; the automatic migration never redoes that, and
the doctor says so instead of calling the automatic migration off). The store status
block's `migration` carries it, the doctor's migration finding words its
message from it and adds a warning when a failure is recorded, and the
session start digest carries at most one short line about a failed or
waiting migration through the runtime notices channel, inside the
digest's budget. None of these reads the state its own way: the report,
the doctor's finding, the notice line, `o2b update --dry-run` and a
start's answer are each derived from the gate decision's answer and its
reason (`reportOf`, `migrationFindingKind`, `failureNoticeTail`,
`dryRunOf`, `startDecisionOf`), and one table test walks every answer
against every surface. A stopped run's gate the next start opens is
reported as that, never as a run that changed nothing, and a dry run
names a refusal with the command that clears it. A read that fails (the
gate, the attempt record, the run state or its store, the legacy tree,
the claim) is its own state in the gathered decision, never "absent".
The one-time success notice is shown once at a session
start (the brain moved, where the snapshot is, how to roll back) and then
cleared.

### D7. A second machine whose copy of the store has not arrived

Two machines that share a vault must not each create a store. The vault
binding is device-local and does not travel; the vault identity marker is
written by `o2b brain init` as well, so it marks nothing. What does travel
with the vault is the Brain log, sharded per device: the migration
snapshots `Brain/` after it closes the gate and logs a `snapshot` event
with the reason `store-migration` in its own shard. A legacy machine with
no store that finds such an event in another device's shard waits (state
`waiting`, naming that device and what it waits for, with the manual
commands should this machine have a store of its own) instead of
creating one.

The look is bounded per start, however many years of shards the vault
holds: one listing of `Brain/log/`, then per other device (at most 32,
ordered by the name of their newest shard, which begins with its date: the
device whose last legacy log line is newest first, and devices of the same
day in name order) its newest two shards, and of each the last 256 KiB. A
device that started migrating writes its snapshot event as its last legacy
log line (after the switch it writes none), so the event is at the end of
its newest shard, or of the one before when the run crossed midnight. A
line the window starts inside is read back to its start (up to 64 KiB
more), so a snapshot event the window cuts is still read whole. What
the look answers is one pure function of the listing and the reads
(`judgeMarkScan`): a shard that cannot be read or comes back short, a
line that starts too far back to be read whole, and a last line without
its newline (sync is still writing it) each make the look incomplete
unless a mark is found elsewhere, and an incomplete look is a wait,
never "no mark". Ties in the order of shards and devices are broken by
path and device id, so the answer never depends on the order of the
listing. The
look misses the mark of such a device in two cases. One is a device that
went on writing legacy log lines on two or more later days, which means
its migration did not switch it or it was rolled back; its store was
created before the mark and has had those days to arrive. The other is
the device limit: when 32 or more other devices have a newest shard that
sorts above the migrating device's (written on a later day, or on the
same day under a name that sorts higher), that device is not read, this
machine sees no mark, and it creates a store of its own: the second store
the wait exists to prevent. A vault shared by that many devices that
write its legacy log on the same days is outside what the look covers;
there, run the migration on one machine first and give the others its
store before they start. The log records no rollback (the rollback restores the
snapshot and writes the device's records back, the event included), so
"a mark older than a rollback" is not knowable from the vault; the
newest-shards rule is what lets a rolled-back device's mark lapse. The
answer is remembered in the waiting record (`awaits_store`): while the
store is still absent, a start starts no worker and reads no shard for a
day after the record, then a worker looks again. The window that remains: two machines starting before
either one's log shard has synced to the other each create a store; when
sync brings both to one root, the store refuses to open with partitions of
two stores, and doctor and status report the error. The documentation
advises updating one machine first.

## Alternatives

- Run the migration inside the hook or the server process. Rejected: the
  migration is unbounded in time and holds the migration gate while it
  runs; a hook must not freeze for minutes.
- Roll back automatically on any failure. Rejected by reading the
  migrator: no failure point needs it. The switch is the last step after
  verification, so every earlier failure leaves the machine unswitched
  with its backups and journal intact, and a failure after the switch is
  a switch to finish, not to undo. A rollback would add a destructive
  path for a state that does not occur.
- A version stamp that marks the migration offered. Rejected: the
  state-driven rule of `ensureVaultCurrent` (no stamps; the on-disk state
  decides) already handles interrupted runs, downgrades and synced
  machines.
