# The brain store: setup, sync and migration

Open Second Brain keeps its machine data (signals, preferences, the log,
ledgers, settings) in the **brain store**: a folder of append-only files.
With a vault, the store lives in a hidden folder of the vault,
`.open-second-brain-store/`, so it travels to every machine with the sync
you already use for the vault and needs no setup of its own; the note
tools, search and the view writer never look inside it. With no vault, or
with a `store_root` you set, it lives where that says. People read the brain through the **human
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
| Store root | `<vault>/.open-second-brain-store/` by default; `store_root` in the machine config moves it | With the vault, when it is the default; otherwise never as a whole |
| Device-local state | the platform state directory, keyed by store id | Never |
| Human view | `view_target` in the machine config; by default the vault's `brain-view/` folder | Its own folder, to the view writer and to phones |

- **The store root** is a plain folder that holds the two partition folders
  and a copy of `FORMAT.md`. The default root inside the vault travels
  with the vault; a root you set elsewhere is never synced as a whole.
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
in the machine config, then a default. With a vault the default is the
vault's reserved folder `.open-second-brain-store/`; with no vault it is a
per-user folder (`${XDG_DATA_HOME:-~/.local/share}/open-second-brain/store`
on Linux and macOS). Any other root inside the vault is refused: the
reserved folder is the one place the walkers, search and the view writer
are built to skip. It is never inside `Brain/` or the vault's device-local
`.open-second-brain/` folder. A machine whose store still sits at the
per-user folder because release 2.0.0 put it there keeps using it until a
person runs `o2b store move-into-vault` on it with its agent sessions
closed (see [The store moves into the vault](#the-store-moves-into-the-vault)). The machine config is
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
the first render creates the folder. With no `view_target`, a machine whose
config names a vault shows that vault's `brain-view/` folder with the origin
`default`; it reads `none` when there is no vault either, or when
`view_target` is `none`. It creates nothing, so it is safe to run at
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

### Leaving a partition

A machine that held a partition refuses every store command once that
partition's `store.json` is gone: the held partitions are sticky, and the
refusal names the two remedies. To take the partition off on purpose,
stop syncing its folder, remove the folder, and run
`o2b store partition leave <partition>`; it clears this machine's held
marker for the partition, its seen-shard entries and the digest caches,
and the search index drops its records on its next catch-up. It refuses
`shared` (leaving it is leaving the store), and it refuses, changing
nothing, while `shared/store.json` is missing or unreadable, so restore
that file first. It also refuses while the partition's `store.json` is
still present, and it refuses while the folder still holds files, unless
`--force` is given; the files then stay on disk and this machine ignores
them. A `store.json` that returns by sync or a restore makes
the machine hold the partition again.

## Syncing

Open Second Brain never syncs anything itself. Use any file sync tool:
Syncthing, a cloud drive folder, or similar.

### The default: the store travels with the vault

With a vault and no `store_root`, there is nothing to set up: the store is
the vault's hidden folder `.open-second-brain-store/`, and whatever syncs
the vault carries it. A second machine that receives the vault finds the
store in it and joins it by itself, at its next start, with no setting.

- **The sync tool must carry hidden folders.** Syncthing and most cloud
  drive folders do by default. Obsidian Sync skips folders whose name
  starts with a dot, so with Obsidian Sync alone the store never reaches
  the other machines; add a second sync for the vault folder, or move the
  store to a folder another tool syncs on every machine
  ([Moving the store out of the vault folder](#moving-the-store-out-of-the-vault-folder)).
- **Both partitions travel with the vault.** Every machine that receives
  the vault receives `private/` too, as it received the legacy `Brain/`
  tree with its private pages before the store existed. Setting
  `store_root` on a machine changes only where Open Second Brain looks:
  the vault's sync still delivers `.open-second-brain-store/private/` to
  it. A machine that must not hold private records needs that folder kept
  out of its sync before it first receives the vault: add it to the sync
  tool's ignore list on that machine (Syncthing: the line
  `/.open-second-brain-store/private` in that machine's `.stignore`), or
  keep the whole `.open-second-brain-store/` out of its sync and give it a
  `store_root` that receives only `shared/` (below). If `private/` has
  arrived there already, exclude it first, then delete that machine's copy
  of the folder, and run `o2b store partition leave private` if the
  machine has opened the store since
  ([Leaving a partition](#leaving-a-partition)).
- **Phones** receive the folder with the vault and ignore it: Obsidian
  does not show hidden folders, and no note tool reads it.
- **Never sync the device-local state directory.** Locks, clocks, the
  search index, backups and run state live outside the vault and never in
  the store folder.

When a machine waits for a store another machine created and it does not
arrive, the machine says so plainly, once a day at session start and every
time in `o2b status`, `second_brain_status` and `o2b brain doctor`: which
device it waits for, and what to check (that device runs 2.0.1 or later;
if it switched on 2.0.0, that someone ran `o2b store move-into-vault` on
it with its agent sessions closed; that it is online and the sync ran;
and that the sync tool carries hidden folders).

### A store root you choose

Set `store_root` (or `OPEN_SECOND_BRAIN_STORE_ROOT`) when the store must not
travel with the vault: a server that must hold only `shared/`, a vault
synced by a tool that drops hidden folders, or no vault at all. Then:

- **Sync `shared/` and `private/` as two separate folders.** That lets you
  give each machine exactly the partitions it should hold.
- **Never sync a root you chose as a whole.** It would sync both partitions
  as one unit, and a machine could no longer leave `private/` out.
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

### Moving the store out of the vault folder

A machine whose store is in the vault's `.open-second-brain-store/` folder
keeps it there until you move it. Setting `store_root` first does not move
it: the machine then looks at an empty folder, and the next `o2b init` or
session start there makes a new store with another id. So move it, in this
order:

1. On the machine that holds the store, close every agent session
   (Claude Code, Codex, Hermes, OpenClaw and any other client that runs
   Open Second Brain), wait for running `o2b` commands to finish, and note
   the store id `o2b store path` prints.
2. Copy `<vault>/.open-second-brain-store/shared` and
   `<vault>/.open-second-brain-store/private` into the new root, for
   example `~/brain-store/shared` and `~/brain-store/private`.
3. Set `store_root: ~/brain-store` in that machine's config and run
   `o2b store path`. It must print the same store id, with the partitions
   held as before. If it does not, remove the setting, check the copy, and
   start no session until it does.
4. Point the other sync tool at `~/brain-store/shared` and
   `~/brain-store/private` (only `shared/` for a machine that must not hold
   private records).
5. On every other machine, wait until those folders have arrived at its
   own store root, then set `store_root` there and check that
   `o2b store path` prints the same store id before any session starts. A
   machine that holds records of this store in its own vault folder (its
   `o2b store path` names that folder with the same store id) first copies
   into its new root, from its vault folder, the files the new root does
   not have yet: every device writes only its own files, so nothing is
   overwritten.
6. Once every machine prints the same store id from its store root, delete
   the vault's `.open-second-brain-store/` folder: nothing reads it any
   more, and a later sync would only spread an old copy.

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
| `decisions.md` | Decisions that were recorded, each as its title with the option chosen (an event that carries no title is named by the title of its decision page, a shared one; the choice alone when there is none) |
| `topics/<date>-<slug>/topic.md` | One page per shared topic: status, goal, milestones, decisions, open questions, log and related, with an `archive.md` beside it for older entries |
| `reports/<entry>.md` | One page per research report |
| `sources/<entry>.md` | One page per ingested source summary |

Topics have their own guide: [topics.md](topics.md).

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

With no `view_target`, a machine whose machine config names a vault
(`vault`) writes the view into that vault's `brain-view/` folder, so the
pages appear where you already look, beside your notes. Set `view_target`
to another folder to move it, or to `none` (or `off`) to write no page
anywhere; the brain works the same without a view. The default folder is
never `Brain/`: that name stays the legacy tree's while machines on 1.x
still write it.

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

### The dream owner

Exactly one device runs live dream passes on the brain: the **dream
owner**, one agent installation on one device. The installation that
creates the brain (`o2b init`, `o2b store init`) becomes the owner when
its agent name is known; with no agent name the brain has no owner and
the command prints how to choose one. Attaching another device, running
init again, the migration and starting another agent's plugin never
change the owner. Ask who it is on any machine:

```bash
o2b dream owner
```

The answer names the owner's device and agent, whether this machine is
the owner, the revision and a transfer in progress. To move the role,
run `o2b dream owner --here` on the machine that should own dream: on
the owner's machine `--agent <name>` changes the agent at once; on
another machine it records a request, and the owner's machine hands the
role over the next time it looks (a dream pass, `o2b dream owner`, or a
session start). `--here --force` takes the role at once when the old
owner is lost; that machine may keep running passes until its first
catch-up after the forced claim reaches it. `--release` gives the role
up. Agents use the MCP tool `brain_dream_owner` (`status`, and `take`
and `release` at local reach).

On every other machine a live `o2b brain dream`, its staged lifecycle,
`brain_dream` and the maintenance lane's dream task are refused with
`dream_not_owner` before anything is asked or written (the lane skips
its dream task and runs the rest); dry runs answer everywhere. A machine
that took the role by its own claim runs its first live pass from the
look after the one that first saw it, so a rival claim still in transit
has a chance to arrive.

A brain from before the dream owner has no owner record and works as
before (a live pass from any machine) until you adopt it with
`o2b dream owner --here` on the machine that should own dream; a
declared `primary_agent` is shown as the requested owner. Run a release
with the dream owner on every machine of the brain before you rely on
the role: an older binary does not know the gate.

### The dream work queue

Some dream work needs a model: the seven closed questions of dream, the
summary a fired rollup rung asks for, and the title and goal of a new
topic. A live pass on the dream owner's machine records that work as
an item in the store's `dream-work` stream instead of dropping it, so it
survives a crash, a restart and an owner transfer. An item built from
private records stays in the `private` partition with everything later
written about it; a machine without that partition sees none of it.

```bash
o2b dream queue
```

lists the items by state (waiting, leased, accepted, parked, finished,
closed), how long the oldest ready item has waited and every parked
item with its reason; `o2b dream owner` and doctor show the same
counts. Work on one chain waits behind a stuck item, unrelated work
does not.

Waiting means exactly that: the item is kept, it is never decided by a
fixed rule in place of an answer, and no surface counts it as done; the
pass summary reports it under `model_work`. The decision model chain and
the dream agent answer items on the owner's machine before a live pass,
and doctor says when neither can answer an operation
(`dream-queue-no-executor`); who answers what is in
[dream.md](dream.md#who-answers). An item that fails its checks five times is
parked and named by doctor; `o2b dream queue retry <id>` offers it
again and `o2b dream queue cancel <id> --reason <text>` closes it, both
on the owner's machine. A brain with no dream owner, and one whose
records still live in the legacy tree, has no queue.

### The dream replay

The dream pass works in windows of one UTC day and keeps what it
covered in the store's `dream-replay` stream (`shared` partition), so
another machine that becomes the dream owner continues where the last
one stopped. A plan or an admission that names what a window read from
private records goes to the `private` partition, as every other record
derived from private content does; the coverage stays in `shared`. Per window it records the input boundary it admitted (a
position per `events` and `log` shard), its plan with every effect
frozen, and its coverage; the cross-topic allowance and the rollup
baselines live there too, as records, instead of in files on one
machine. A release of the owner role names the last window its machine
covered, and the machine it goes to runs no window until that window
and the shards it read have synced (`o2b dream owner` says it waits for
sync). A machine that holds `private` also waits for the private part
of every admission it holds. A forced takeover continues from the newest coverage it holds and
says that the previous owner's last windows may not have arrived; when
they do, the highest covered day counts and each effect counts once. A
pass whose clock reads a day earlier than a window already admitted or
covered evaluates nothing and says so (`dream-replay-clock-behind`)
until the clock reaches that day.

```bash
o2b dream owner
```

shows, beside the owner and the queue, the replay: the sources the last
admission read and any it could not read completely, the last covered
window and how many are behind, and the windows whose model work still
waits. Doctor names a source that stops the replay (`dream-replay-gap`),
a replaced shard (`dream-replay-rebased`) and windows behind; when the
replay's own records cannot be read completely here, the status and
doctor say its windows are unknown, and the staged flow is refused. A brain
whose records still live in the legacy tree runs its single pass as
before and is never shown as covered; its first live pass after the move
to the store is the inventory that starts the replay.

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
it into the store. After an update, Open Second Brain runs that migration
on its own (see [Automatic migration](#automatic-migration)); you can also
run it by hand, step by step, as described below.

Every machine migrates on its own, one after the other. The commands below
assume the machine config already names the vault (it does on any existing
install). Without `store_root` the store is created in the vault's
`.open-second-brain-store/` folder and reaches the other machines with the
vault; with `store_root` set as in [Setup](#setup) it is created there.

### Automatic migration

Every session start (the SessionStart hook) and every start of the MCP
server checks whether this machine still has a legacy brain to move. When
it has, and the machine has not opted out, the start hands the work to a
background worker (`o2b brain migrate-store --auto`) and goes on at once:
the check is a cheap read, and nothing in the hook or the server waits for
the worker. One worker runs per vault per machine; a second agent starting
at the same moment finds it running and starts nothing.

The worker runs under the same Bun that runs the session start or the
server, named by its absolute path, so a start whose `PATH` holds no Bun
(an ssh session, an agent started from the macOS desktop) still starts it;
only a process that does not run under Bun (the OpenClaw bundle under Node)
falls back to the `scripts/o2b` launcher, which looks Bun up on `PATH`
and in `~/.bun/bin`. The worker is detached on every platform: it leads a
session of its own on Linux and macOS and is not ended with its parent on
Windows, so it outlives the hook process and the terminal that started it.
Its log goes to a small device-local file beside its state
(`<state dir>/open-second-brain/stores/auto-migration/<vault key>.worker.log`:
one timed line when it starts, one per step of the migration (each new
step at once, the import's counts at most every 30 seconds), its outcome
with how long it took, and any error output;
replaced at every start of a worker, and cut to its newest 16 KiB of
whole lines whenever it passes 64 KiB within one run). When this checkout
lost its dependency tree while the start was running (a marketplace
replacement that removed `node_modules`), the worker starts through a
small bootstrap entry that first runs `bun install --frozen-lockfile` in
the checkout with the same Bun, as the launcher would; the rule is the
launcher's own (the probe file its precheck reads, and
`O2B_SKIP_DEP_BOOTSTRAP`). A worker that cannot be started, or
that exits before it confirms the claim the start handed it, is recorded
as a failed attempt with the reason (the error of the start, or the
worker's exit, the end of its error output and the log's path), by the
start that spawned it when that process still runs, or else by the next
start, which then starts nothing until the cooldown below has run out.
Status, doctor and the session start notice name it, with
`o2b brain migrate-store` to run it by hand, already before a start
recorded it.

The worker:

1. brings the brain's managed files up to date first, as a normal start
   would (skipped while an interrupted migration still holds the gate);
2. runs the dry run, and stops on an entry with no destination or an
   item it cannot parse, before the migration creates anything (the
   managed files of step 1 may already be up to date): it names them and
   `o2b brain migrate-store --dry-run`, and you decide (fix them, or run
   the migration by hand, which keeps unparseable items in its backup);
3. checks, still before creating anything, that the machine has a device
   id, that the store (if there is one) can be read and holds `shared`,
   that there is room on disk, and that no migration of another vault
   holds this machine's gate (a stopped one is named with the command that
   resumes it from that vault, `o2b brain migrate-store --vault <that
   vault> --resume`); a store that cannot be read right now is a wait, not
   a failure;
4. when no store exists yet, looks for a sign that another device already
   started migrating this vault (its `store-migration` snapshot event in
   the synced Brain log): it then waits for that device's store to arrive
   by sync instead of creating a second one; otherwise it creates the
   store at the configured `store_root` or, by default, in the vault's
   `.open-second-brain-store/` folder, as `o2b store init` does; any other
   root inside the vault is refused. A store created in the vault folder
   takes its id from the vault's synced identity marker
   (`Brain/vault-id.json`), so two machines that create it at once, and
   both hold the marker, create the same store. A vault with no marker
   yet has one minted first, from the oldest legacy log line, and the
   store id derived from it; that marker is kept for good. Two machines
   with no marker agree only when both hold the same oldest log shard: a
   machine still missing an older shard than the other has mints another
   marker and creates another store, and a marker that arrives later does
   not change a store that exists. So let one machine migrate and sync
   its store (and marker) before you start the next. The look is
   bounded: at most 32 other devices (by the date of their newest log
   shard, newest first), per device only its newest two log shards, and
   of each only the last 256 KiB, because a migrating device's snapshot event is
   the last line it writes to the legacy log. A device that went on
   writing legacy log lines on later days (its migration did not switch
   it, or you rolled it back) no longer counts. A line the 256 KiB window
   starts inside is read back to its start, so a snapshot event there is
   seen. When the log folder or a shard the look reads cannot be read
   right now (or comes back shorter than it was, because sync replaced
   it), when a line starts too far before the window to be read whole, or
   when a shard ends in a line sync is still writing, the worker cannot
   tell whether another device started, so it waits and looks again at the
   next start instead of creating a store. When another device has
   started migrating and its store has not arrived, the answer is
   remembered: the next starts start no worker and read no log shard
   until the store arrives or a day has passed. The session start (once a
   day), status and doctor say plainly what it waits for and what to
   check: that the other device runs 2.0.1 or later; if it switched on
   2.0.0, that someone ran `o2b store move-into-vault` on it with its
   agent sessions closed (nothing moves that store by itself); that it is
   online and the vault's sync has run; and that the sync tool carries
   the hidden `.open-second-brain-store/` folder.
   This machine needs no setting: it joins the store as soon as it
   arrives;
5. runs the same migration as `o2b brain migrate-store`, resuming an
   interrupted one instead of starting again;
6. on a later machine whose first machine's migration has not arrived by
   sync yet, records that it waits and tries again at the next start.

Each attempt records itself before it starts, with the cooldown a failure
would start. A failed attempt replaces that record with its reason and
leaves the machine working on the legacy layout exactly as before, with
the migration gate open. The next automatic attempt waits one hour,
doubling with each failure in a row up to a day. An attempt that is killed,
or that cannot even write its failure (a full disk), leaves its first
record, so the next starts do not each start a worker; a worker killed
while it held the migration gate (content writes refused) is resumed by
the next start at once. A worker killed after it took the gate and before
it saved its run state leaves a gate no run state names; the gate's run id
says it is a migration's, so the next start goes on at once there too
(with the automatic migration off it only opens that gate: the run changed
nothing). Whatever comes next and cannot resume that run
(its dry run now refuses because an unmapped or unparseable item appeared
since, a preflight refuses, a manual `o2b brain migrate-store` that is
told to use `--resume`) opens the gate the killed run left instead of
leaving it closed, so the machine is writable on the legacy layout again
and the run waits, `in-progress`, for a later resume. When the gate cannot
be opened then (its lock busy, a removal Windows refuses), the attempt's
record keeps the gate owed, and every next start opens it at once,
whatever the setting and the cooldown say, until the gate is gone; then
the record is the failure it stands for, with its cooldown. The same holds
for every migration run's gate of this vault whose run is gone: the next
start opens it (or resumes the run, when the attempt may go on) whatever
the setting, the cooldown and what is left to migrate, also when the
attempt recorded its refusal and was killed before it opened the gate,
when sync removed the last legacy item meanwhile, and when the run was a
manual one on a machine with the automatic migration off (the run stays
`in-progress` for `o2b brain migrate-store --resume`). While this
machine's run state cannot be read, no automatic attempt migrates (the run
could be one you rolled back): it opens such a gate and waits until the
state can be read. When a gate's process is still alive a day after it
took the gate, a start (which reads no process identity) starts a worker
that checks the holder's start identity: it recovers the gate only from a
process that reuses the pid, and leaves it closed while the holder runs or
cannot be told (`--force-release-gate` is then yours to run). A gate
an interrupted rollback or legacy tree removal of this vault left is not
the automatic migration's: it refuses and names that command
(`o2b brain migrate-store --rollback`, or `--remove-legacy`). A live
migration of another vault holds no write to this one back, so this
vault's managed files are still brought up to date meanwhile. Doctor shows
the failure as a warning with the reason and the command to run by hand,
and the session start carries one short line about it. A gate a stopped
migration run left closed is a sentence of its own, apart from the
failure, since that run may be a later manual one: a migration run of this
vault, automatic or manual, stopped with its gate closed, and what the
next start does about it.

When a run stops after it recorded this machine's switch (killed, or a
later step failed), the next start finishes it: it binds the vault that run
migrated (a vault configured since is left unbound, its import is the
manual command's), claims the view writer, opens the gate and writes the
success records below. A switch that finished and was stopped before it
opened its gate has that gate opened by the next start; no switch is
finished across an interrupted rollback or legacy tree removal. Each of those records (the log line, the metrics
row, the notice) is written once: a pass that stops among them, or finds
one it cannot write, leaves the rest to the next start, and a notice a
session already showed is not shown again (two sessions that start at
once show it once: the one that consumes the notice file shows it). They are written only once the
switch is proven finished, that is, this machine's run state reads back as
done: while it cannot be read, or the read right after a start finished
the switch fails, nothing is announced, the attempt stays pending, and the
next start that reads it publishes the records once. If another vault's
migration switches this machine while an automatic attempt is starting,
the attempt imports nothing of its own vault: that vault's import is the
manual command's, as for any vault configured after the switch. A run
opens only the migration gate it took: a second process resuming the same
run and refused at the gate leaves the running one's gate closed. An item that cannot be parsed
and appears after the dry run makes the automatic migration refuse before
the switch, as the dry run would; the manual command keeps such items in
its backup archive.
Finishing what an automatic attempt already started (that switch, or a run
killed while it held the migration gate) is not a new migration and asks
no consent, so it happens whatever `auto_store_migration` says; the
setting only decides whether a migration starts. A machine you rolled back
with `--rollback` is never migrated again on its own, whatever the
setting: doctor and status say it was rolled back (`rolled_back`), and
`o2b brain migrate-store` migrates it again when you want the brain store
back.

After a successful migration the brain log gets one line (it names the
run, the device and the snapshot, never a local path, because it lands in
the store's `shared` partition), the `auto_store_migration` metrics surface
one row, and the next session start shows once that the brain moved, where
the snapshot taken before the move is, and how to undo it:
`o2b brain migrate-store --rollback` (see
[Rolling back a machine](#5-rolling-back-a-machine)).

Right after the switch the same worker asks for the removal of the legacy
tree and renders the human view. When every device of the migration
cohort has switched or is retired (on a brain only this machine used, that
is at once), the tree leaves the vault in the same run, through the same
removal as `o2b brain migrate-store --remove-legacy`; the session line then
says the brain moved and the tree left, without the rollback advice, since
a rollback is no longer possible. While another device still writes the
legacy layout the tree stays; see
[Removing the legacy tree](#6-removing-the-legacy-tree) for what happens
next.

The worker lock, the failure or waiting record and the one-time notice
live in this machine's device-local state
(`<state dir>/open-second-brain/stores/auto-migration/<vault key>/`),
never in the vault and never synced; they stay in the same place when the
machine switches or rolls back. The lock is held for as long as its worker
runs and is taken over as soon as that process is gone; every spelling of
the vault's path (a link, another drive-letter case) shares it. A start
never takes over the claim of a process that is alive: a day after the
claim it starts a worker that checks the holder's start identity and takes
the claim over only from a process that reuses the pid (or, when the
holder's identity cannot be told, from a claim older than an hour), and a
worker whose
claim was taken over writes nothing more: every write it makes outside the
migration gate (its records, the notice, the metrics row, the log line, a
new store) is made only while it still holds its claim, and the migration
itself is serialised by the gate: the vault identity marker is read, or
written when missing, only once a run holds the gate, so the id a
migration records is the one the vault carries. Before it holds a claim a worker writes
nothing at all. A session start never waits for another process making or
judging a claim, and it
never runs a subprocess to check on a worker or a migration: it goes by the
recorded process id and the age of the claim, and leaves the exact check
of the process (PowerShell on Windows, `ps` on macOS) to the worker and to
`o2b brain migrate-store`. A gate file that cannot be read starts no
worker either, and a worker lock file that cannot be read (a permission
or an I/O error) is never taken over: `o2b brain migrate-store` reports
the automatic migration as running until it can be read. Failure texts are
kept and shown with control characters replaced and home directories
reduced to `~`.

`o2b update` ends with the same check and runs the migration in the
foreground, with progress on stderr, and names the outcome in its output
(the `store_migration` field of `--json`). A failed migration does not
make the update fail. `o2b update --skip-store-migration` skips it once.
`o2b update --dry-run` runs nothing and says what the update would do:
pending when it would migrate, finish a switch or open a stopped run's
gate, refused (with the reason and the command that finishes it) when an
interrupted rollback or legacy tree removal holds the gate, and not needed
only when there is nothing to do.
`o2b brain upgrade --dry-run` says whether a migration is pending and what
the next start will do about it, and the `migration.automatic` field of
`o2b status --json` and doctor report the state: not needed, pending,
running, waiting for another device, failed, done, or rolled back. All of
these, and the session start line, restate the one decision the worker
takes, so they never disagree with what the next start does. While a
migration runs they also say how far its import is: how many legacy items
it has imported so far of about how many its dry run planned (`progress`,
with `journaled` and `planned`, under `--json`), read from a small file
the run rewrites after every batch it writes. The import writes items in
batches, so a vault of several hundred thousand items migrates in minutes.

To keep a machine from migrating on its own, set
`auto_store_migration: false` in its machine config (consent is per
machine, so the key never lives in the store or the vault). The setting is
on only for `true`, `1`, `yes` or `on`, and off for `false`, `0`, `no` or
`off`, in any case, with surrounding space and a trailing ` # comment`
ignored. Any other value, a key with no value, or a machine config that
cannot be read turns the automatic migration off, and doctor and
`o2b status --json` name the value they did not recognise. The environment
variable `OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION` (CI, tests) takes the same
values; off wins, so the variable can turn the migration off for one
process but can never turn it on over a config that says off. With it off,
status, doctor, `o2b update` and `o2b brain upgrade --dry-run` still say a
migration is available, and no migration starts until you run it by hand;
an automatic attempt that had already started is still finished (see
above). A
manual `o2b brain migrate-store` refuses while the automatic worker of
this vault is running (not when its worker is gone); the dry run is always
available.

#### When a person has to step in

The automatic migration recovers what a killed or failed attempt leaves
on its own. These states wait for you, each with where it is reported
and the command that clears it:

1. An interrupted rollback or legacy tree removal of this vault holds the
   migration gate. Status, doctor, the session notice and
   `o2b update --dry-run` name it; run `o2b brain migrate-store --rollback`
   or `--remove-legacy` to finish it.
2. Another vault's stopped migration, rollback or legacy tree removal
   holds this machine's gate. The same surfaces name that vault and the
   command that finishes its run there
   (`o2b brain migrate-store --vault <that vault>` with `--resume`,
   `--rollback` or `--remove-legacy`).
3. A rollback of this vault began and did not finish: it was killed, or a
   step failed before or after it cleared this device's switch (a full
   disk, a Windows sharing violation). Its record stays in the device-local
   migration folder, and no start migrates the vault again over it,
   whatever the setting. Status, doctor, `o2b update --dry-run` and, on
   the legacy layout, the session notice name it; run
   `o2b brain migrate-store --rollback` to finish it. When that record cannot be read, the same surfaces say
   so; make it readable, then run the same command. Running
   `o2b brain migrate-store` instead also ends that rollback, unless the
   rollback still holds the gate (item 1): where the rollback had cleared
   the switch, it migrates the vault again, as you ask; where the machine
   is still switched, it keeps the machine on the store. On a switched
   machine the surfaces name both commands.
4. A gate whose holder is still alive a day later and whose start identity
   cannot be read: status reports a running migration. Once you know the
   run is gone, run `o2b brain migrate-store --force-release-gate`.
5. A switched machine whose run state reads none or failed: status reports
   the switch as pending and names `o2b brain migrate-store`, which ends
   the attempt's record.
6. Legacy items with no destination or that cannot be parsed: status and
   doctor report the refusal with `o2b brain migrate-store --dry-run`; fix
   the items, or run the migration by hand, which keeps unparseable items
   in its backup archive. A sync tool's conflict copy of a legacy file and
   its in-flight temp file are never such items (see "Sync conflict
   copies" below); a conflict copy of a file no mapping covers is unknown
   like that file.
7. This machine's migration run state cannot be read: status reports a
   wait; fix the file's permissions or restore it.
8. The vault binding cannot be read: status names `o2b init --vault`.
9. A vault configured after the switch whose deny rules differ from the
   store's: it stays unbound, and doctor names the file
   (`permissions-legacy-only`) until you reconcile the two policies.
10. A device of the migration cohort still writes the legacy layout: the
    tree stays, and the session start says once a day which device to
    update (see [Removing the legacy tree](#6-removing-the-legacy-tree)).
    Once every device switched or is retired, doctor reports
    `legacy-tree-can-leave` and the `migration.cohort` block of the status
    says `can_leave`; the tree then leaves at the next session start, or at
    once with `o2b brain migrate-store --remove-legacy`. With
    `auto_legacy_removal: false` (or `auto_store_migration: false`) nothing
    is removed until you run that command.
11. A device retired by silence writes the legacy layout after the
    removal: doctor reports `legacy-tree-reappeared` and names it. Update
    Open Second Brain on that machine, then run the removal again.

A rollback that finished every step but could not open its gate (another
process held the gate lock past its wait) needs no one either: the next
start opens the gate, whatever the setting, and migrates nothing. Until
then status and doctor say so and name
`o2b brain migrate-store --force-release-gate`, which opens it at once; do
not answer it with `--resume`, which would migrate the vault again.

A gate whose pid was reused by another process within a day of a stopped
run needs no one: the next start leaves it for up to a day (it reads only
the pid), then its worker opens it; `o2b brain migrate-store` opens it at
once.

### The store moves into the vault

Release 2.0.0 created the store at the per-user folder outside the vault,
which nothing synced, so a second machine waited for a store that never
came. Since 2.0.1 such a machine, with a vault and no `store_root`, keeps
using that folder until a person moves it with one command, run on that
machine with its agent sessions closed: `o2b store move-into-vault`
(`o2b store move-into-vault --dry-run` prints the plan and writes nothing).

Nothing moves it by itself: a move that races running agent sessions,
processes of the old release and the sync tool cannot be made safe at a
session start. Until it moves, the session start says once a day that the
store is outside the vault and that no other machine can receive it, and
`o2b status`, `second_brain_status` and `o2b brain doctor`
(`store-outside-vault`) say it every time, with the command.

The command refuses, and changes nothing, unless the store sits at the
default per-user folder and a vault is configured: a `store_root` you set
is yours and is never moved. Then:

1. it takes a device-local relocation lock; a second run is refused, not
   queued, and every write to the store on this machine that starts from
   here on does not write while the lock is held;
2. it refuses, without waiting, while anything writes the store: an
   append that holds a shard lock, a dream pass, the automatic migration
   or the automatic legacy removal. It names each and asks you to close
   every agent session and wait for running `o2b` commands. An idle MCP
   server holds nothing it could see, which is why you close the
   sessions; a write it makes after the move goes to the vault folder
   (this release) or is carried over (an older release, below);
3. it copies every file of every partition into the vault folder. A
   partition the folder lacks is copied into a hidden staging folder and
   renamed into place whole. A partition already there with this store's
   identity (an earlier run cut short) is completed file by file: a file
   that holds the copy as a prefix is kept, one that is a prefix of it is
   replaced only while it is still the file that was compared, and two
   copies that diverged stop the move;
4. it compares every byte of the copy with the original;
5. it binds this machine to the new root (the same store id and device
   id; record ids do not change, the bytes are the same bytes);
6. it compares the copy once more, then writes `relocated.json` into the
   old folder. From then on the old folder is an inactive recovery copy
   that nothing of this release writes again; a process started before
   the move that still holds the old folder writes into the vault folder
   instead.

It prints how long the move took and where the recovery copy is. Nothing
removes the recovery copy; delete that folder by hand, and only once:

- every agent session that ran before the move has ended, so no process of
  the older release still writes the old folder;
- `o2b store move-into-vault --carry` says nothing waits in the old folder
  (lines an older process appended after the move exist only there until
  they are carried; keep the copy while a carry leaves files waiting, for
  example while the vault folder lacks a partition);
- the vault store has reached your other machines.

A crash at any step leaves the old folder in use; run the command again.
Lines that a process of the older release (an MCP server that had not
restarted yet) appended to the old folder after the move stay there until
the command runs again: the session start says so (and doctor, as
`store-late-writes`), and `o2b store move-into-vault`, or
`o2b store move-into-vault --carry`, carries them into the vault folder
once. A carry writes only while the vault folder's partition still holds
this store; one a sync took away receives nothing, and the lines wait for
the next run. When the vault folder already holds a store with another id,
the two are never merged: the command stops, this machine keeps writing
its old folder, and the session start, status and doctor name both and ask
you to decide which one to keep.

A machine that waits for such a store says which device it waits for and
that, on that device, `o2b store move-into-vault` must run.

The removal of the legacy tree waits while another device of the cohort is
known to have switched but its records have not arrived on this machine:
its migration mark is in the synced Brain log and its switch record is not
in this store, or the first migration's cut has not arrived in full. The
legacy tree is then the only place both machines' records meet. `--force`
goes past it.

### Two machines that start before either sees the other

The wait in step 4 needs the other device's Brain log shard to have
synced. When two machines that share a vault, and have no store yet, both
start their first automatic migration before either one's log shard has
reached the other, each creates the store in its copy of the vault folder.
The store id comes from the vault's synced identity, so both create the
same store, and sync brings their shards together as one store with no
refusal. Each machine imported the legacy tree as a first machine, so the
store then holds two imported copies of the legacy records, one per
device: signals, preferences and settings still fold to one each, but the
imported Brain log lines and ledger rows (metrics, continuity, history)
appear twice. To stay out of that
window, update one machine first and let its migration finish and sync
before you update the others. A vault with no identity marker (made by a
release before the marker existed) has one minted from its oldest legacy
log line, so the two agree only when both hold the same oldest log shard;
when one lacks it, they create two stores, which refuse to open together,
naming both; that needs your hand.

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
of `Brain/` (or report it) and run the dry run again. Its "Sync conflict
copies" section says what the sync tool's leftovers in the legacy tree
would become; they never stop the run. Nor do the files Open Second Brain itself keeps
beside a legacy file: the search index's parked previous index (`.bak`,
`.old`), its `.new` staging and a restore's staged index, each with its
SQLite journals, and a running rebuild's progress file (`.building.json`) with the claims of the searches reading its staging file (`.building.reader-*`), go by the index's rule (rebuilt on this machine: never
read, imported or archived), and a writer's temp file or lock goes with
the file it belongs to. The search freshen claim (`freshen.claim`, which a
start whose process died can leave behind) and its pending marker go with
the freshen state: never carried over.

#### Sync conflict copies

A vault that a sync tool keeps in step between machines collects that
tool's conflict copies (Syncthing
`<name>.sync-conflict-<date>-<time>-<device>.<ext>`, the Dropbox and
Nextcloud `<name> (... conflicted copy <date> ...).<ext>`) and its
in-flight temp files (`.syncthing.<name>.tmp`, `~syncthing~<name>.tmp`,
the Nextcloud `.<name>.~<hex>`). The migration treats them as versions of
the file the copy is named after, never as unknown files:

- A copy of a JSONL ledger or log shard: its rows are imported like the
  original's. A row the original already holds is stored once; a row only
  the copy holds is imported under the copy's own path and line, exactly
  once while the copy file is unchanged: a resumed run, a later machine
  with the same copy, the transition import and a rollback do not import
  it again. A row a person later moves into the original, or a copy
  rewritten with its rows at other lines, is a new row and is imported as
  one, so the store can then hold that event twice.
- A copy of a signal page, a preference page or a lane entry: a copy equal
  to its original adds nothing. A copy that differs is another version of
  the same record, not a second record: it is kept in the migration
  backup, not imported, and named in the report.
- A copy of a single document (the pinned context, the settings file):
  the original is imported; a copy that differs is kept in the backup and
  named, never merged.
- A copy of device-local, derived or dropped state (the freshen state, a
  lock, a cache, a log day page): it goes with its original's rule and is
  not carried over.
- A temp file holds no data of its own: it is ignored and counted. When it
  becomes the real file before the run ends, the next pass imports that
  file.

The dry run and the migration report (text and `--json` `sync_copies`)
list, per surface, the copy rows or files imported as records, those
identical to their original, those kept and not imported (each with the
file it is a version of), those dropped with their original, and the temp
files ignored. The kept copies are in
`<migration folder>/backup/sync-conflict-copies/`, listed in
`backup/sync-conflict-copies.json`; after the switch doctor names them once
as advice (`sync-conflict-copies-kept`). Look at them, copy what you want
into the brain, and delete the list to end the advice. A copy that
arrives after the switch is imported by the transition import, and the
legacy tree's removal moves every copy and temp file to its archive with
the tree. The migration cohort is built from the original files only: a
device known only from a conflict copy's name is not a device the removal
waits for.

### 2. Migrate the first machine

<!-- doc-test: scenario=migration machine=laptop exit=0 expect="device-switched" -->
```sh
o2b brain migrate-store
```

The migration:

1. closes a migration gate on this machine, so every write into this vault
   made here (agents, the CLI, hooks and background workers; notes and
   Brain log lines, per-vault state and caches included) is refused while
   it runs, with a "migration in progress" message that names the run,
   since when it runs and how far it is (other machines keep working, and
   so do this machine's other vaults); a hook writes nothing and does not
   fail the session;
2. snapshots `Brain/` and backs up every surface nothing can rebuild
   (secrets, keys, attestations, checkpoints) into the device-local state,
   each verified by a test restore;
3. imports every item through a journal, in batches, then re-scans until a
   pass imports nothing, and verifies every item against the store; a sync
   tool's conflict copies go where their originals go (see "Sync conflict
   copies"), and each differing version it keeps is named in the report;
4. records `migration-done` and this machine's `device-switched`, and makes
   this machine the view writer if no machine is.

Imported records are written at the migration's moment by this machine,
but topic planning dates them by their legacy items: the time a log event
or a signal carries (else the date in its file name) and the device of
the legacy shard it came from. A history written on several days by one
agent therefore still counts as several sessions and forms topics (see
`docs/topics.md`).

The migration, the import of late legacy writes, the rollback and the
removal read the store one record at a time, so their memory does not
grow with the vault. What they must keep for every item or record (the
journal, the items a pass saw, the store's checksums, the restored tree's
items) moves into a temporary SQLite file under `scratch/` in the
device-local migration folder once it passes 20,000 entries. That file is
scratch only: each run rebuilds it from the journal and the store,
deletes it when it ends, and removes one a killed run left behind. Give
the device-local state disk room for it, about the size of the journal.

The legacy tree stays in the vault. If the run is interrupted,
`o2b brain migrate-store --resume` continues without importing anything
twice. If verification finds a gap, the legacy tree is left untouched and
the report names each missing item. If a run that is gone (a crash, a
closed terminal) still holds the gate, writes stay refused and the refusal
says so: the next start resumes an automatic migration, or run
`o2b brain migrate-store --resume`. The rollback and the removal of the
legacy tree hold the same gate and refuse the same writes. If you will not
resume the run right away, `o2b brain migrate-store --force-release-gate`
opens the gate again; it refuses while the run that holds the gate is
still running.

The search index of a switched machine lives in its device-local state
and is built anew in the background: by the first session start or MCP
server start after the switch, or by the first search when nothing has
started it yet (a search never builds the index of a store in its own
process; a small vault is often built within the few seconds that first
search waits, a larger one answers from what is indexed so far). The
build reads the brain store first and then the vault's notes; until it
ends, a search answers from what it has indexed so far and says so. The
legacy `Brain/` tree is not indexed once the machine has switched: it is
an archive that `--remove-legacy` moves out, and its signals,
preferences and log are indexed as store records, so each answers once.
A record whose entity no reader shows any more (a forgotten signal, a
removed preference or lane entry, an entity marked `_status:
tombstoned` before or after the migration) is never indexed, and a
search refuses one an index still holds. A signal waiting for write
approval is kept out the same way until it is approved. A log event
that references such a record (by its id, its page path or a link to it:
its `feedback` event, its `tombstone` event) is left out of every search
answer too, so a forgotten record's name is not found through the log; a
bare word an event shares with a forgotten page's name hides nothing; the log itself
keeps the event as the audit trail.

To forget one record on a switched machine, tombstone it: `o2b brain
lifecycle tombstone <target> --reason <text>` (or the `brain_lifecycle`
tool), where the target is the record's legacy path, its bare id or
`store:<id>`. The tombstone is a field change of the store record, never
a write to the legacy tree (still on disk or not, and whatever the path's
case, Unicode form or separators, or a link that leads into the tree), and every reader drops
the record at once; `supersede`, `temporal-replace` and `correct` write
the store record the same way. A target the store does not hold is
refused. `o2b brain signal retire` is not a way to forget: a retired
signal leaves the dream pass and stays searchable as history.

From now on this machine writes only to the store. Doctor reads the store
too: while the legacy tree is still in the vault it does not walk or judge
it (its log, its pages and its lanes are an archive the store already
holds), and says only what `--remove-legacy` needs said about it (the
cohort devices, a tree that came back, a failed or available migration),
beside the store's own checks and the vault-side ones that still matter
here (a frozen vault, secrets the sync exposes, state git tracks, a link
that leaves the vault, the deny rules, free disk, the managed rules
blocks, the search index's health), so it costs about what it costs once
the tree has left. Render the view
twice (the first render after the claim only catches up), and check doctor:

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
that have not switched yet, and lists every cohort device with its state:
`switched`, `pending` with the date of its last evidence of life, or
`retired by silence` (see "Removing the legacy tree" below).

### 3. Migrate the later machines

On every other machine, first set `auto_store_migration: false` in its
machine config, so the upgrade's automatic migration cannot create a
store of its own before the shared one arrives. Then upgrade, set
`store_root`, let sync deliver `shared/` and `private/`, run the same
commands, and remove the setting (or set it back to `true`). Do not run
`o2b store init` here: the store comes through sync. A machine that
already holds the synced store at its `store_root` before the upgrade
needs no setting: its automatic migration takes the later-machine path.

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

An import reads what changed since the last one, not the whole tree: a
legacy log or ledger file whose size, modification time, change time and
inode are all unchanged is not opened, and a file that only grew is read
from where the last import stopped, once the lines read before check out
unchanged. Any other change (a line edited in the middle, a file replaced
by a shorter one) is read whole, as before. The migration leaves the
first such record, so the first import after the switch is quick too.

A switched machine never writes into the legacy tree. Doctor on every
switched machine names the devices still on the legacy layout
(`legacy-devices-pending`) until each has migrated or been retired, by you
or by silence. The `migration` block of `o2b status --json` carries the
same list as `cohort`, and the report of `o2b brain migrate-store` on a
switched machine names the same devices (`legacy_devices` in `--json`,
each with its last evidence in `pending_evidence`), the devices that
switched and, apart from them, those retired by silence: a device retired
by silence is never named as still on the legacy layout.

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
cohort (every device id found anywhere in the legacy tree) has switched,
been retired by you, or been retired by silence, and no device that
switched is still waiting for its records to arrive on this machine (its
migration mark is in the synced Brain log while its switch record is not in
this store, or the first migration's cut has not arrived in full; a device
retired by silence is no exception, since its store may simply never have
reached this machine). Until then the removal refuses and names the devices
it waits for, each with the date of its last evidence of life:

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

Migrate each named machine that is still in use.

**Retired by silence.** A vault usually carries ids of machines that no
longer exist (a reinstalled laptop, an old phone, a test device). A cohort
device that has not switched counts as retired by silence once its last
evidence of life is older than the shared setting
`migration.silent_device_days` (30 days by default; `0` turns the rule off,
and then the cohort has no age limit). Its last evidence is the newest of:
the dates in the names of its legacy per-device files (`2026-11-01.dev-c.jsonl`
counts as that day, a month file as the month's first day, a week file as
its Monday), the times its rows carry, and the clocks of the records it
wrote to the store. A file name's date is only a floor: the newest row time
of the file dates the device when it is later, whatever the file's naming
scheme. A row time is any top-level time field of the row (`ts`,
`timestamp`, `time`, `at`, or any field ending in `_at` or `At`, such
as the continuity ledger's `createdAt`), except a field that names a time
still to come (an expiry, a retry, a schedule, a reminder, a fire or
start time, a sunset, a wake, a not-before). A field that records when
something was done counts, such as a trigger's `snoozed_at` or a metrics
row's `run_at`. Row times
are read from the end of each shard: its last 64 KiB, or more when its
newest row is longer, so that row always counts. File modification
times never count: the sync tool rewrites them. An id with no
dated trace at all takes the date of the migration's cohort record, so it
is retired one threshold after the migration began.

The age is measured against the newest evidence of any device, this
machine's own records included, that is not later than this machine's
clock. Evidence stamped in the future is left out of that reference rather
than taken as now, so ages stay relative to what this machine has seen. A
machine whose clock runs years ahead therefore counts as alive now and
retires no one; a clock that runs behind retires fewer devices. A clock
set far ahead on this machine changes nothing until this machine writes
under it; after that, nothing tells it from a machine that really outlived
the others, so the report prints the date it measured against (`as of`).
Check that date before you run the removal.

Nothing is recorded: a device retired by silence that writes again is
pending again at once when what it writes carries a date within the
threshold of the reference (a date later than the reference counts as the
reference); a write stamped older than that leaves it retired by silence.
A device whose evidence this machine cannot read whole (a store shard of
it that is a link or special file, cannot be read, holds a rejected line
where its newest clock is, or was seen before and is gone, or a legacy
shard of it that cannot be read) is never retired by silence, and a
device retired by hand whose newest record cannot be read counts as
having written again: it stays pending, and the tree stays until the read
is whole again. `--force` removes the tree past a pending device, but not
past a store shard this machine cannot read at all (a link, a permission
or I/O error): the removal refuses then, even with `--force`, because the
tree may be the only other copy of what that shard holds; fix the shard
(let sync finish, or its permissions) and run the removal again. A shard
read only in part (a record whose blob has not arrived) is the case
`--force` goes past.
The setting is shared by every machine of the store,
and only you set it:

<!-- doc-test: scenario=migration machine=laptop exit=0 expect="migration.silent_device_days" -->
```sh
o2b brain settings set migration.silent_device_days 30
```

A change of the threshold takes effect on a machine once the setting has
synced to it, and the removal report prints the threshold it used.

Retire a machine that is gone for good before its silence counts, from any
other machine (never from the machine itself, which is refused). Retiring
writes one record in the shared settings that takes the machine off the
digest roster (`store-digest-silent` stops naming it) and out of the
devices the removal waits for:

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

Now every cohort device has switched or been retired, so doctor reports
`legacy-tree-can-leave`. A session start removes the tree by itself (see
"The removal without a command" below); here it is run by hand. The removal
goes ahead, and its report names the devices that switched and, apart from
them, each device retired by silence with its last evidence (`switched` and
`retired_by_silence` under `--json`):

<!-- doc-test: scenario=migration machine=laptop exit=0 expect="Everything else was moved into the archive, not deleted" -->
```sh
o2b brain migrate-store --remove-legacy
```

To remove the tree while a machine that is still in use stays on the
legacy layout, `--force` removes it anyway and the report names the
devices that will no longer reach the store; prefer migrating or retiring
them.

The removal first imports any late legacy writes, then moves `Brain/` and
`.open-second-brain/` out of the vault into a dated archive in this
machine's device-local state. The archive leaves out only what a rebuild
recreates (the search index, caches, generated pages): those are deleted,
and the report says how many and how large they are and names the first
few (`skipped`, `skipped_sizes` and `skipped_bytes` under `--json`);
everything else is moved, not deleted. A long list in the report is its
count and its first few entries.

On another machine of the vault the removal reaches it by sync, which
deletes what it carried. What it never carried stays: that machine's own
search index and caches in `.open-second-brain/` (often hundreds of MB).
Doctor names them (`legacy-local-files-left`, with their sizes), and
`o2b brain migrate-store --remove-legacy` run on that machine clears them
the same way (the cohort no longer matters there: the tree is gone). Where
nothing of the tree is left at all (the sync also deleted that folder), the
command says so, lists the cohort as above, moves nothing and exits 0. Afterwards the vault holds your notes, the view folder (`brain-view/` by
default, or wherever `view_target` points), and the managed block of the
vault's `.gitignore` that names `.open-second-brain/` (kept, so a returning
1.x machine's index is never committed). A rollback is no longer
possible:

<!-- doc-test: scenario=migration machine=laptop exit=1 expect="rollback is only possible until then" -->
```sh
o2b brain migrate-store --rollback
```

If a `Brain/` folder appears in the vault again (an agent or tool still
follows old instructions), doctor reports `legacy-tree-reappeared` with the
writer when a file names it. Stop the writer and move the folder out of the
vault.

The `legacy-tree-removed` record names the devices retired by silence when
the tree left, so the doctor on every machine can say why it left. A
machine whose tree had already left by sync, running the removal to clear
its own leftover files, reports and records the verdict of the removal
that moved the tree; its own record says it moved no tree
(`tree_already_left`), so it never replaces that verdict for a later
machine.

#### The removal without a command

After the update nobody has to run `--remove-legacy`. On a switched machine
every session start and every MCP server start checks, with two `stat`s and
a small device-local file, whether a legacy root (`Brain/`, or this
machine's `.open-second-brain/`) is still in the vault. When one is, it
starts one background worker (`o2b brain migrate-store
--auto-remove-legacy`) that runs exactly the removal above, never with
`--force`: every refusal of that command refuses it too (a device still on
the legacy layout, a settings or data shard that cannot be read in full,
items held back for a partition this machine lacks, an interrupted
migration or rollback that holds the gate, a tree that keeps changing). The
automatic migration's own worker asks the same right after it switched the
machine, so a brain that only this machine used loses its tree in the same
update.

- The removal also waits while another device switched and its records
  have not arrived on this machine (its switch record, or the first
  migration's cut, is not in this store yet; see
  [The store moves into the vault](#the-store-moves-into-the-vault)): the
  tree is then the only place both machines' records meet. The daily line
  says which device's records it waits for and that they travel in the
  hidden `.open-second-brain-store/` folder.
- While a device still writes the legacy layout, a start asks again at
  most once an hour, so the tree leaves within the hour after the last
  pending device switched (its switch must have arrived by sync). Machines
  on an old release keep working meanwhile: their writes to the tree are
  imported as they arrive.
- The session start says once a day, in one line, which device the tree
  waits for (its id and the day it was last seen) and that it leaves by
  itself after that device updates, or how to retire the device if it is
  gone for good (`o2b store device retire <device>`). A device id is the
  `device_id` of that machine's config; `o2b store device list` lists them.
- After a refusal the session start names the reason once a day and the
  next attempt waits a day; `o2b brain migrate-store --remove-legacy` runs
  it at once after you fixed the cause.
- When the tree left, the next session start says so once and names the
  archive.
- These lines share one rule with the migration's and the store move's
  lines: a session start shows at most one of them a day on a machine,
  the most important first (that the brain moved, then a failure or a
  store that has not arrived, then the other one-time news, then a wait).
  A line held back is shown on a later day; `o2b status` and doctor show
  every one of them every time.
- The removal touches only `Brain/` and `.open-second-brain/`; the store
  folder `.open-second-brain-store/` and the view folder `brain-view/`
  stay, and neither one's walkers read the other.

The worker's record (`legacy-removal.json`), its lock and its error log
live in this machine's device-local state beside the automatic migration's
(`<state dir>/open-second-brain/stores/auto-migration/<vault key>/`).
Set `auto_legacy_removal: false` in the machine config to keep the tree
until you remove it by hand; `OPEN_SECOND_BRAIN_AUTO_LEGACY_REMOVAL=false`
does the same for one process. Both read their values the way
`auto_store_migration` does (on for `true`, `1`, `yes`, `on`, off for
`false`, `0`, `no`, `off`, anything else off), and
`auto_store_migration: false` turns the automatic removal off too.

#### A device retired by silence that comes back

1. **On an old release** it writes `Brain/` again. Doctor reports
   `legacy-tree-reappeared`, names the device as retired by silence and
   tells you to update Open Second Brain on that machine. Until then the
   switched machines import what it writes there. Once it has updated, its
   migration imports its legacy records as a later machine and records its
   switch; then remove the tree again with
   `o2b brain migrate-store --remove-legacy`.
2. **On the new release, with its own copy of the tree still in place**
   (the sync tool has not removed it yet), its automatic migration runs as
   a later machine and imports every legacy record the store lacks,
   including what it wrote while it was offline.
3. **On the new release, with its tree gone** (the sync tool applied the
   removal), it is store-only: it writes the store and nothing waits for
   it. Its start records no switch for it, because the identity marker
   left with the tree and one store serves every vault of a machine, so a
   vault without its tree looks the same as another vault whose tree has
   not arrived yet, and switching there would leave that vault's legacy
   records unimported. `o2b store device list` shows it on the `legacy`
   layout until you run `o2b init --vault <vault>` on that machine, which
   records its switch.

**What the threshold costs.** In the third case the records that device
wrote into its legacy tree after its last sync, and that never synced
before its copy of the tree was removed, are lost. Everything it synced
before is in the store. A longer `migration.silent_device_days` makes that
window less likely; `0` rules it out and keeps the tree until every device
switched or you retired it.

## Shards read only in part

A shard of a held partition can read only in part: a line in its middle is
not a valid record, a record is of a format this release does not know, or
a record's body blob has not arrived. A record in such a gap may be the one
that makes a page private or sets a setting, so every read that decides a
protection fails closed on this machine until the gap is gone: capture,
settings reads and writes, lane privacy, exact state, attestations, the OKF
export and the migration. A line cut short by a crash and closed by the
device's next append is not a gap.

The doctor names each gap, with the shard as `<partition>/<shard path>` and
the byte offset of the line:

- `store-shard-corrupt-line` (error): a bad line in the middle. Repair it at
  its source when you can; otherwise the finding names the command that
  quarantines it on this machine.
- `store-shard-line-too-long` (error): a bad line in the middle too long
  for a quarantine to name. Repair or remove it at its source; no command
  is named.
- `store-shard-newer-format` (warning): upgrade Open Second Brain on this
  machine, which then reads the record. Such a line is never quarantined:
  it is a valid record.
- `store-shard-blob-pending` (warning, error once the record is seven days
  old): a sync tool may still deliver the blob, so it is quarantined only
  from seven days on, and never in a `settings` shard, whose record may be
  a setting in force: deliver that blob from the machine that wrote it.
  When the record's clock stamp does not parse as a time, its age is
  unknown: the finding is an error that says so, and the record is never
  quarantined by age.

`o2b store shard quarantine <partition>/<shard> --offset <n>` records, in a
ledger kept in this machine's device-local state, the line's offset and the
hash of its bytes. The shard then reads as whole on this machine; the line
stays in the file and no other machine is affected. The entry matches only
those bytes at that offset: a different line written there, or another bad
line of the same shard, is a gap again. The last line of a shard this
machine writes is refused, because its writer may still be appending. A
quarantined record whose blob arrives later reads with its body, with no
step of yours. The rollback, the late import of the transition, the
migration preflight and the legacy removal still refuse while any record
waits for its blob, quarantined or not. While a record in `private` waits
for its blob, quarantined or not, a Brain lane page written or moved on
this machine is kept out of `shared` (refused on a machine without
`private`), since the record may be the one that makes the page private. A
record in `shared` that waits for its blob does not hold lane pages back:
a record there never makes a page private, so a machine that holds only
`shared` goes on writing lane pages after you quarantine its lost blob.
One exception:
`o2b brain migrate-store --remove-legacy --force` goes past a shard read
only in part, a quarantined or pending blob included, as it goes past a
cohort device still on the legacy layout. That risks data loss: a record
in that shard may have the legacy tree as its only readable copy, and the
tree leaves the vault (it is kept in the dated archive described under
"Removing the legacy tree"). A shard that cannot be read at all still
refuses, even with `--force`. Prefer letting the blob arrive or repairing
the line before forcing the removal.

A quarantine cannot name a line longer than the hash cap (sixty-four times
the store line cap, 1 MiB): the verb refuses it as `line-too-long`, so the
doctor reports such a line as `store-shard-line-too-long` (error) and names
no command; repair or remove it at its source, in the shard of the device
that wrote it. The quarantine ledger is read only when it is of the version
this release writes; a ledger of another version, or one that does not
parse, quarantines nothing on this machine, so every line it named is a gap
again until the ledger is repaired or removed.

`o2b store shard list` prints every entry with its state: `held` while the
same bytes still stand there, `resolved` once the line reads as a record,
`stale` once other bytes stand at the offset.
`o2b store shard release <partition>/<shard> --offset <n>` removes the
entry's mark. The line is a gap again only if it still is one: then the
protection reads fail closed again, while a `resolved` entry (its blob has
arrived) leaves the shard whole. When another process holds the ledger's
lock past the wait budget, `quarantine` and `release` refuse with
`ledger-busy` and change nothing; run the command again.

## Settings, schema and personas across machines

Shared settings are records in `shared/settings/`, so a change on one
machine applies on every other once the record syncs. A setting holds one
value, and when two machines change it before they sync, your change beats
an agent's and then the later one wins.

The schema fields (`brain.schema.<field>`, what `o2b brain schema apply` and
`schema_apply_mutations` change) are lists, and they merge per entry: an
apply writes one record per entry it adds or removes, never the whole list.
Two machines that change the same field before they sync keep both changes.
An add on one machine and a remove of the same entry on the other resolve
like a setting: your record beats an agent's, then the later one wins. For
fields of `name=value` entries that hold one value per name (`prefixes`,
`expert_routing`, `attributes`, `frontmatter_tiers`) a new value replaces
the old entry; in `attributes` and `frontmatter_tiers` the name is
`type.field`, and spaces around its dot do not make a second name. Two
spellings of one token (case, spaces, quotes) are one entry. An agent cannot change an entry you set or removed, through an apply
or through a whole-list `o2b brain settings set` or `brain_settings` write,
and an accepted write reports the list in force.

When a type is removed on one machine and a reference to it (an alias, a
prefix, an expert route, an attribute) is added on another, the merged
fields hold a reference to a type that is gone. The pack drops such
references when it is read, the same way on every machine, and the next
apply removes them from the records, so no apply is blocked by them. An
apply skips that removal when another machine has replaced the entry in
the meantime, and the removal it writes names the record it judged, so
every machine ignores it once a replacement it never saw, even one that
syncs in later, decides the entry.

The schema integrity check accepts a pack merged from applies on several
machines: each apply's audit row names the records it wrote and the
records rows it had seen already attest, and the migration's import
attests the records it imported. A record no apply wrote (a settings write,
a hand-made line) still reports the pack as modified, even when it leaves
the pack as it was or removes the last entry so that no pack is left, and
the next
store-only apply refuses with `unattested_schema_records`, naming the
records. A row attests each record in the version it saw, so another body
written under the id of an attested record counts as unattested too. Look
at them with `o2b brain schema report`; if they are right, adopt them with
`o2b brain schema apply --adopt-unattested` (alone, or added to the apply
that refused), which records the records and your name in the audit row.
Adoption alone works only on a store-only machine; an empty batch there
(no `--mutation`, or `--mutation '[]'`) changes no entry.
An agent cannot adopt. A record under `brain.schema.` for a name the pack
does not read is no part of the pack and needs no adoption.

Panel personas are store records once a machine is switched: curate them
with `o2b brain panel persona-set`, `persona-remove` and `personas`, on any
machine of the store, with or without a vault. Before the switch they are
notes under `Brain/personas/`. A persona is read on every machine, so a
private one (a `<private>` region, or a private page named in its lens or
prompt) is refused; the prompt holds at most 16 KB and the lens at most 200
characters on one line. The verbs refuse in a frozen vault, on a switched
machine too, and over a note of another kind at the persona's path. A
persona that lives in `private` (written before these rules, or marked
private) is not replaced, since the replacement would stay private: remove
it with `persona-remove`, then set it again. On a machine that has not
switched yet and runs the dual-write trial, `persona-remove` also removes
the copy the trial wrote to the store, so the persona stays removed after
the switch. The same holds for every Brain page a lane removes or moves
there: a moved page's store copy is the page as it is after the move, and
a private page moved over a shared one leaves no shared copy behind. A
page moved over a private one stays private, as a page written over it
does. A page that never reached the store, moved over one that did,
replaces the store copy of the page it overwrote. A moved page that is a
symbolic link, or sits in a linked folder, is never read into the store:
the move removes the old copy, and the store copy of a page it
overwrote. During the trial the legacy file is
the truth: when a switched machine has already stored a newer version of
a page and this machine moves the page, the store copy at the new path is
this machine's file, and the newer version stays only in the store's
history. A lane page or folder is never moved out of `Brain/` lanes, and a
lane folder is never moved into its own subfolder or into a folder that
holds it, on either kind of machine.

The `shared_namespace` mirror gets no store of its own. Where the shared
vault is store-only on a machine (it has no legacy tree), it is that
machine's brain store, which every store-only agent reads: the mirror writes
there when the origin record went only to the origin vault's legacy tree,
and refuses, with the reason, when the record is in the store already (a
switched machine, a store-only origin vault, dual writes on) or when the
machine has no store. These checks read the machine config the write
itself was made with. A `shared_namespace` path that is not a directory
(an unmounted share, a missing path, a file) is reported as failed.

## Standing rules and other Brain pages after the switch

On a switched machine the vault may have no `Brain/` folder at all, and
every reader below reads the store instead, also while a legacy tree is
still on disk (the store is the truth there):

- **Standing rules.** The migration imports `Brain/standing-rules.md` and
  the scoped rule files under `Brain/standing-rules/` into the
  `standing-rule` lane with your authority. The session start, the
  sub-agent carrier and `brain_context` read them from there, as the files
  said them: a lane entry keeps the file's text byte for byte when its
  fields and text would not reproduce it (no frontmatter, CRLF line ends,
  a quoted value). To change them, run
  `o2b brain standing-rules set --file my-rules.md`;
  `o2b brain standing-rules show` prints them, `clear` removes them, and
  `--project <name>`, `--harness <id>` or `--host <device id>` names one
  scoped rule file instead. No agent tool writes them.
- **Forgetting.** `o2b brain forget-source` and `brain_delete_by_source`
  find the derived signals, preferences and lane entries in the store and
  remove them with the store's own removal records (`signal-removed`,
  `preference-remove`, `lane-entry-remove`), whatever name the migrated
  page had; a removal the store does not reflect afterwards is reported as
  failed, never as nothing to remove. The forget and its plan name any
  part of the store they could not read (`unreachable`); a confirmed
  `forget-source` that carries it exits 1, and running it again once the
  shard reads removes the rest.
- **Claims, report snapshots, the signal dedup index.** `o2b brain claims`
  and `brain_claims` build the claim graph from the store's preferences,
  signals and `theses` entries; the explorer console lists report snapshot
  surfaces from the `reports` lane; the capture paths skip a signal the
  store already holds.
- **Lessons promotion and the budget watermark.** `o2b brain lessons`
  reads its candidates and judges its approvals against the store's
  preferences, and the doctor's `active-budget-pressure` check reads the
  active digest the session start reads.
- **Maintenance and hygiene readers.** Page dedup candidates, the
  semantics backfill plan, `o2b brain sources`, knowledge packs (list,
  conflicts, uninstall, the owner block of an export), the schema report's
  log event kinds, the capture-scope and document-dedup detectors, the
  orphan-session check and `o2b brain orphan-repair`, the skill rewrite
  verbs, the supersession chain lookup, source freshness and the recompile
  plan, and `privacy-marker-restamp` read the store's records and lane
  pages, and write through the store where they write.
  `doctor --repair` prunes a dead `evidenced_by` of a stored preference
  with a store record, in the private partition when the store holds the
  preference as private. `privacy-marker-restamp` skips by name a lane page
  whose stored text holds a line its fields omit, as it skips such a file,
  and one edited while it reads it: the page is read once under its lane
  lock and written only while the store still holds that read. The
  orphan-session check reports an uncertainty, and `o2b brain orphan-repair`
  refuses, while an events shard cannot be read or a signal lifecycle
  record waits for its blob. Every repair that writes from the store's
  fold judges that fold whole on the read its write decision rests on:
  while it may miss a record, `privacy-marker-restamp` stamps no lane page,
  `orphan-repair` skips the signal (`skip-incomplete`), `doctor --repair`
  leaves an evidence prune for a later run, and a knowledge-pack uninstall
  removes no rule (each is reported in `refused`). `o2b brain attest sign` refuses once the legacy log
  is gone: an attestation measures the legacy log and ledgers, which a
  switched vault no longer holds.
- **Quote check.** A quote of a `Brain/` page other than the two digests
  (the standing rules, say) reads `note-unavailable` on a switched
  machine, also while a legacy copy of the page is still on disk: that
  copy is stale, and the Stop hook does not read the store.
- **Snapshots.** A snapshot on a switched machine holds only its
  device-local state, not the memory. `o2b brain rollback <run id>` and
  `o2b brain snapshot diff <run id>` against the live tree refuse there and
  name `o2b brain migrate-store --rollback` (back to the legacy tree) and
  `o2b view recover <page>` (an older version of a view page);
  `o2b brain snapshot log` and `rollback --list` still list the snapshots.
  The recovery point a destructive operation takes there (`forget-source`,
  a note delete, a dream pass) says so: its recoverability is not
  `covered`, and it names `brain_records_in_store` as not covered, because
  the records the operation removes are store records no archive holds.
- **Vault map.** The migration imports `Brain/_vault-map.yaml` (the role
  tokens of `o2b vault map`, the note walk and graph import) into the
  operator-only shared setting `vault_map.document`, as it imports
  `_permissions.yaml` into `permissions.document`. A machine that switched
  before this import existed reads the copy its legacy-tree removal kept in
  the device-local archive the first time the map is needed, and stores it
  in the setting at your authority, unless the setting was ever recorded:
  after `o2b brain settings unset vault_map.document` the built-in folder
  names apply and the archive is not read again. While a settings shard
  cannot be read, or a settings record waits for its blob, the archive is
  not read either (your unset may be in it): the built-in folder names
  apply and nothing is written until every shard reads again. Where that archive is gone (or the
  tree was removed on another machine), the built-in folder names apply
  until you set the map yourself:
  `o2b brain settings set vault_map.document "$(cat _vault-map.yaml)"`.
- **Consumed and archived signals.** A signal page's state on a legacy
  machine is its folder. A page that sits in `Brain/inbox/processed/` or
  `Brain/inbox/archived/` with no state of its own (moved there by hand)
  reads as consumed or archived after the switch too, also on a store
  migrated before this release, because the store reads the state from
  the folder the migration recorded. That folder also wins over a state
  recorded before the switch (a signal approved and then moved into
  `processed/` by hand stays consumed, as the legacy reader showed it); a
  state set after the switch wins over the folder.
- **Rules migrated before the raw text was kept.** A rule file with
  frontmatter that an earlier release migrated is stored as fields and
  text only, and would read back with its YAML written anew (`'7'` as
  `7`, an empty value as `""`). While this machine keeps the original file
  (the legacy tree, or the archive of its removal) and that file still
  says exactly what the entry says, the rules read back byte for byte from
  it. Without it the entry's rendering applies; the values are the same.
  `o2b brain standing-rules set` stores the text whole.
- **A vault the process cannot examine.** A vault whose `Brain/` cannot
  be looked at (its permissions, an I/O error, a `Brain/` at mode 000 that
  still stats, a vault below a parent that cannot be traversed) on a
  machine that has not switched is neither store-only nor legacy: nothing
  is read from or written to either layout, and no reader answers as if
  the brain were empty. The doctors report it as a failing check, and
  `o2b brain migrate-store --dry-run` lists the folders it could not read
  and does not pass. A folder deeper inside `Brain/` that cannot be
  traversed is not this condition: its readers report it as uncertainty
  and the rest of the vault stays usable. Commands fail with one line naming the vault
  and the error, MCP tools with `vault_unreadable` (the server still
  starts and lists its tools, and answers normally once the vault can be
  read again, with no restart), the session start shows the rules as
  unavailable, and a lineage observation is dropped with a named notice.
  A switched machine knows where its brain is: while its vault cannot be
  examined or is gone, its MCP server answers each call as a server with
  no vault does (the brain tools from the store, a tool that needs the
  vault refuses with `vault_unreadable`), and never recreates a vault
  folder that is gone. The command line and the hooks take the same
  decision, in both shapes alike. The store-backed `o2b brain` verbs
  (`feedback`, `note`, `query`, `doctor`, `dream`, `export`, `claims`,
  `rollback --list`) answer from the store. A verb that needs the vault's
  own files (`migrate-store`, which inventories the legacy tree) refuses
  with one line naming the reason. The session start injects the digest
  from the store, led by an `UNAVAILABLE:` line for the operator's rules,
  which live in the vault and are therefore unknown, never absent. Every
  other hook serves the store as on a machine with no vault.
- **A vault folder that is gone, on a machine that has not switched.**
  The machine config names a vault and the folder is not there (an
  unmounted disk, a renamed folder). This is not a fresh installation:
  the brain is somewhere else, and the folder the config names is the
  only trace of where. So every surface says so before it says "there is
  nothing here yet". The session context leads with the notice - in the
  slot the `UNAVAILABLE:` block uses, so the operator's rules are
  reported as unknown rather than absent - and keeps `present: false`.
  Every refusal names the missing folder before any advice to initialise
  a new brain, and the advice it carried stays, second. The doctor
  (`brain_doctor` and `o2b brain doctor`) reports the missing folder
  ahead of the "brain root absent" entry, whose `o2b brain init` advice
  stays, behind the new `o2b status` exit. The command line writes the
  notice on stderr before the verb's own error, and the session start
  carries it in its runtime notices; that start no longer runs the
  background maintenance either, which would have created the very
  folder that is missing. A machine with no vault configured is not in
  this case: there is no folder to be missing, and a new installation
  keeps today's guidance word for word.

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
| `store-outside-vault` | The store sits at the per-user folder where 2.0.0 put it, outside the vault, so no other machine can receive its records. Nothing moves it by itself. The last refusal of the move command, if any, is named too. | Close every agent session on the machine, then run `o2b store move-into-vault` (`--dry-run` first shows the plan). |
| `store-late-writes` | After the store moved into the vault, a process of an older release wrote to the old folder; those records wait there. | Close every agent session on the machine, then run `o2b store move-into-vault --carry`. |
| `store-root-invalid` | The store root cannot be used: it is inside the vault anywhere but the reserved `.open-second-brain-store/` folder, a partition's `store.json` does not parse, or it holds partitions of two different stores. A caller below local reach (a remote MCP client) sees only that the store could not be opened, without the file or the store ids. | Remove `store_root` (the vault folder is then used) or point it outside the vault, keep only one store's partitions under it, and restore a `store.json` that does not parse from sync or a backup. |
| `store-partition-lost` | A partition this machine has held (it opened or initialised it here) no longer shows its `store.json`. The store is not opened: every protection fails closed and every store write is refused, because the partition's records cannot be read. | Restore that partition's `store.json` from sync or a backup. To stop holding `private` on this machine on purpose, stop syncing its folder, remove the folder, then run `o2b store partition leave private` (it needs `shared/store.json`, so restore `shared` first when both are lost); `shared` can only be restored. |
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
| `store-write-fail-open` | Writes from hooks or telemetry did not land (no store yet, no device id, a missing partition); their callers went on. A caller below local reach (a remote MCP client) sees only the failed writes known to go to `shared/`: a failure that may concern `private/` shows no count, time, error text or path there. | Fix the cause the finding names, then delete the counter file `store-write.json` in the `stores` state directory (`~/.local/state/open-second-brain/stores/` on Linux) to reset it. |
| `store-dual-write-failures`, `store-dual-write-skipped`, `store-dual-write-no-store` | Only on a machine running the phase 1 dual-write trial (`store_dual_write`): store copies of legacy writes failed or were skipped. Below local reach the failures follow the rule of `store-write-fail-open`, and the skipped writes are reported without their count. | Fix the cause, or migrate the machine and turn the trial off. |
| `migration-available` | This machine still keeps its brain in the vault's `Brain/` tree, or it switched before this vault was configured and the vault's legacy tree was never imported. | Follow [Moving an existing install](#moving-an-existing-install); on a switched machine run `o2b brain migrate-store`, which imports the tree and binds the vault. |
| `store-migration-failed` | The last automatic migration attempt on this machine failed; the finding gives the reason and when the next automatic attempt is due. | Fix the cause the reason names and wait for the next start, or run `o2b brain migrate-store` yourself. |
| `legacy-devices-pending` | This machine switched, but the named devices still write the legacy tree. | Migrate each named machine, and retire the ones that are gone with `o2b store device retire <device-id>`. |
| `sync-conflict-copies-kept` | The migration kept sync conflict copies that differ from their originals (another version of a record or a single document) in its backup and imported none of them. Advice: nothing waits on it. | Look at the copies in the folder the finding names, copy what you want into the brain, then delete the list file it names. |
| `legacy-tree-reappeared` | A `Brain/` folder is back in the vault after the legacy tree was removed. | Stop the writer the finding names and move the folder out of the vault. |
| `migration-done-twice` | Two devices each ran the first migration of this vault, before either completion record had synced, so items both imported are in the store twice. | Nothing is lost and both records stay. Migrate every other machine only after one completion record has synced. |
| `view-writer-silent` | The view writer has published nothing for more than 3 days. | Run `o2b view writer --here` on the machine that should render the view, with `--force` if the old writer is unreachable. |
| `dream-owner-unbound` | No dream owner is bound, so a live dream pass runs from any machine; a declared `primary_agent` is named as the requested owner. Advice. | Run `o2b dream owner --here --agent <name>` on the machine that should run dream. |
| `dream-owner-elsewhere` | Another machine is the dream owner although the declared `primary_agent` is the agent this machine runs as; this one runs no live pass and its maintenance lane skips dream. Not reported on a machine that merely previews, the normal state of every machine but the owner. Advice. | Nothing, or move the role with `o2b dream owner --here`. |
| `dream-owner-pending` | A transfer of the dream owner role waits for the owner's machine to release it. Advice. | On the owner's machine, run `o2b dream owner` or start a session. |
| `dream-owner-agent-differs` | The declared `primary_agent` is not the dream owner's agent. Advice. | On the owner's machine, run `o2b dream owner --here --agent <name>` or `o2b brain set-primary <name>`; both change the owner's agent, and `set-primary` also sets the declared name. On any other machine `set-primary <name>` refuses. |

Other questions that come up:

- **A machine shows a different store id.** It ran `o2b init` before sync
  delivered the partitions and made a store of its own. Delete that empty
  store, wait for sync and run `o2b init` again.
- **Records from another machine are missing.** Check that your sync tool
  has delivered the partition folders (`o2b store path` on both machines
  shows the same store id and both partitions as held where expected).
- **A write says `store lock busy` or `cannot take the lock`.** Several
  sessions writing at once take turns on short device-local locks; on
  Windows a lock that was just released can be refused for a moment, and
  that is waited out too. `store lock busy` means the lock stayed held past
  the wait (five seconds by default, `OPEN_SECOND_BRAIN_LOCK_WAIT_MS`
  raises it): retry. `cannot take the lock <path>: its directory <dir>
  refuses new entries` means the device-local state directory is not
  writable by this account (an ACL, Controlled Folder Access): fix its
  permissions. The check uses the same create operation as the lock, so
  ACLs can distinguish a file lock from a directory lock. The same message
  ending in `(EROFS); it is on a read-only mount` means the directory is
  on a read-only mount: move that data to a writable mount, since no
  permission change helps there.
- **A later machine's migration exits 1 and names missing shards.** The
  first machine's files have not arrived yet. Wait for sync and run it
  again, or use `--wait <seconds>`.
- **No page appears in the view folder.** Check `view_target` on the view
  writer, and that `o2b view writer` names that machine.
