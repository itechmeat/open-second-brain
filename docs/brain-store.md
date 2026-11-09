# The brain store: setup, sync and migration

Open Second Brain keeps its machine data (signals, preferences, the log,
ledgers, settings) in the **brain store**: a folder of append-only files
outside your Obsidian vault. People read the brain through the **human
view**: a few plain Markdown pages that one machine writes into a folder you
choose. This guide covers setting both up on one or more machines, syncing
them, moving an existing install whose data still lives in the vault's
`Brain/` folder, and what to do when doctor reports a problem.

The on-disk format is documented in `FORMAT.md` at the root of every store.
Every flag of every command below is in the [CLI reference](cli-reference.md).

The command blocks in this guide are run as written by a test
(`tests/docs/brain-store-guide.test.ts`) against throwaway machines. The
HTML comment above each block tells that test which machine runs it and how
the commands should exit; a Markdown viewer does not show it.

## The pieces

| Piece | Where | Synced |
| --- | --- | --- |
| `shared/` partition | `<store root>/shared` | Yes, to every machine that runs an agent |
| `private/` partition | `<store root>/private` | Yes, but only to machines you trust with private records |
| Store root | `store_root` in the machine config | No: the root is never a sync folder itself |
| Device-local state | the platform state directory, keyed by store id | Never |
| Human view | `view_target` in the machine config | Its own folder, to the view writer and to phones |

- **The store root** is a plain folder that holds the two partition folders
  and a copy of `FORMAT.md`. It is never synced as a whole.
- **`shared/`** holds everything that is not private.
- **`private/`** has the same shape and holds records about private pages
  (a note whose frontmatter `visibility` includes `private`, an informal
  marker such as `access: private`) and text inside a
  `<private>...</private>` region.
- **The device-local state directory** holds this machine's search index,
  locks, caches, hook state, snapshots and migration backups. On Linux and
  macOS it is `${XDG_STATE_HOME:-~/.local/state}/open-second-brain/stores/<store id>`,
  on Windows `%LOCALAPPDATA%\open-second-brain\stores\<store id>`. It must
  never be synced: two machines sharing it would share clocks and locks.
- **The human view** is the only part meant for people. It is written by one
  machine, the view writer, and can live inside your vault or anywhere else.

The store root comes from `OPEN_SECOND_BRAIN_STORE_ROOT`, then `store_root`
in the machine config, then a per-user default
(`${XDG_DATA_HOME:-~/.local/share}/open-second-brain/store` on Linux and
macOS). A root inside the vault is refused. The machine config is
`~/.config/open-second-brain/config.yaml` on Linux and macOS and
`%LOCALAPPDATA%\open-second-brain\config.yaml` on Windows; `XDG_CONFIG_HOME`
moves it on every platform, and `OPEN_SECOND_BRAIN_CONFIG` names another file. It is a simple
`key: value` file; edit it with any text editor.

## Setup

### The first machine

Pick where the store and the view live before the first command, so the
folders you will sync have stable names. Add to the machine config:

<!-- doc-test: scenario=setup machine=laptop config -->
```yaml
store_root: ~/brain-store
view_target: ~/brain-view
```

Then initialise. With no vault the brain works from the store alone:

<!-- doc-test: scenario=setup machine=laptop exit=0 expect="This machine" -->
```sh
o2b init --agent-name laptop-agent
o2b store path
```

`o2b init` creates the store (both partitions, one store id) and makes this
machine the view writer. `o2b store path` prints where everything is: the
store root, each partition and whether this machine holds it, the
device-local state directory and the view target, each with the setting
that put it there (`env`, `config` or `default`) and whether it exists:

<!-- doc-test: scenario=setup machine=laptop exit=0 expect="(config, missing)" -->
```sh
o2b store path
```

The view target line reads `view target:  <folder> (config, missing)` until
the first render creates the folder, and `none` when `view_target` is not
set. It creates nothing, so it is safe to run at
any time; `--json` gives the same answer to scripts, and agents read it from
the `store` block of `second_brain_status`.

With an Obsidian vault for your own notes, name it in `o2b init`:

<!-- doc-test: scenario=vault machine=laptop exit=0 expect="initialized the brain store" -->
```sh
o2b init --vault ~/vault --agent-name laptop-agent
```

On a vault that has no `Brain/` folder yet this also creates the store, so
the brain never writes machine data into the vault. On a vault that already
has `Brain/`, `o2b init` only records the vault: follow
[Moving an existing install](#moving-an-existing-install) below.

`o2b store init` is the explicit way to create a store. You need it when
`o2b init` did not create one (a vault with a legacy `Brain/` tree), or to
add a partition later. It refuses a store that already exists, so it never
replaces one by accident:

<!-- doc-test: scenario=setup machine=laptop exit=1 expect="already" -->
```sh
o2b store init
```

### More machines

A second machine does not create a store. It receives the partitions
through sync and joins them:

1. On the new machine, set the same kind of config. The paths are local to
   that machine and may differ from the first one:

   <!-- doc-test: scenario=setup machine=desktop config -->
   ```yaml
   store_root: ~/brain-store
   view_target: ~/brain-view
   ```

2. Point your sync tool at `~/brain-store/shared` and
   `~/brain-store/private` on this machine (see [Syncing](#syncing)) and
   wait until both folders have arrived.
3. Check that this machine sees the same store id as the first one, then
   initialise:

   <!-- doc-test: scenario=setup machine=desktop exit=0 expect="already exists" -->
   ```sh
   o2b store path
   o2b init --agent-name desktop-agent
   ```

   `o2b init` says the store already exists and binds this machine to it.

Run `o2b init` only after the partitions have arrived. On an empty store
root it creates a new, separate store with its own id; if that happens,
stop, delete the new empty store folder, wait for sync and run `o2b init`
again.

Every machine needs its own `device_id`. `o2b init` generates one and saves
it in the machine config. Never copy a machine config, or the device-local
state directory, from one machine to another.

### A server that holds only shared data

A server or VPS that runs an agent but should never hold private records
gets only `shared/`. Configure it like any other machine, sync only
`~/brain-store/shared` to it, and initialise:

<!-- doc-test: scenario=setup machine=server config -->
```yaml
store_root: ~/brain-store
```

<!-- doc-test: scenario=setup machine=server exit=0 expect="not held" -->
```sh
o2b init --agent-name vps-agent
o2b store path
o2b brain note "The nightly backup finished"
o2b brain doctor
```

`o2b store path` lists `private` as `not held`. Reads work on what is
present, and every write that is not private lands in `shared/`. A write
that would create a private record is refused, and nothing is written:

<!-- doc-test: scenario=setup machine=server exit=1 expect="does not hold the private partition" -->
```sh
o2b brain note "Rotated the deploy key <private>key id 1234</private>"
```

```text
error: the brain store write failed: this machine does not hold the private partition of the brain store at /home/me/brain-store; the record was not written. Sync that partition's folder of the store to this machine, or make the write from a machine that holds it.
```

Agents over MCP get the same refusal as a tool error. Make such writes from
a machine that holds `private/`.

If the server is the very first machine, create the store there with only
the shared partition:

<!-- doc-test: scenario=server-first machine=server exit=0 -->
```sh
o2b store init --partitions shared
```

Later, on a machine you trust with private records and that has received
`shared/`, add the private partition. It gets the same store id; sync it
from there to the other trusted machines:

<!-- doc-test: scenario=server-first machine=desktop exit=0 -->
```sh
o2b store init --partitions shared,private
```

## Syncing

Open Second Brain never syncs anything itself. Use any file sync tool:
Syncthing, a cloud drive folder, or similar.

- **Sync `shared/` and `private/` as two separate folders.** That lets you
  give each machine exactly the partitions it should hold.
- **Never sync the store root itself.** It would sync both partitions as
  one unit, and a machine could no longer leave `private/` out.
- **Never sync the device-local state directory.** It lives outside the
  store root by default; keep it out of every sync folder. Doctor reports it
  as `store-device-state-foreign` when another device's entries show up in
  it.
- **Every machine that runs an agent** gets `shared/`. Machines you trust
  with private records also get `private/`.
- **A server or VPS that should hold only shared data** gets only
  `shared/`.
- **Phones get only the view folder** (`view_target` on the view writer),
  never the store. A phone has no Open Second Brain install; it reads and
  edits pages, and the view writer picks up the edits (see
  [The human view](#the-human-view)).

Files in the store are append-only and every device writes only its own
files, so two machines never edit the same file and sync conflicts do not
arise in normal use. A record from another machine is visible as soon as
your sync tool has delivered the file: search and the other readers catch
up with the store before they read.

## The human view

The view is a small, stable set of plain Markdown pages, rendered from the
store into the `view_target` folder:

| Page | What it holds |
| --- | --- |
| `about-me.md` | What the brain knows about you: confirmed rules, grouped by subject |
| `history/<YYYY>-W<ww>.md` | One page per week of what happened, in plain language |
| `decisions.md` | Decisions that were recorded |

Each page starts with one HTML comment line that names the store and the
page; there is no frontmatter and there are no Obsidian-only links, so any
Markdown viewer shows them. Raw signals, log events, ledgers and caches
never appear in the view. The number of files grows with weeks, not with
signals, and a render with nothing new changes no file. Generated headings
and introductions follow the shared `view.language` setting (English when
it is unset; English and Russian ship); rules and quotes stay in the
language they were written in. Set it once, on any machine, and every
machine's view follows after sync:

<!-- doc-test: scenario=setup machine=laptop exit=0 expect="view.language: null ->" -->
```sh
o2b brain settings set view.language ru
o2b brain settings unset view.language
```

A language the view has no strings for is refused and the command names
the ones it has; a regional tag of one (`ru-RU`) is accepted.
`o2b brain settings unset view.language` goes back to English.

With no `view_target` no page is written anywhere, and the brain works the
same.

A view folder inside the vault belongs to the view writer: the note tools
(`brain_create_note`, `brain_update_note`, `brain_append_note`, the write
batch and the note and folder lifecycle) refuse a path in it, as they refuse
`Brain/`, because an edit of a view page is read back as yours. When the view
folder is the vault root, only the view's own pages, their conflict copies and
`history/` are refused.

### The view writer

Exactly one machine writes the view: the **view writer**. The machine that
creates the store becomes the view writer. It renders at the end of every
dream pass and, at most once an hour, when a session starts. You can also
render by hand:

<!-- doc-test: scenario=setup machine=laptop exit=0 -->
```sh
o2b view writer
o2b view render
```

<!-- doc-test: scenario=setup machine=laptop exit=0 expect="about-me.md" -->
```sh
o2b view render
```

A machine that has just taken the role renders from its next catch-up, so
its first `o2b view render` may only say so. A machine that is not the view
writer never writes pages; `o2b view render` there names the view writer.

To move the role, run this on the machine that should render the view:

<!-- doc-test: scenario=setup machine=desktop exit=0 expect="hand the view writer role" -->
```sh
o2b view writer --here
```

The current writer releases the role at its next catch-up (its next render,
dream pass or session start). This machine starts rendering only after that
release has synced here, so no page is ever written by both:

<!-- doc-test: scenario=setup machine=laptop exit=0 expect="Handed the view writer role" -->
```sh
o2b view render
```

<!-- doc-test: scenario=setup machine=desktop exit=0 expect="(this machine)" -->
```sh
o2b view writer
```

When the old writer is gone (a dead laptop), take the role at once:

<!-- doc-test: scenario=setup machine=laptop exit=0 expect="did not release it" -->
```sh
o2b view writer --here --force
```

A forced move warns that the old writer, if it is still running somewhere,
may render once more before the change reaches it; it stops at its first
catch-up after that. Move the view folder in your sync tool along with the
role, so the new writer renders into the folder your phone reads.

If the view writer stays silent for more than 3 days, doctor on every
machine reports `view-writer-silent` and names the command to move the
role. Pages go stale meanwhile, but no data is lost.

### Editing pages on a phone

Sync the view folder to your phone and edit a page in any Markdown editor.
On `about-me.md`, rewrite a rule's wording to correct it, or delete its
line to retire it. Before the view writer rewrites a page it compares the
file with what it rendered last; a difference is your edit, which it stores
as a **human record** (human records win over anything an agent or a model
recorded) and then keeps in the new render. The render report says
`1 edit(s) stored` for that page.

An edit that lands while a render is in progress is never silently lost.
The writer keeps the bytes it replaces for 30 days, and when those bytes
differ from what it rendered last, it records them as an edit and renders
again, so the edit shows up one render later. A sync-conflict copy of a
page, when your sync tool makes one, is taken in the same way and removed.
To see or restore an older version of a page:

<!-- doc-test: scenario=setup machine=laptop exit=0 -->
```sh
o2b view recover about-me.md
```

It lists the replaced versions of the last 30 days with an id each;
`o2b view recover about-me.md --print <id>` prints one.

## Moving an existing install

An install from before the brain store keeps its machine data in the
vault: `Brain/` and `.open-second-brain/`. `o2b brain migrate-store` moves
it into the store. Nothing moves until you run it; status and doctor only
say that a migration is available.

Every machine migrates on its own, one after the other. The commands below
assume the machine config already names the vault (it does on any existing
install) and that you have set `store_root` as in [Setup](#setup).

### 1. Check and dry run on the first machine

<!-- doc-test: scenario=migration machine=laptop exit=any expect="migration-available" -->
```sh
o2b brain doctor
```

Doctor lists `migration-available` and the commands to run. This note, and
the other migration notes below, do not change doctor's exit code.

Create the store, then do a dry run:

<!-- doc-test: scenario=migration machine=laptop exit=0 expect="Every legacy entry has a destination" -->
```sh
o2b store init
o2b brain migrate-store --dry-run
```

The dry run writes nothing anywhere. It lists the devices found in the
legacy tree (the **migration cohort**), where each surface would go (a
store stream and partition, the device-local state, an explicit backup, or
drop with the reason), every item it cannot read, and every legacy file no
mapping covers. It exits 1 while anything is unmapped; move such a file out
of `Brain/` (or report it) and run the dry run again.

### 2. Migrate the first machine

<!-- doc-test: scenario=migration machine=laptop exit=0 expect="device-switched" -->
```sh
o2b brain migrate-store
```

The migration:

1. closes a migration gate on this machine, so agents here are refused
   with a "migration in progress" message while it runs (other machines
   keep working);
2. snapshots `Brain/` and backs up every surface nothing can rebuild
   (secrets, keys, attestations, checkpoints) into the device-local state,
   each verified by a test restore;
3. imports every item through a journal, then re-scans until a pass
   imports nothing, and verifies every item against the store;
4. records `migration-done` and this machine's `device-switched`, and makes
   this machine the view writer if no machine is.

The legacy tree stays in the vault. If the run is interrupted,
`o2b brain migrate-store --resume` continues without importing anything
twice. If verification finds a gap, the legacy tree is left untouched and
the report names each missing item. If a run that is gone (a crash, a
closed terminal) still holds the gate and you will not resume it right
away, `o2b brain migrate-store --force-release-gate` opens it again; it
refuses while the run that holds the gate is still running.

From now on this machine writes only to the store. Render the view twice
(the first render after the claim only catches up), and check doctor:

<!-- doc-test: scenario=migration machine=laptop exit=0 -->
```sh
o2b view render
o2b view render
```

<!-- doc-test: scenario=migration machine=laptop exit=any expect="legacy-devices-pending" -->
```sh
o2b brain doctor
```

Doctor now reports `legacy-devices-pending` with the devices of the cohort
that have not switched yet.

### 3. Migrate the later machines

On every other machine, upgrade, set `store_root`, let sync deliver
`shared/` and `private/`, and run the same commands. Do not run
`o2b store init` here: the store comes through sync.

Run the first migration on one machine, and wait for its completion
record to sync before migrating the others. A machine that already holds
another device's `migration-done` takes the later-machine path; two
machines that migrate before either record has synced both run as the
first machine, and doctor then reports `migration-done-twice`.

<!-- doc-test: scenario=migration machine=desktop exit=0 expect="later machine" -->
```sh
o2b brain migrate-store --dry-run
o2b brain migrate-store
```

A later machine first waits until its copy of the store holds everything
the first machine recorded in `migration-done`. Until then it writes
nothing, names the missing files and exits 1; run it again later, or add
`--wait <seconds>` to keep polling. A partition this machine does not hold
is skipped and named. It then imports the legacy items the store does not
hold yet (this machine may have records the first one never saw), copies
its own device-local state and records `device-switched`.

### 4. The transition

While some machines still run an older release, they keep writing into
the legacy `Brain/` tree, and your sync tool delivers those files to the
switched machines. A switched machine imports them, line by line and
exactly once, at every dream pass and at most once an hour at session
start. To import them right away:

<!-- doc-test: scenario=migration machine=laptop exit=0 expect="imported late legacy writes" -->
```sh
o2b brain migrate-store
```

A switched machine never writes into the legacy tree. Doctor on every
switched machine names the devices still on the legacy layout
(`legacy-devices-pending`) until each has migrated or been retired.

### 5. Rolling back a machine

Until the legacy tree leaves the vault, any machine can go back to the
legacy layout:

<!-- doc-test: scenario=migration machine=desktop exit=0 expect="back on the legacy layout" -->
```sh
o2b brain migrate-store --rollback
```

Rollback restores `Brain/` from this machine's migration snapshot and its
backups, then writes back every store record the restored tree lacks
(signals, log events, preferences, pinned context and record pages,
including records from other machines that arrived after the snapshot), in
order and without duplicates. Records with no legacy form (view renders,
migration records) stay in the store, and the report lists them. Ledger
rows written after the switch (idempotency receipts, continuity, truth
claims and the other ledgers) are not written back either: they stay in
the store only, so the old release does not see them, and the report
warns with their count per ledger (`ledger_rows_kept` in `--json`). An
interrupted rollback resumes without writing anything twice. Doctor on that
machine reports `migration-available` again; to switch again, run
`o2b brain migrate-store` once more.

### 6. Removing the legacy tree

The legacy tree leaves the vault only when every device of the migration
cohort (every device id found anywhere in the legacy tree, however old) has
switched or been retired. Until then the removal refuses and names the
devices it waits for:

<!-- doc-test: scenario=migration machine=laptop exit=1 expect="the legacy layout" -->
```sh
o2b brain migrate-store --remove-legacy
```

`o2b store device list` shows every device the store knows: its id, its
last record, and whether it switched, is still on the `legacy` layout, or
was `retired`:

<!-- doc-test: scenario=migration machine=laptop exit=0 expect="dev-c" -->
```sh
o2b store device list
```

Migrate each named machine that is still in use. Retire a machine that is
gone for good, from any other machine (never from the machine itself,
which is refused). Retiring writes one record in the shared settings that
takes the machine off the digest roster (`store-digest-silent` stops naming
it) and out of the devices the removal waits for:

<!-- doc-test: scenario=migration machine=laptop exit=0 expect="Retired dev-c" -->
```sh
o2b store device retire dev-c --reason "old laptop, sold"
```

If a retired machine writes again later (it came back, or a new machine
reuses its id), it is on the roster again and doctor reports
`store-device-retired-returned`.

Here the desktop was rolled back in the previous step, so it switches
again first:

<!-- doc-test: scenario=migration machine=desktop exit=0 expect="device-switched" -->
```sh
o2b brain migrate-store
```

Now every cohort device has switched or been retired, and the removal
goes ahead:

<!-- doc-test: scenario=migration machine=laptop exit=0 expect="nothing was deleted" -->
```sh
o2b brain migrate-store --remove-legacy
```

To remove the tree while a machine that is still in use stays on the
legacy layout, `--force` removes it anyway and the report names the
devices that will no longer reach the store; prefer migrating or retiring
them.

The removal first imports any late legacy writes, then moves `Brain/` and
`.open-second-brain/` out of the vault into a dated archive in this
machine's device-local state. Nothing is deleted; the archive leaves out
only what a rebuild recreates (the search index, caches, generated pages),
and the report lists those. Afterwards the vault holds your notes and, if
`view_target` points into it, the view folder. A rollback is no longer
possible:

<!-- doc-test: scenario=migration machine=laptop exit=1 expect="rollback is only possible until then" -->
```sh
o2b brain migrate-store --rollback
```

If a `Brain/` folder appears in the vault again (an agent or tool still
follows old instructions), doctor reports `legacy-tree-reappeared` with the
writer when a file names it. Nothing reads that folder; stop the writer and
move the folder out of the vault.

## What the partitions protect, and what they do not

The partitions decide **which machines receive which records**. They are a
routing rule, not encryption.

What they do:

- A machine that never receives `private/` never holds a private record.
  A write there that would create one is refused with the message above;
  nothing is written and nothing falls back to `shared/`.
- A record that cannot be judged (a page that cannot be read, a reference
  the brain cannot resolve) counts as private, so a mistake keeps data out
  of `shared/` rather than in it.
- Records never move between partitions after they are written.

What they do not do:

- **No encryption at rest.** Store files are plain JSON lines, readable by
  anyone who can read the folder. The store keeps its folders at mode 0700
  and its files at 0600, and doctor reports looser modes
  (`store-mode-loose`), but disk encryption and the security of your sync
  tool (who it shares a folder with, whether a cloud provider can read it)
  are their job, not the store's. Choose a sync tool you trust for
  `private/` in particular.
- **Removed is not erased.** Shards are append-only. Retiring a rule,
  correcting it on a view page or unpinning context appends a new record;
  the old line stays in the shard, on every machine that holds the
  partition, until a future compaction rewrites that shard. Do not put a
  secret into the brain expecting a later delete to scrub it from every
  copy.
- **The view is outside the partitions.** Pages are rendered by the view
  writer from what it holds, and they go wherever you sync `view_target`.
  Do not sync the view folder to a device that should not see what the
  view writer knows.
- **Backups and archives stay local.** Migration backups and the legacy
  archive live in the device-local state of the machine that made them.
  Back up that directory with the rest of the machine if you need to.

## Troubleshooting

Run `o2b brain doctor` on the machine in question. These are the findings
that come from the store, the migration and the view:

| Code | What it means | What to do |
| --- | --- | --- |
| `store-missing` | No store exists at the configured root. | Run `o2b init` (or `o2b store init`) on the first machine; on other machines check `store_root` and wait for sync. |
| `store-root-invalid` | The store root cannot be used: it is inside the vault, or holds partitions of two different stores. | Point `store_root` outside the vault, and keep only one store's partitions under it. |
| `store-partition-lost` | A partition this machine has held (it opened or initialised it here) no longer shows its `store.json`. The store is not opened: every protection fails closed and every store write is refused, because the partition's records cannot be read. | Restore that partition's `store.json` from sync or a backup. No command takes a partition off this machine's list. |
| `store-device-state-foreign` | The device-local state directory holds entries of other devices: it was put into a sync folder. | Remove it from the sync tool, sync only `shared/` and `private/`, then delete the other devices' entries in it. |
| `machine-state-adopt-conflicts` | When this machine switched, two fresh vaults held a machine-state file with different bytes; the first vault's copy is live and the other is kept in the `adopt-conflicts/` folder the finding names, with the file count. | Compare each kept file with the live copy at the same path, copy over what is still needed, then delete the folder. |
| `store-mode-loose` | Store files or folders are readable by other accounts on this machine. | Run the `chmod -R go-rwx` command the finding prints. |
| `store-partition-unreadable`, `store-shard-unreadable` | A partition or a shard could not be read, often while a sync client holds the file. | Run doctor again after sync settles; if it persists, check file permissions. |
| `store-shard-tail-held` | The last line of another device's shard is incomplete (a crash in an append, or a partial sync copy). | Usually nothing: the next append by that device starts a new line. Check that device's sync if it lasts. |
| `store-digest-silent` | A device wrote to a partition but has published no state digest for 7 days. | Bring that machine online and let it sync. Retire a machine that is gone for good with `o2b store device retire <device-id>`; the finding changes no data. |
| `store-digest-divergent` | Two machines computed different state from the same records: a bug. | Keep both machines' store folders as they are and report it. |
| `store-record-id-conflict` | One record id arrived with different content: a shard file was edited, or a writer has a bug. | Find the edited shard; records must never change after they are written. |
| `store-record-id-cross-partition` | One record id is in both `shared/` and `private/`. | Remove the line from the shard that should not hold it. |
| `store-device-retired-returned` | A device you retired wrote a record after its retirement, so it is on the digest roster again. | Nothing to do if the machine is back on purpose (migrate it if it still keeps the legacy tree). If a new machine reused the id, give it its own `device_id` and retire the old id again. |
| `store-clock-ahead` | Records carry a clock more than a day ahead of now. | Fix the clock of the device the finding names. |
| `store-device-dir-reserved` | A peer's device id is a name Windows reserves (such as `con`), so its folder cannot exist on Windows. | Give that peer another `device_id` in its machine config. |
| `store-write-fail-open` | Writes from hooks or telemetry did not land (no store yet, no device id, a missing partition); their callers went on. | Fix the cause the finding names, then delete the counter file `store-write.json` in the `stores` state directory (`~/.local/state/open-second-brain/stores/` on Linux) to reset it. |
| `store-dual-write-failures`, `store-dual-write-skipped`, `store-dual-write-no-store` | Only on a machine running the phase 1 dual-write trial (`store_dual_write`): store copies of legacy writes failed or were skipped. | Fix the cause, or migrate the machine and turn the trial off. |
| `migration-available` | This machine still keeps its brain in the vault's `Brain/` tree, or it switched before this vault was configured and the vault's legacy tree was never imported. | Follow [Moving an existing install](#moving-an-existing-install); on a switched machine run `o2b brain migrate-store`, which imports the tree and binds the vault. |
| `legacy-devices-pending` | This machine switched, but the named devices still write the legacy tree. | Migrate each named machine, and retire the ones that are gone with `o2b store device retire <device-id>`. |
| `legacy-tree-reappeared` | A `Brain/` folder is back in the vault after the legacy tree was removed. | Stop the writer the finding names and move the folder out of the vault. |
| `migration-done-twice` | Two devices each ran the first migration of this vault, before either completion record had synced, so items both imported are in the store twice. | Nothing is lost and both records stay. Migrate every other machine only after one completion record has synced. |
| `view-writer-silent` | The view writer has published nothing for more than 3 days. | Run `o2b view writer --here` on the machine that should render the view, with `--force` if the old writer is unreachable. |

Other questions that come up:

- **A machine shows a different store id.** It ran `o2b init` before sync
  delivered the partitions and made a store of its own. Delete that empty
  store, wait for sync and run `o2b init` again.
- **Records from another machine are missing.** Check that your sync tool
  has delivered the partition folders (`o2b store path` on both machines
  shows the same store id and both partitions as held where expected).
- **A later machine's migration exits 1 and names missing shards.** The
  first machine's files have not arrived yet. Wait for sync and run it
  again, or use `--wait <seconds>`.
- **No page appears in the view folder.** Check `view_target` on the view
  writer, and that `o2b view writer` names that machine.
