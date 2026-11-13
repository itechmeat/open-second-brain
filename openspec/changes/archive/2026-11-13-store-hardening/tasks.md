# Tasks: harden the brain store

First read `openspec/project.md`, then this change folder: `proposal.md`,
`design.md`, and the spec deltas under `specs/`; `brainstorm.md` says why
the design is what it is. This list has three parts: Part Z (tasks 3.16
and 3.8 of `brain-store-and-topics`), Part C (tasks 3.17 and 3.15) and
Part I (integration). Two executors build Part Z and Part C at the same
time, each in its own checkout of this branch; an integrator then does
Part I. You were started with one line that names your part: do that part
only, and do not touch a box of another part.

Work in order, one section at a time. Before a section, read the design
decision and the spec delta it names. Tick each box (`- [x]`) as soon as
it is done, so an interrupted run resumes from the first open box.
Partial edits from an earlier attempt may already be in the tree: review
them, keep what is right, finish the rest.

For every behaviour: write the failing test first, run it and see it
fail, then write the code. Change nothing this list does not ask for.
When the code does not match what `design.md` or this list says (a name,
a line, a signature, a test that should fail and passes, or one that
should pass and fails for a reason this list does not name), stop at that
task, write what you found into your report file, and end your run.

## Environment and rules

These rules bind both executors.

1. Work only in the checkout you were started in. Set this in every shell
   before any `bun` command (`z` for Part Z, `c` for Part C):

   ```sh
   export TMPDIR=$HOME/.cache/osb-store-hardening-z-tmp   # Part C: ...-c-tmp
   mkdir -p "$TMPDIR"
   ```

   Delete that folder when your part is done.
2. Never read or write the real `~/.config/open-second-brain`, any real
   vault, or the real `~/.local/state/open-second-brain`. Tests get temp
   directories (`mkdtempSync(join(tmpdir(), "osb-<name>-"))`) and remove
   them in `afterEach`.
3. Never stop a process you did not start. Do not commit, push or open a
   pull request. Do not start subagents.
4. English only in code, comments, docs and tests; no exclamation marks;
   the product is written "Open Second Brain" in full. No machine paths,
   host names or account names anywhere in the repository.
5. During a section run only the test files that section names, with
   `bun test <file> [<file> ...]` (add `-t "<name>"` for one case). Never
   run the whole suite (`bun run test`): the integrator runs it once.
6. A test that runs the CLI goes through `runCli` from
   `tests/helpers/run-cli.ts` and passes an explicit empty stdin, as
   `tests/cli/brain-attest.test.ts` does:
   `runCli(args, { env: env(), stdin: "" })`.
7. Do not add `<!-- doc-test: ... -->` markers to any doc.
8. Never rebuild `openclaw/index.js`, never edit `CHANGELOG.md`,
   `package.json` or `openspec/changes/brain-store-and-topics/tasks.md`:
   those belong to Part I.
9. A file that is already past 700 lines (`design.md`, Goals) gets
   call-site edits only: an argument, an option property or an import
   line. Put any logic into a helper in another module.

# Part Z: leaving a partition (3.16) and raw lane text (3.8)

Files Part Z owns: `src/core/store/held-ledger.ts`,
`src/core/store/store-open.ts`, `src/core/store/seen-shards.ts`,
`src/core/brain/compiled-digest-path.ts`,
`src/core/store/partition-leave.ts` (new), `src/cli/store-partition.ts`
(new), `src/core/store/lane-raw.ts` (new), `src/core/store/lane-records.ts`,
`src/core/store/lane-entry-store.ts`, `src/core/store/lane-pages.ts`,
`src/core/store/FORMAT.md`, and the test files this part names.
Files shared with Part C, where Part Z adds only the lines named here:
`src/cli/store.ts`, `src/cli/command-manifest.ts`,
`docs/cli-reference.md`, `docs/brain-store.md`.
Part Z must not touch any other file, in particular `src/core/store/reader.ts`,
`src/core/store-migration/journal.ts`, `src/core/brain/doctor/store-check.ts`,
anything under `src/mcp/`, and the core log readers of design D2.

Your report file is `REPORT-part-z.md` at the checkout root.

## 0. Preconditions (Part Z)

- [x] 0.1 Confirm the tree. `git log --oneline -1` shows the commit
  "feat(store): split the lane page store, keep private log events off
  exports and remote readers (#293)" or a later main. `wc -l
  src/core/store/lane-pages.ts` prints 627, and `wc -l
  src/core/store/held-ledger.ts` prints 91. These names exist (check each
  with `grep -n`): `markerPath` and `ledgerDir` in
  `src/core/store/held-ledger.ts`; `ledgerPath` and `update` in
  `src/core/store/seen-shards.ts`; `const DIGESTS_DIR = "digests"` in
  `src/core/brain/compiled-digest-path.ts`; `export function laneTextParts`
  and `export function sameEntry` in `src/core/store/lane-entry-store.ts`;
  `export function readLaneText` and `export function writeLaneText` in
  `src/core/store/lane-pages.ts`; `case "device":` in `src/cli/store.ts`.
  On any mismatch, stop and report.
- [x] 0.2 Take the baseline. Run
  `bun test tests/core/store/held-ledger.test.ts tests/core/store/seen-shards.test.ts tests/core/store/store-open.test.ts tests/core/store/protection-store.test.ts tests/core/store/lane-records.test.ts tests/core/store/format-doc.test.ts tests/core/lanes/lane-pages.test.ts tests/cli/store-device.test.ts tests/core/search/brain-store-catch-up.test.ts tests/cli/manifest-completeness.test.ts tests/cli/help-surface-parity.test.ts tests/cli/completions.test.ts tests/core/architecture/import-cycles.test.ts`
  and write the pass and fail counts into the report. Everything should
  pass; if anything fails, stop and report.

## 1. Leaving a partition: the core (design D7 items 1 to 4, 6 and 7; spec `held-partitions`)

- [x] 1.1 Test first: create `tests/core/store/partition-leave.test.ts`.
  Setup per test: `parent = mkdtempSync(join(tmpdir(), "osb-partition-leave-"))`,
  `root = join(parent, "store")`, `initStore({ root })` (both partitions),
  then `openStore({ root, device: "dev-a" })` (records both held
  markers in this process's state directory; the test preload isolates
  it); `afterEach` removes `parent`. Import `leavePartition` and
  `PartitionLeaveRefusal` from `src/core/store/partition-leave.ts`,
  `HeldPartitionLostError` and `openStore` from
  `src/core/store/store-open.ts`. Write these cases:
  1. "refuses the shared partition": `leavePartition({ root, partition: "shared" })`
     throws a `PartitionLeaveRefusal` with `reason` `"shared"`.
  2. "refuses while private/store.json is present": with nothing removed,
     `leavePartition({ root, partition: "private" })` throws with reason
     `"still-held"`.
  3. "a lost private/store.json without the verb still fails closed":
     `rmSync(join(root, "private"), { recursive: true, force: true })`;
     `openStore({ root, device: "dev-a" })` throws `HeldPartitionLostError`
     whose message contains `o2b store partition leave private` and still
     contains `from sync or a backup`.
  4. "leaving private turns the machine shared-only": remove the
     `private` folder as in 3; `leavePartition({ root, partition: "private" })`
     returns `left: true` and `cleared.heldMarker: true`; then
     `openStore({ root, device: "dev-a" }).partitions` has `shared` and not
     `private`, with no throw.
  5. "nothing to leave changes nothing": after case 4's
     leave, a second `leavePartition` returns `left: false` and
     `cleared.heldMarker: false`.
  6. "files left refuse without force": remove only
     `join(root, "private", "store.json")`; `leavePartition` throws reason
     `"files-left"`; `openStore` still throws `HeldPartitionLostError`;
     `leavePartition({ root, partition: "private", force: true })` returns
     `left: true`, and `openStore` then succeeds with `shared` only.
  7. "clears the seen shards and the digest caches": before removing
     anything, append one record with `appendRecord(openStore({ root, device: "dev-a" }), { partition: "private", stream: "events", kind: "decision", agent: "t", body: { text: "x" } })`
     and read it with `readStreamRecords(root, "private", { stream: "events" })`
     (`src/core/store/read/stream-read.ts`; this records the shard as
     seen); take the store id with `readStoreId(join(root, "shared"))`
     (`store-open.ts`); create `join(digestCacheRoot(storeId), "k", "active.md")`
     with `mkdirSync` and `writeFileSync`. Then remove the `private`
     folder and leave: `cleared.seenShards` is at least 1 and
     `cleared.digestCaches` is `true`, and `digestCacheRoot(storeId)` no
     longer exists.
  8. "a store.json that returns is held again": after case 4's leave, run
     `initStore({ root, partitions: ["shared", "private"] })` (it creates
     `private/store.json` with the shared store id), then
     `openStore({ root, device: "dev-a" })` (records the marker again),
     then remove `join(root, "private", "store.json")`: `openStore` throws
     `HeldPartitionLostError` again.
  9. "the search index forgets the partition on its next catch-up": use
     `makeStoreIndexFixture` and `LOCAL_DEVICE` from
     `tests/core/search/fixtures/brain-store-index.ts` instead of the
     setup above (call `fx.cleanup()` at the end), and set
     `process.env[STORE_CATCH_UP_INTERVAL_ENV] = "0"` for the test,
     restoring it after, as `tests/core/search/brain-store-catch-up.test.ts`
     does. Steps: `const store = fx.open(LOCAL_DEVICE)`; if
     `store.partitions` lacks `private`, stop and report. Append
     `appendRecord(store, { partition: "private", stream: "events", kind: "decision", agent: "agent-a", body: { text: "the private heron sighting" } })`;
     `fx.writeNote("notes/a.md", "# A\n\nplain note\n")`;
     `await indexVault(fx.config())`; `await catchUpBrainStore(fx.config(), { force: true })`;
     a local `search(fx.config(), { query: "heron sighting", limit: 10, transportReach: TRANSPORT_REACH.local })`
     returns at least one result. Then `recordHeldPartitions(fx.root, ["shared", "private"])`
     (process state), remove `join(fx.root, "private")`,
     `leavePartition({ root: fx.root, partition: "private" })`,
     `await catchUpBrainStore(fx.config(), { force: true })`, and the
     same search returns no result. Imports as in
     `tests/core/search/brain-store-catch-up.test.ts`.
  10. "an unreadable shared store id refuses and changes nothing": set up
     as in case 7 (append, read, take `storeId`, create the digest cache
     file), keep `const sharedId = join(root, "shared", "store.json")` and
     its text (`readFileSync(sharedId, "utf8")`), remove the `private`
     folder, then write `"{"` to `sharedId`. `leavePartition({ root, partition: "private" })`
     throws a `PartitionLeaveRefusal` with reason `"no-store-id"` whose
     message contains `shared` and `store.json`; `isHeldPartitionMarked(root, "private")`
     (`src/core/store/held-ledger.ts`) is still `true`, and
     `join(digestCacheRoot(storeId), "k", "active.md")` still exists. The
     same holds with `sharedId` removed (`rmSync(sharedId)`) instead of
     corrupted. Then write the saved text back to `sharedId`: the leave
     returns `left: true`, `cleared.seenShards` at least 1 and
     `cleared.digestCaches` `true`.
  Run `bun test tests/core/store/partition-leave.test.ts`: it fails
  (the module does not exist). Note the failure in the report.
- [x] 1.2 In `src/core/store/held-ledger.ts` add, below
  `lostHeldPartitions`:
  `export function isHeldPartitionMarked(root: string, partition: StorePartition): boolean`
  returning `existsSync(markerPath(ledgerDir(), root, partition))`, and
  `export function forgetHeldPartition(root: string, partition: StorePartition): boolean`
  that returns `false` when the marker does not exist, otherwise removes
  it with `rmSync(marker, { force: true })` and returns `true` (import
  `rmSync` from `node:fs`). Replace the docblock paragraph that starts
  "No command takes a partition off this record" with: "One command takes
  a partition off this record: `o2b store partition leave <partition>`
  (`partition-leave.ts`), once the partition's identity file is gone. The
  other remedy is to restore the identity file (sync, or a backup). The
  list is keyed by the store root as configured, like the switch marker."
- [x] 1.3 In `src/core/store/seen-shards.ts`: add
  `function seenLedgerFile(storeRoot: string, storeId: string): string`
  holding the file-name lines of `ledgerPath` (the `rootKey` hash of
  `resolve(storeRoot)`, the `SEEN_SHARDS_FILE` rename, the `join` with
  `deviceStateDirFor(storeId, processDirsEnv())`), and make `ledgerPath`
  call it with `dirname(partitionRoot)` (behaviour unchanged). Add
  `export function forgetSeenPartition(storeRoot: string, storeId: string, partition: StorePartition): number`:
  `path = seenLedgerFile(storeRoot, storeId)`; `count = load(path).get(partition)?.size ?? 0`;
  when `count > 0`, `update(path, (ledger) => { ledger.delete(partition); })`
  and then, because `update` never throws, check that the write landed:
  when `(load(path).get(partition)?.size ?? 0) > 0`, throw
  `new Error(\`could not clear the seen-shard entries of the ${partition} partition in ${path}\`)`;
  return `count`. Extend the module docblock with one sentence: leaving a
  partition (`partition-leave.ts`) clears its entries.
- [x] 1.4 In `src/core/brain/compiled-digest-path.ts` add
  `export function digestCacheRoot(storeId: string): string` returning
  `join(deviceStateDirFor(storeId), DIGESTS_DIR)`, with a one-line doc
  comment ("The folder of every digest cache of the store `storeId`").
- [x] 1.5 Create `src/core/store/partition-leave.ts` with a header
  comment (what it does, design D7 of change `store-hardening`, and that
  a `store.json` that returns is held again by `recordHeldPartitions`).
  Contents:
  - `export class PartitionLeaveRefusal extends Error` with
    `constructor(readonly reason: "shared" | "still-held" | "files-left" | "no-store-id" | "clear-failed", message: string)`
    and `this.name = "PartitionLeaveRefusal"`.
  - `export interface LeavePartitionResult { readonly left: boolean; readonly partition: StorePartition; readonly cleared: { readonly heldMarker: boolean; readonly seenShards: number; readonly digestCaches: boolean } }`.
  - `export function leavePartition(options: { readonly root: string; readonly partition: StorePartition; readonly force?: boolean }): LeavePartitionResult`,
    in exactly this order:
    1. `partition === "shared"`: throw reason `"shared"`, message
       `the shared partition holds every rule of the brain store; leaving it is leaving the store, which this command does not do`.
    2. `dir = partitionDir(root, partition)`; when
       `existsSync(join(dir, STORE_IDENTITY_FILE))` (constant from
       `./constants.ts`): throw reason `"still-held"`, message
       `` `${join(dir, STORE_IDENTITY_FILE)} is still here, so this machine still holds the ${partition} partition; stop syncing ${dir}, remove the folder, then run the command again` ``.
    3. When `!isHeldPartitionMarked(root, partition)`: return
       `{ left: false, partition, cleared: { heldMarker: false, seenShards: 0, digestCaches: false } }`.
    4. `left = existsSync(dir) ? readdirSync(dir) : []`; when
       `left.length > 0 && options.force !== true`: throw reason
       `"files-left"`, message
       `` `${dir} still holds ${left.length} item(s) of the ${partition} partition without its ${STORE_IDENTITY_FILE}; remove the folder, or pass --force to leave the partition anyway (its files are then ignored on this machine)` ``.
    5. Before anything is removed: `storeId = readStoreId(partitionDir(root, "shared"))`,
       treating a `null` return and any thrown error alike (catch every
       error). When there is no store id: throw reason `"no-store-id"`,
       message
       `` `${join(partitionDir(root, "shared"), STORE_IDENTITY_FILE)} is missing or unreadable, so the device-local state of the ${partition} partition cannot be found; restore the shared partition's identity file first (sync, or a backup), then run the command again` ``.
       Nothing has changed at this point.
    6. Clear the device-local state first and the marker last, so a
       failure leaves the machine still holding the partition (it fails
       closed, and `HeldPartitionLostError` still names the verb). Inside
       one `try`: `cacheDir = digestCacheRoot(storeId)`,
       `existed = existsSync(cacheDir)`,
       `rmSync(cacheDir, { recursive: true, force: true })`,
       `digestCaches = existed`; then
       `seenShards = forgetSeenPartition(root, storeId, partition)`. In its
       `catch (err)`: throw reason `"clear-failed"`, message
       `` `could not clear this machine's state of the ${partition} partition (${err instanceof Error ? err.message : String(err)}); the partition is still held here; fix the cause, then run the command again` ``.
    7. Only now `heldMarker = forgetHeldPartition(root, partition)`.
    8. Return `{ left: true, partition, cleared: { heldMarker, seenShards, digestCaches } }`.
  It must not import `src/core/store/reader.ts` directly, nor anything under
  `src/mcp/`.
- [x] 1.6 In `src/core/store/store-open.ts`, `HeldPartitionLostError`:
  keep the message as it is and replace its last string piece
  `"from sync or a backup"` by
  `` `from sync or a backup, or run ${partitions.map((p) => `\`o2b store partition leave ${p}\``).join(" and ")} to stop holding ${partitions.length > 1 ? "them" : "it"} on this machine` ``.
  Run `bun test tests/core/store/partition-leave.test.ts tests/core/store/held-ledger.test.ts tests/core/store/seen-shards.test.ts tests/core/store/store-open.test.ts tests/core/store/protection-store.test.ts`:
  everything passes. If case 9 of 1.1 fails because the index still
  returns the record after the catch-up, stop and report (do not change
  any search module).

## 2. Leaving a partition: the verb and the docs (design D7 item 5, D9; spec `held-partitions`)

- [x] 2.1 Test first: create `tests/cli/store-partition.test.ts`, with
  the setup of `tests/cli/store-device.test.ts` (`parent`, `root`) and
  this `env()`:
  `{ [STORE_ROOT_ENV]: root, HOME: join(parent, "home"), XDG_STATE_HOME: join(parent, "state"), LOCALAPPDATA: join(parent, "state"), OPEN_SECOND_BRAIN_CONFIG: join(parent, "config.yaml"), O2B_DEVICE_ID: "dev-a" }`.
  Every test first runs `runCli(["store", "init"], { env: env(), stdin: "" })`
  and expects exit 0 (this records both held markers in the test's state
  folder). Cases:
  1. "shared is refused": `store partition leave shared` exits 1 and
     stderr contains `shared partition`; with `--json`, stdout parses to
     `{ ok: false, reason: "shared" }` (plus `error`).
  2. "a present store.json is refused": `store partition leave private`
     exits 1; `--json` reason `"still-held"`.
  3. "a lost private partition fails closed and names the verb": remove
     `join(root, "private")`; `store device list` exits 1 and stderr
     contains `o2b store partition leave private`.
  4. "leaving private": after removing the folder,
     `store partition leave private --json` exits 0 and stdout parses to
     an object with `ok: true`, `left: true`, `partition: "private"` and
     `cleared.held_marker: true`; then `store device list` exits 0.
  5. "the text answer": the same without `--json` exits 0 and stdout
     contains `Left the private partition`, `next catch-up` and
     `holds the private partition again`.
  6. "leaving twice": a second `--json` run exits 0 with `left: false`;
     its text form says `nothing to leave`.
  7. "files left": remove only `join(root, "private", "store.json")`;
     the verb exits 1 with `--json` reason `"files-left"`; with `--force`
     it exits 0 and `left: true`.
  8. "usage errors": `store partition leave` (no partition),
     `store partition leave bogus`, `store partition leave private extra`
     and `store partition` (no verb) each exit 2 and stderr starts with
     `error: ` and contains `usage: o2b store partition leave`; with
     `--json` each prints on stdout an object that parses to
     `{ ok: false, reason: "usage" }` with a string `error`.
  9. "an unreadable shared store id is refused": remove `join(root, "private")`
     and write `"{"` to `join(root, "shared", "store.json")`;
     `store partition leave private --json` exits 1 and stdout parses to
     `{ ok: false, reason: "no-store-id" }` with an `error` that contains
     `restore the shared partition's identity file first`; without
     `--json` stderr starts with `error: ` and stdout is empty.
  Run `bun test tests/cli/store-partition.test.ts`: it fails. Note it.
- [x] 2.2 Create `src/cli/store-partition.ts` on the model of
  `src/cli/store-device.ts` (its `EXIT`, `parse`, `usage`, `refuse`
  helpers copied and adapted; header comment with the exit codes):
  - `export const STORE_PARTITION_USAGE = "usage: o2b store partition leave <partition> [--force] [--config <file>] [--json]"`.
  - `export function cmdStorePartition(argv: ReadonlyArray<string>): number`:
    `-h`/`--help` prints the usage and returns 0; a first argument other
    than `leave` (or none) is a usage error (exit 2, message
    `missing store partition verb` or `unknown store partition verb: <verb>`).
  - `leave`: flags `force` (boolean), `config` (string), `json`
    (boolean); exactly one positional, which must be one of
    `STORE_PARTITIONS` (`src/core/store/constants.ts`), else a usage error
    `name the partition to leave (shared or private)` or
    `unknown partition: <name>` or `unexpected argument: <arg>`.
  - Resolve `root` with `resolveConfiguredStoreRoot(configPath).root`
    (`src/core/store/store-paths.ts`), call `leavePartition`. Refusals
    (exit 1): `PartitionLeaveRefusal` (its `reason`: `shared`,
    `still-held`, `files-left`, `no-store-id` or `clear-failed`),
    `StoreRootInsideVaultError` (`"store-root-in-vault"`),
    `ConfigReadError` (`"config"`, from `src/core/config.ts`). Anything
    else propagates.
  - Output shapes, exactly those of `store-device.ts`'s `refuse` and
    `usage` helpers: a refusal writes `error: <message>\n` to stderr and,
    under `--json`, `{ ok: false, reason, error }` (with `sortedReplacer`,
    two-space indent, a final newline) to stdout; a usage error writes
    `error: <message>\n<STORE_PARTITION_USAGE>\n` to stderr and, when the
    arguments contain `--json`, `{ ok: false, reason: "usage", error }` to
    stdout. Nothing else is written on a refusal or a usage error.
  - Text answer when `left`:
    `` `Left the ${partition} partition of the brain store at ${root} on this machine.\n  cleared: held marker, ${seenShards} seen shard entr${seenShards === 1 ? "y" : "ies"}, ${digestCaches ? "digest caches" : "no digest cache"}\nThe search index drops the ${partition} partition's records on its next catch-up. If ${join(root, partition, "store.json")} returns, by sync or a restore, this machine holds the ${partition} partition again from its next store write.\n` ``.
    When not `left`:
    `` `This machine does not hold the ${partition} partition of the brain store at ${root}; nothing to leave. If ${join(root, partition, "store.json")} arrives, by sync or a restore, this machine holds the ${partition} partition again from its next store write.\n` ``.
  - JSON answer (with `sortedReplacer` from `./helpers.ts`, two-space
    indent): `{ ok: true, left, partition, root, cleared: { held_marker, seen_shards, digest_caches } }`.
- [x] 2.3 In `src/cli/store.ts` add exactly: the import
  `import { cmdStorePartition, STORE_PARTITION_USAGE } from "./store-partition.ts";`
  after the `store-device.ts` import; `\n${STORE_PARTITION_USAGE}` at the
  end of the `USAGE` template; and, right after the `case "device":`
  return line, `case "partition":` returning `cmdStorePartition(rest)`.
  Add one sentence to the file's header comment: "`partition leave`
  takes a partition off this machine (`store-partition.ts`)." In
  `src/cli/command-manifest.ts`, inside the `store` command, right after
  the `device` entry, add:
  `command("partition", "Take a partition off this machine on purpose", [flag("config", "string"), flag("json", "boolean")], [command("leave", "Stop holding a partition whose folder is gone (never shared)", [flag("force", "boolean")])])`.
  Run `bun test tests/cli/store-partition.test.ts tests/cli/store-device.test.ts tests/cli/manifest-completeness.test.ts tests/cli/help-surface-parity.test.ts tests/cli/completions.test.ts`:
  everything passes. If a manifest or parity test fails, fix only the
  manifest entry or the usage text; if it needs anything else, stop and
  report.
- [x] 2.4 Docs. In `docs/cli-reference.md`, right after the line that
  starts `o2b store device list|retire`, add one line in the same
  two-column style:
  `o2b store partition leave    Take a partition off this machine on purpose, once its folder no longer carries store.json (stop syncing it and remove the folder first): removes this machine's held marker for it, clears its seen-shard entries and the digest caches, and the search index drops its records on its next catch-up. Refuses shared, a partition whose store.json is still there, a folder that still holds files unless --force, and a store whose shared/store.json is missing or unreadable (restore it first; nothing is changed); leaving a partition this machine does not hold exits 0 and changes nothing. A store.json that returns by sync or a restore makes the machine hold the partition again. --config, --json. Exit 0 for an answer, 1 for a refusal (shared, still-held, files-left, no-store-id, clear-failed, a store root inside the vault, an unreadable config), 2 for a usage error`.
  In `docs/brain-store.md`, at the end of the section "## Setup" (right
  before the heading `## Syncing`), add a subsection `### Leaving a partition`
  of one or two short paragraphs and one fenced `sh` block
  (`o2b store partition leave private`) that says: a machine that held a
  partition refuses every store command once that partition's
  `store.json` is gone; to take the partition off on purpose, stop
  syncing its folder, remove the folder, and run the command; what the
  command clears; that it refuses `shared`, and refuses (changing nothing)
  while `shared/store.json` is missing or unreadable, so restore that
  file first; that a returning `store.json`
  makes the machine hold the partition again. Run
  `bun test tests/docs` and expect the same result as before your edit
  (run it once before editing to compare); a new failure that names
  your text: fix your text.

## 3. Raw lane text (design D8; spec `lane-entry-fidelity`)

- [x] 3.1 Test first: create `tests/core/store/lane-raw.test.ts` for the
  new module `src/core/store/lane-raw.ts` (functions `renderLaneText`,
  `rawParsesBack`, `rawToKeep`, `lanePrivacyRow`, `laneTextParts`). For
  each case, compute `{ fields, body } = laneTextParts(path, raw)` first.
  Cases:
  1. "a page the parts reproduce keeps no raw": `path = "x.md"`, `raw` is
     `renderLaneText("x.md", { kind: "k" }, "Body.\n")`; `rawToKeep`
     returns `undefined`.
  2. "a page without frontmatter keeps its raw": `raw = "Just text.\n"`;
     `rawToKeep("x.md", raw, fields, body)` returns `raw`.
  3. "a quoted value keeps its raw": `raw = "---\nid: '123'\n---\nBody.\n"`;
     `fields.id` is the string `"123"` and `rawToKeep` returns `raw`
     (if `renderLaneText` already writes `id: '123'` byte for byte, use
     `id: "123"` instead and say so in the report).
  4. "CRLF keeps its raw": `raw = "---\r\nkind: k\r\n---\r\nBody.\r\n"`;
     `rawToKeep` returns `raw`.
  5. "a missing final newline keeps its raw": `raw = "---\nkind: k\n---\nBody."`.
  6. "JSON formatting keeps its raw": `path = "x.json"`, `raw = '{"a":1}\n'`.
  7. "plain text never needs raw": `path = "x.txt"`, `raw = "a\nb"`:
     `rawToKeep` returns `undefined`.
  8. "a raw that does not parse back is not kept": `rawToKeep("x.md", "---\nkind: other\n---\nBody.\n", { kind: "k" }, "Body.\n")`
     returns `undefined`, and `rawParsesBack` with the same arguments is
     `false`.
  9. "renderLaneText is the reader's rendering": `.md` gives
     `formatFrontmatter(fields, text)` (`src/core/vault.ts`); `.json` with
     empty text gives `JSON.stringify(fields, null, 2) + "\n"`; `.json`
     with text gives the text; another extension gives the text.
  10. "the privacy row": `lanePrivacyRow({ a: 1 }, "t")` deep-equals
     `{ fields: { a: 1 }, text: "t" }`, and with a third argument `"r"`
     deep-equals `{ fields: { a: 1 }, text: "t", raw: "r" }`.
  Run `bun test tests/core/store/lane-raw.test.ts`: it fails. Note it.
- [x] 3.2 Create `src/core/store/lane-raw.ts` (header comment: what it
  holds, design D8 of change `store-hardening`). Move
  `laneTextParts` there verbatim from `src/core/store/lane-entry-store.ts`
  with its doc comment, and in `lane-entry-store.ts` replace it with
  `export { laneTextParts } from "./lane-raw.ts";` plus an
  `import { laneTextParts } from "./lane-raw.ts";` for its own use
  (remove only imports the compiler then reports unused). Add:
  - `export function renderLaneText(path: string, fields: Readonly<Record<string, unknown>>, text: string): string`:
    `path.endsWith(".md")` gives `formatFrontmatter(fields as FrontmatterMap, text)`;
    `path.endsWith(".json") && text === ""` gives
    `` `${JSON.stringify(fields, null, 2)}\n` ``; otherwise `text`.
  - `export function rawParsesBack(path: string, raw: string, fields: Readonly<Record<string, unknown>>, text: string): boolean`:
    `const parts = laneTextParts(path, raw); return parts.body === text && canonicalJson(parts.fields) === canonicalJson(fields);`
    (`canonicalJson` from `../integrity/digest.ts`).
  - `export function rawToKeep(path: string, raw: string | undefined, fields: Readonly<Record<string, unknown>>, text: string): string | undefined`:
    `undefined` when `raw === undefined`, when
    `renderLaneText(path, fields, text) === raw`, or when
    `!rawParsesBack(path, raw, fields, text)`; otherwise `raw`.
  - `export function lanePrivacyRow(fields: Readonly<Record<string, unknown>>, text: string, raw?: string): Record<string, unknown>`:
    `raw === undefined ? { fields, text } : { fields, text, raw }`.
  `lane-raw.ts` imports only from `node:*`, `../vault.ts`,
  `../integrity/digest.ts` and `../types.ts`. Run
  `bun test tests/core/store/lane-raw.test.ts tests/core/architecture/import-cycles.test.ts`:
  both pass.
- [x] 3.3 Test first, in `tests/core/store/lane-records.test.ts`, three
  cases: "laneEntryRecord writes raw only when given" (`body.raw` is
  absent without `raw` and equals it with `raw: "x"`); "the fold carries a
  string raw" (`foldLaneEntries` over a record built with `raw: "x"`
  gives an entry whose `value.raw` is `"x"`); "the fold ignores a raw that
  is not a string" (a record whose `body.raw` is `5` folds with no
  rejection and `value.raw` is `undefined`). Build the records as that
  file's `entry` helper does: `rec({ physical: 1, kind: LANE_ENTRY_KIND, body: authored("agent", { lane: "obligations", entry: "obl-a", fields: { s: 1 }, text: "t", raw: "x" }) })`
  (`rec` and `authored` from `tests/core/store/fixtures/fold-records.ts`;
  `raw: 5` for the third case), fold with `foldLaneEntries([record])`,
  read the value with `.entries.get(laneEntryKey("obligations", "obl-a"))!.value`,
  and assert `fold.rejected` is empty for the third case. For the first
  case call `laneEntryRecord` with the input of the file's first test
  ("the builder writes the generic events record"), once without and once
  with `raw: "x"`. These three cases verify the requirement "The raw field
  is optional and never rejects a record" of spec `lane-entry-fidelity`.
  Run the file: the new cases
  fail. Then in `src/core/store/lane-records.ts`: `laneEntryRecord`'s
  input gains `readonly raw?: string`, and its `body` gains
  `...(input.raw !== undefined ? { raw: input.raw } : {})` after `text`;
  `LaneEntryValue` gains `readonly raw?: string` (doc comment: "The
  file's text byte for byte, when the fields and text do not reproduce
  it; served only when it parses back to them (`lane-raw.ts`)"); in
  `foldLaneEntries` the value gains
  `...(typeof record.body["raw"] === "string" ? { raw: record.body["raw"] } : {})`.
  `rejection` is not changed. Run the file again: everything passes.
- [x] 3.4 Test first, in `tests/core/lanes/lane-pages.test.ts`, a new
  `describe("raw lane text on a store-only machine", ...)` that uses
  `makeLaneEnv("store")` only, with these cases:
  1. "a page without frontmatter reads back verbatim": `writeLaneText`
     of `Just text.\n` to `join(lane.vault, "Brain", "obligations", "obl-raw.md")`;
     `readLaneText` returns `Just text.\n`.
  2. "a quoted value reads back verbatim": text
     `---\nid: '123'\n---\nBody.\n` (or the variant 3.1 case 3 chose)
     reads back verbatim, and `readLanePage(...)!.frontmatter.id` is the
     string `"123"`.
  3. "CRLF and a missing final newline read back verbatim".
  4. "JSON formatting reads back verbatim": `{"a":1}\n` to
     `.../obligations/raw.json`.
  5. "a rewrite that changes only quoting is written": write
     `---\nid: '123'\n---\nBody.\n`, then `---\nid: "123"\n---\nBody.\n`:
     `lane.laneRecords().filter((r) => r.kind === "lane-entry")` grows by
     one and the read returns the second text; writing the second text
     again adds no record.
  6. "a structured write replaces the raw": after case 1's write,
     `writeLanePage(vault, page, { kind: "k" }, "New.\n", { overwrite: true })`
     then `readLaneText` returns `formatFrontmatter({ kind: "k" }, "New.\n")`.
  7. "a move keeps the raw": after case 1's write,
     `moveLanePage(vault, page, join(dir, "obl-moved.md"))` and the new
     path reads back `Just text.\n`; `moveLaneTree` of the folder to
     another folder keeps it too.
  8. "a private region in a frontmatter comment sends the entry to
     private": text `---\n# <private>secret</private>\nkind: k\n---\nBody.\n`;
     `lane.laneRecords("shared")` is empty and `lane.laneRecords("private")`
     has the entry.
  9. "a reference only in the raw text is judged": text
     `---\n# see [[pref-nowhere-raw]]\nkind: k\n---\nBody.\n` lands in
     `private` (a preference id with no record cannot be judged and
     counts as private); the same page without the comment line lands
     in `shared`. If the second half lands in `private` too, or the first
     in `shared`, stop and report (do not change the reference judge).
  10. "a raw that does not parse back is not served": append a
     `lane-entry` record by hand whose `body` has `fields: { kind: "k" }`,
     `text: "Body.\n"` and `raw: "---\nkind: other\n---\nBody.\n"`, as
     the test "stays in the shared partition it lives in, tombstone and
     copy alike" of this file appends one:
     `appendRecord(openStore({ root: lane.env.storeRoot, device: "dev-b" }), { partition: "shared", stream: "events", kind: "lane-entry", agent: "t", body: { authority: "agent", lane: "obligations", entry: "obl-hand", fields: { kind: "k" }, text: "Body.\n", raw: "---\nkind: other\n---\nBody.\n" } })`;
     `readLaneText` of `join(lane.vault, "Brain", "obligations", "obl-hand.md")`
     returns `formatFrontmatter({ kind: "k" }, "Body.\n")`.
  11. "a hand-appended shared raw with a frontmatter comment is served as
     written": append as in case 10 (entry `obl-hand-comment`) a record
     whose `raw` is `---\n# see [[pref-nowhere-raw]]\nkind: k\n---\nBody.\n`,
     with `fields: { kind: "k" }` and `text: "Body.\n"`; `readLaneText`
     returns that `raw` byte for byte, comment included. This pins the
     trust boundary of design D8 item 5: the writer's judge is the only
     judge of `raw`, as of `text`, and the read-side check only proves the
     raw parses back. If the read returns the rendering instead, stop and
     report.
  Run `bun test tests/core/lanes/lane-pages.test.ts`: the new cases fail
  (except 8, which may already pass, and 10, whose record already reads
  as the rendering: say so in the report).
- [x] 3.5 Implement D8 items 3 and 4.
  In `src/core/store/lane-entry-store.ts`:
  `sameEntry(value, fields, text, raw?: string)` adds
  `&& value.raw === raw` to its condition; `isPrivateEntry(vault, fields, text, raw?: string)`
  passes `lanePrivacyRow(fields, text, raw)` to `rowNamesPrivatePage`
  instead of `{ fields, text }`; `entryRecord` gains a last parameter
  `raw?: string` (after `placement`), computes
  `const kept = rawToKeep(path, raw, fields, text)` and passes
  `...(kept !== undefined ? { raw: kept } : {})` to `laneEntryRecord`.
  In `src/core/store/lane-pages.ts`:
  - `readLaneText`, store branch: after `if (value === null) return null;`
    use
    `if (value.raw !== undefined && rawParsesBack(path, value.raw, value.fields, value.text)) return value.raw;`
    and `return renderLaneText(path, value.fields, value.text);`
    (replacing the two former return lines).
  - `writeLaneText`: in the held-in-store check compute
    `const raw = rawToKeep(path, text, fields, body);` after
    `laneTextParts` and call `sameEntry(storeEntry(vault, path), fields, body, raw)`;
    in the `store` closure compute `raw` the same way after
    `laneTextParts`, pass it as the fourth argument of `isPrivateEntry`
    and as the last argument of `entryRecord` (with `"judged"` as the
    `placement` argument before it).
  - `moveLanePage`: the `entryRecord` call gets the last argument
    `rewrite === undefined ? value.raw : undefined`.
  - `moveLaneTree`: the `entryRecord` call gets the last argument
    `value.raw`.
  - `writeLanePage`: no change.
  Remove only imports the compiler or the linter reports unused. Run
  `bun test tests/core/lanes/lane-pages.test.ts tests/core/store/lane-records.test.ts tests/core/store/lane-raw.test.ts tests/core/lanes`
  : everything passes. `wc -l src/core/store/lane-pages.ts` stays under
  700 (expected about 630).
- [x] 3.6 `src/core/store/FORMAT.md`: in the `lane-entry` bullet, write
  the shape as
  `{ "authority", "lane": "<lane>", "entry": "<entry id>", "fields": { ... }, "text": "<Markdown>", "raw": "<file text>" (optional) }`
  and add, after the sentence about `text`, these sentences: "`raw`, when
  present, is the file's text byte for byte, written only when `fields`
  and `text` do not reproduce it (a page without frontmatter, a quoted
  value, CRLF line ends, the formatting of a JSON file). A reader serves
  `raw` only when it parses back to the record's own `fields` and `text`,
  and renders `fields` and `text` otherwise; a reader that does not know
  `raw` ignores it. `raw` counts for the entry's privacy like `fields` and
  `text`, and spills into a blob with the rest of the body." Do not touch
  the first line (the format version marker). Run
  `bun test tests/core/store/format-doc.test.ts`: it passes.

## 4. Closing checks (Part Z)

- [x] 4.1 Run each, one at a time, and fix what they report in your own
  files: `bunx tsc --noEmit -p .`, `bun run lint`, `bun run fmt:check`
  (run `bun run fmt` to fix formatting, then check again),
  `bun run check:paths`.
- [x] 4.2 Run every test file Part Z touched or created once more, in one
  command:
  `bun test tests/core/store/partition-leave.test.ts tests/cli/store-partition.test.ts tests/core/store/lane-raw.test.ts tests/core/store/lane-records.test.ts tests/core/lanes/lane-pages.test.ts tests/core/store/held-ledger.test.ts tests/core/store/seen-shards.test.ts tests/core/store/store-open.test.ts tests/core/store/protection-store.test.ts tests/core/store/format-doc.test.ts tests/cli/store-device.test.ts tests/core/search/brain-store-catch-up.test.ts tests/cli/manifest-completeness.test.ts tests/cli/help-surface-parity.test.ts tests/cli/completions.test.ts tests/core/architecture/import-cycles.test.ts tests/docs`.
  All pass. `wc -l` of every source file Part Z changed or created is
  under 700 (`command-manifest.ts` excepted: it was past 700 before).
  `git status --short` lists only Part Z's files (plus `.apb/.gitignore`,
  which is not yours: leave it).

## 5. Report (Part Z)

- [x] 5.1 Write `REPORT-part-z.md` at the checkout root (never commit it;
  at most 60 lines): every Part Z box ticked or why not; the baseline and
  final test counts; the line counts of `lane-pages.ts`,
  `lane-entry-store.ts`, `lane-raw.ts`, `partition-leave.ts`,
  `store-partition.ts`; every place where the code did not match this
  brief and what you did; the choices this brief left to you (3.1 case 3,
  3.4 case 8); `git status --short`. Then delete your `TMPDIR` folder.

# Part C: private log reads (3.17) and partial shards (3.15)

Files Part C owns: every file design D1 to D6 names (D2's core readers
and MCP call sites, `src/mcp/brain/reach-events.ts`,
`src/core/brain/log-events-at-reach.ts`, `src/core/brain/temporal/types.ts`,
`src/core/brain/temporal/build-index.ts`, `src/core/store/reader.ts`,
`src/core/store/shard-quarantine.ts` (new),
`src/core/store-migration/journal.ts`,
`src/core/brain/doctor/store-check.ts`,
`src/core/brain/doctor/store-gap-check.ts` (new), `src/cli/store-shard.ts`
(new)), and the test files this part names. Files shared with Part Z,
where Part C adds only the lines named here: `src/cli/store.ts`,
`src/cli/command-manifest.ts`, `docs/cli-reference.md`,
`docs/brain-store.md`. Part C must not touch Part Z's files (Part Z's
list above), in particular `src/core/store/held-ledger.ts`,
`src/core/store/store-open.ts`, `src/core/store/seen-shards.ts`, the
lane modules and `FORMAT.md`.

Your report file is `REPORT-part-c.md` at the checkout root.

## 0. Preconditions (Part C)

- [x] 0.3 Confirm the tree: the commit of 0.1; `wc -l` of the files
  design "Context" lists past 700 lines matches it (record each count in
  the report: these are the counts the file may not grow past beyond
  call-site edits); `grep -n` finds `export function requestRefView` in
  `src/mcp/brain/reach-events.ts`, `function normaliseLogEntry` in
  `src/core/brain/temporal/build-index.ts`, `export function eventAtReach`
  in `src/core/brain/log-events-at-reach.ts`, `res.evidence.map(serializeLogEntry)`
  in `src/mcp/brain/query-tools.ts`, `export function shardReadGap` in
  `src/core/store/reader.ts`, `export function readHeldRecords` in
  `src/core/store-migration/journal.ts`, and
  `if (s.incomplete !== true) unreadable.push(s);` in
  `src/core/brain/doctor/store-check.ts`. Search `src/` for readers of the
  index's `corrupt_lines` column (design D4 item 5): if any code treats it
  as a gap, stop and report. On any mismatch, stop and report.
- [x] 0.4 Take the baseline:
  `bun test tests/mcp/log-private-reach.test.ts tests/mcp/log-readers-reach.test.ts tests/core/store/reader.test.ts tests/core/store/read-gaps.test.ts tests/core/store/state-digest.test.ts tests/core/brain/doctor-store.test.ts tests/cli/store-device.test.ts tests/cli/manifest-completeness.test.ts tests/cli/help-surface-parity.test.ts tests/cli/completions.test.ts tests/core/architecture`
  plus the existing test files of the core readers of design D2 and of
  the timeline builders:
  `tests/core/brain/most-applied.test.ts tests/core/brain/store-readers/reader-parity.test.ts tests/core/brain/owner-scope-delivery.test.ts tests/core/brain/morning-brief.test.ts tests/core/brain/idea-discovery.test.ts tests/core/brain.agent-source.query.test.ts tests/core/brain.backlinks.test.ts tests/core/brain/backlinks-owner-scope.test.ts tests/core/brain/status-maintenance-debt.test.ts tests/core/brain/store-only-operator-readers.test.ts tests/core/brain/memory-cost-meter.test.ts tests/core/brain/token-footprint.test.ts tests/core/brain/maintenance-collect.test.ts tests/core/brain.operator-snapshot.test.ts tests/core/brain.idea-lineage.test.ts tests/core/brain/notes/write-log.test.ts tests/core/brain/notes/write-destinations.test.ts tests/core/brain/notes/revert.test.ts tests/core/brain/link-graph/concept-cluster.test.ts tests/core/brain/link-graph/moc-audit.test.ts tests/core/brain.doctor.test.ts tests/core/brain/digest-actions.test.ts tests/core/brain/trust/operator-summary.test.ts tests/core/brain/temporal tests/mcp/temporal-mcp-tools.test.ts tests/mcp/consolidated-tools.test.ts`
  (this is "the reader's existing tests" every task of sections 6 and 7
  runs: the files of that list whose name matches the reader). Record
  the counts; on a failure, stop and report.

## 6. The two roots (design D1; spec `remote-log-reads`)

- [x] 6.1 Test first: create `tests/mcp/log-private-reach-surfaces.test.ts`
  with the setup of `tests/mcp/log-private-reach.test.ts` (`makeStoreEnv`,
  `switchDevice`, `appendLogEvent`, `withOperationPrivacy(true, ...)`),
  calling tools through `new MCPServer({ vault: env.vault, configPath: env.configPath }, { reach })`
  and `callTool` (see `reachServer` in `tests/helpers/reach-log-fixture.ts`).
  Cases, each with one shared note and one private note that names
  nothing, in the window: `brain_analytics` timeline view, `brain_brief`
  daily, weekly, monthly and today views: the remote answer carries the shared
  text and not the private text, the local one both. Add a unit case for
  `eventAtReach` with a marked event and a view whose `withholdsPrivate`
  is set (`null`) and not set (the event). Run the file: the cases fail.
- [x] 6.2 Implement D1 items 1, 2 and 4 (`requestRefView`,
  `TemporalEvent.fromPrivatePartition`, `normaliseLogEntry`,
  `eventAtReach`, `withoutPrivateEntries`) and item 3
  (`BuildTimelineIndexOptions.withholdsPrivate`, `collectLogEvents`), with
  a unit case for item 3 in the same test file. Run it and
  `tests/mcp/log-private-reach.test.ts tests/mcp/log-readers-reach.test.ts`
  and the existing temporal and analytics tests
  (`tests/core/brain/temporal tests/mcp/temporal-mcp-tools.test.ts tests/mcp/consolidated-tools.test.ts`): all pass.

## 7. The readers with a remote surface (design D2; spec `remote-log-reads`)

For each row: test first in `tests/mcp/log-private-reach-surfaces.test.ts`
(one `describe` per row, a remote and a local assertion, one private
event that names nothing unless the row says otherwise), see it fail,
then the code, then that file and the reader's existing tests pass.

- [x] 7.1 Row 1, `brain_query` preference mode: evidence with one shared
  event, one private event and one shared event naming a page reserved
  against remote reads (as `tests/helpers/reach-log-fixture.ts`
  reserves one); the remote evidence is the first only, and the recall
  telemetry row the call wrote counts 1 (read it the way the existing
  recall-telemetry tests do).
- [x] 7.2 Row 2, most-applied: a shared confirmed preference with one
  shared and two private `applied` evidence events: remote `brain_context`,
  `osb://active` and `osb://digest/latest` count 1, local ones 3.
- [x] 7.3 Row 3, morning brief and idea discovery: a private note and a
  private open reconcile question are absent from remote
  `brain_brief` view=morning and `brain_idea_discovery`, present locally.
- [x] 7.4 Row 4, agent provenance: an agent whose only event is private
  is absent from remote `brain_agent_query` and `brain_agent_diff`
  (contributions, roster and counts), present locally; no answer, local
  or remote, carries a `fromPrivatePartition` field.
- [x] 7.5 Row 5, backlinks: a shared preference referenced only by a
  private event: remote `osb://backlinks/<id>` and `brain_backlinks` list
  no log backlink (count 0), the remote digest's inbound count ignores it;
  local ones list it. On the same fixture: remote `brain_analytics`
  view=concept_synthesis for that preference lists no linker whose
  `sourceKind` starts with `log-` (local lists one); a shared hub note
  (a MOC body over the `auditMoc` thresholds, as
  `tests/core/brain/link-graph/moc-audit.test.ts` builds one) links that
  preference, and remote `brain_moc_audit` of the hub reports its member
  with `backlinkCount` 0, local with 1. A second private event wikilinks
  `pref-missing-target` (no such file): remote `brain_doctor` has no
  `broken-backlinks` warning for it and the remote repair preview
  (`brain_doctor` with `repair: true` and no `apply`) counts no `broken-backlinks` in
  `unfixable`; local ones have the warning and the count. Code:
  `buildConceptCluster`, `auditMoc`, `RunDoctorOptions` and
  `DoctorCheckContext` gain the option; `brokenBacklinkCheck` and
  `collectDoctorIssues` pass it (`applyRepair` gives the latter
  `view.withholdsPrivate === true`); then the call-site edits in
  `analytics-tools.ts`, `knowledge-tools.ts` and `health-tools.ts`
  (design D2 row 5).
- [x] 7.6 Row 6, status: the newest apply-evidence, the newest `dream`
  event (`BRAIN_LOG_EVENT_KIND.dream`, appended with `appendLogEvent`
  inside `withOperationPrivacy(true, ...)` like any other private event)
  and the only event of the newest day are private, with an older shared
  apply-evidence and an older shared dream: remote `second_brain_status`
  and `osb://status` show the shared apply-evidence time, the shared
  dream time (`last_dream_at`; `scanLogTimestamps` reads both from
  `statusLog`) and one log day fewer, local ones the private times; the
  `brain_context` maintenance flag is computed without the private day.
- [x] 7.7 Row 7, cost meter: remote `brain_recall_telemetry` operation
  `cost` counts one write of one shared and one private.
- [x] 7.8 Row 8, token footprint: the log bucket of
  `computeTokenFootprint` with `withholdsPrivate: true` leaves out the
  private event's tokens and with `false` counts them. The `brain_doctor` path
  offers no way to set the threshold: `collectMaintenanceActions` calls
  `computeTokenFootprint(vault)` with no options, so the threshold is
  `TOKEN_WARN_THRESHOLD_DEFAULT` (200000 tokens; the
  `BRAIN_TOKEN_WARN_THRESHOLD` variable is read only by the CLI verb).
  So test `collectMaintenanceActions` directly (in the row's `describe`
  of `tests/mcp/log-private-reach-surfaces.test.ts`, with its store
  setup) at that default: give
  the private event a text of 8000 characters (about 2000 tokens,
  `estimateTokens` is bytes / 4), then fill a bucket the store counts.
  A store-only machine does not count files under `Brain/` (the `other`
  bucket is skipped when `memoryFromStore(vault)` is true), so the filler
  is shared log events: append shared `note` events (no
  `withOperationPrivacy`), each with a text of at most 60000 characters,
  until
  `computeTokenFootprint(vault, { withholdsPrivate: true }).total` is
  between `TOKEN_WARN_THRESHOLD_DEFAULT - 1000` and
  `TOKEN_WARN_THRESHOLD_DEFAULT` (measure the total after each append and
  size the last event from the difference; assert both bounds before
  going on). If the log bucket does not grow with a shared event's size
  either (a cap, or the body spilling into a blob that is not counted),
  use whichever store-counted bucket of `computeTokenFootprint` does grow
  (read the function), and say which in the report. Then `collectMaintenanceActions(vault, { withholdsPrivate: true })`
  has no action with category `token-footprint` and
  `collectMaintenanceActions(vault)` has one. Then
  the call-site edit in `health-tools.ts` passes the option. On the same
  fixture (filler sized the same way), the two other remote surfaces of
  the collector: remote `osb://digest/latest` and `brain_brief`
  view=digest have no `token-footprint` action, local ones have it (the
  edit: `digest.ts` passes `refs.withholdsPrivate === true` to
  `collectMaintenanceActions`); remote `brain_brief` view=operator has no
  `token-footprint` entry in `top_actions`, local has it (the edit:
  `BuildOperatorSummaryOptions.withholdsPrivate`, passed by
  `safeTopActions` to `collectMaintenanceActions` and by `safeDoctor` to
  `runDoctor`, and `brief-tools.ts` passes
  `withholdsPrivate: view.withholdsPrivate === true` outside the
  `view.filtersNothing` spread). Call `brain_brief` view=operator with
  `include_dream: false` so no dry-run dream runs, and `top_actions`
  large enough to hold every action of the fixture.
- [x] 7.9 Row 9, the unfiltered timeline builders: a private
  apply-evidence on a shared preference is absent from remote
  `brain_idea_lineage` of that preference, and does not change the
  remote `brain_stale_scan` or `brain_status` stale counts. The two stale
  counts take different paths (design D2 row 9): `brain_stale_scan`
  (`src/mcp/brain/review-tools.ts`, `toolBrainStaleScan`) builds its own
  index with `buildTimelineIndex(ctx.vault, {})` and `findStaleEntries`,
  and gets the option at that call (build `reviewView(ctx)` before it and
  pass `withholdsPrivate: view.withholdsPrivate === true`);
  `brain_status` (`health-tools.ts`) passes it to `buildOperatorSnapshot`,
  which passes it to its own `buildTimelineIndex` call and to its
  `runDoctor` call (design D2 rows 5 and 9; the doctor-warnings count of
  remote `brain_status` ignores a `broken-backlinks` finding raised only
  by a private event, as in task 7.5).
- [x] 7.10 Row 10, note writes: a shared note written inside a private
  operation is absent from remote `brain_writes` and
  `brain_write_destinations` (lists and counts), present locally. Remote
  `brain_writes` action `plan_revert` with a selector on that note's path
  lists no write from the private operation and its digest differs from
  the local plan's digest; the local plan lists it (the edit:
  `PlanNoteRevertOptions.withholdsPrivate`, passed to both
  `listNoteWrites` reads, and `query-tools.ts` takes the `reachView`
  before `planNoteRevert`).

## 8. The census (design D3; spec `remote-log-reads`)

- [x] 8.1 Create `tests/core/architecture/log-reader-census.test.ts` as
  design D3 describes, with the table of D3 (one row per module). Add a
  case that proves the census fails on an unlisted module (feed the
  checker a fake module list, as `write-site-census.test.ts` proves its
  own rule). Run it: it passes; if the walk finds a module the D3 table
  does not list, stop and report it (do not classify it yourself unless
  it is plainly CLI-only, and then say so in the report).

## 9. The quarantine ledger and the reader (design D4; spec `store-shard-gaps`)

- [x] 9.1 Test first, in a new `tests/core/store/shard-quarantine.test.ts`
  (store set up as in `tests/core/store/read-gaps.test.ts`): a corrupt
  middle line makes `shardReadGap` non-null; after `addQuarantine` for its
  partition, shard, offset and line hash, the shard reads whole
  (`shardReadGap` null) and the bytes on disk are unchanged; a different
  line written at the same offset (rewrite the shard) is a gap again; a
  second corrupt line at another offset in the same shard is still a gap
  while the first stays quarantined (the mark needs the offset and the
  line hash both, for a diagnostic and a pending record alike, design D4
  item 3); a pending record whose offset is in the ledger with another
  line hash still counts; an `unknown-version` line is never marked; a pending blob entry stops
  counting, its record is still left out of `readStreamRecords`, and once
  the blob file is written the record reads with its body; two
  concurrent `addQuarantine` calls from two processes both land (spawn as
  `tests/core/store/held-ledger.test.ts` does); `releaseQuarantine`
  brings the gap back; `listQuarantine` reports `held`, `resolved` and
  `stale`. A capture case: a corrupt middle line in a `shared` settings
  shard closes `buildCaptureBoundary` (`src/core/brain/capture-boundary.ts`),
  and the quarantine opens it again. A migration case: a quarantined
  pending blob still puts its shard into `readHeldRecords(...).unseen.partial`.
  Run: the cases fail.
- [x] 9.2 Implement `src/core/store/shard-quarantine.ts` (D4 items 1 and
  2), the marks in `readShard` and the skip in `shardReadGap` (item 3),
  and the pending rule in `readHeldRecords` (item 4). Run the new file
  and `tests/core/store/reader.test.ts tests/core/store/read-gaps.test.ts tests/core/store/state-digest.test.ts tests/core/store/seen-shards.test.ts`
  and the store-migration tests (`tests/core/store-migration`): all pass.

## 10. Doctor findings (design D5; spec `store-shard-gaps`)

- [x] 10.1 Test first, in `tests/core/brain/doctor-store.test.ts`: one
  case per finding (`store-shard-corrupt-line` error with the offset and
  the quarantine command; `store-shard-newer-format` warning with no
  command; `store-shard-blob-pending` warning when young, error when
  older than seven days, no command for a `settings` shard; a torn line
  and a quarantined line give no finding). Run: they fail.
- [x] 10.2 Implement `src/core/brain/doctor/store-gap-check.ts` and the
  call-site edits in `store-check.ts` (D5). Update `store-check.ts`'s
  header list with one item for the new findings. Run the doctor tests:
  all pass.

## 11. The verb and the docs (design D6, D9; spec `store-shard-gaps`)

- [x] 11.1 Test first: create `tests/cli/store-shard.test.ts` with the
  `env()` of `tests/cli/store-partition.test.ts` (task 2.1; write the
  same object), `runCli(..., { env: env(), stdin: "" })`: quarantine,
  `already`, list, release, `not-quarantined`, each refusal reason of D6
  under `--json`, and usage errors (exit 2). Run: it fails.
- [x] 11.2 Create `src/cli/store-shard.ts` (D6). In `src/cli/store.ts`
  add only: the import of `cmdStoreShard` and `STORE_SHARD_USAGE`, the
  usage joined at the end of `USAGE`, and `case "shard":` right after
  `case "device":`'s return line, plus one header comment sentence. In
  `src/cli/command-manifest.ts` add only a `command("shard", ...)` entry
  right after the `device` entry of `store`, with `quarantine`, `list`
  and `release` and their flags. Run the new test and
  `tests/cli/manifest-completeness.test.ts tests/cli/help-surface-parity.test.ts tests/cli/completions.test.ts tests/cli/store-device.test.ts`:
  all pass.
- [x] 11.3 Docs: one line in `docs/cli-reference.md` right after the line
  that starts `o2b store device list|retire` (the verbs, refusals, exit
  codes, `--json`), and in `docs/brain-store.md` a section
  `## Shards read only in part` right before
  `## What the partitions protect, and what they do not`: the three
  doctor findings, what fails closed, the quarantine on one machine, why
  never a newer-format line or a young or settings blob, that rollback
  and the late import still refuse on a pending blob, list and release.
  Run `bun test tests/docs` before and after: no new failure.

## 12. Closing checks (Part C)

- [x] 12.1 Run each, one at a time, and fix what they report in your own
  files: `bunx tsc --noEmit -p .`, `bun run lint`, `bun run fmt:check`
  (`bun run fmt` to fix), `bun run check:paths`.
- [x] 12.2 Run every test file Part C touched or created, and the
  baseline of 0.4, once more in one command; all pass. `wc -l`: every
  file Part C created or changed that was under 700 lines stays under
  700; every file past 700 grew only by its call-site edits (list the
  growth per file in the report). `git status --short` lists only Part
  C's files (and `.apb/.gitignore`, which is not yours).

## 13. Report (Part C)

- [x] 13.1 Write `REPORT-part-c.md` at the checkout root (never commit
  it; at most 80 lines): every Part C box ticked or why not; the baseline
  and final counts; the line growth of each file past 700; every
  deviation from design.md and why; every module the census found that
  D3 did not list; anything in this brief that did not match the code;
  `git status --short`. Then delete your `TMPDIR` folder.

# Part I: integration (the integrator)

- [x] 14.1 Merge Part Z's and Part C's working trees into one checkout of
  this branch, and read both reports first. Resolve the overlaps of design
  D9 by keeping both parts' lines: `src/cli/store.ts` (both imports, both
  usages, `case "partition"` then `case "shard"` after `case "device"`),
  `src/cli/command-manifest.ts` (`partition` then `shard` after
  `device`), `docs/cli-reference.md` (the `partition` line then the
  `shard` line), `docs/brain-store.md` (each part's own section). Delete
  `REPORT-part-z.md` and `REPORT-part-c.md`. Verify:
  `git status --short` shows no report file and no conflict marker
  (`git diff | grep -c '^[<>=]\{7\}'` prints 0).
- [x] 14.2 Rebuild the OpenClaw bundle once:
  `bunx bun@1.4.0 run build:openclaw`; keep `openclaw/index.js`. Verify:
  `git diff --stat openclaw/index.js` shows it changed (it carries
  `reader.ts`, `held-ledger.ts` and `store-open.ts`).
- [x] 14.3 `CHANGELOG.md`: one entry naming the four behaviours of the
  proposal under a `## [Unreleased]` heading placed above the newest
  release heading (Keep a Changelog; create it when absent). No version
  heading and no version bump: this pull request ships no release.
  Verify: `bun run scripts/sync-version.ts --check` passes, `package.json`
  is unchanged, and `bun test tests/docs tests/scripts` passes; if a test
  rejects the `Unreleased` heading, remove the entry and record that the
  store work ships its notes with the phase release (task 3.7 of
  `brain-store-and-topics`), as the three store pull requests before it
  did.
- [x] 14.4 Run the full local gate of `openspec/project.md`, each command
  on its own; all must pass:
  `bun run test`
  `bunx tsc --noEmit -p .`
  `bun run lint`
  `bun run fmt:check`
  `bun run check:paths`
  `bun run sync-plugin-mirrors:check`
  `bun run scripts/sync-version.ts --check`
- [x] 14.5 In `openspec/changes/brain-store-and-topics/tasks.md`, append
  "Done in change `store-hardening`." to tasks 3.8, 3.15, 3.16 and 3.17
  and tick them. Tasks 3.18 (dream and evidence over private
  apply-evidence) and 3.19 (split the files past 700 lines) are already
  in that file, added with this change: confirm both are present and
  open (`grep -n "^- \[ \] 3.1[89] " openspec/changes/brain-store-and-topics/tasks.md`
  prints two lines) and leave them open; if either is missing, stop and
  report. Verify: `openspec validate store-hardening --strict` passes.

## Workflow follow-up

- Independent code review rounds of the merged result, fixes re-reviewed.
- Archive the change (`openspec archive store-hardening --yes`) inside its
  pull request, after the whole cycle is green.
