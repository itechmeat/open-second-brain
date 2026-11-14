/**
 * Global bun:test preload (registered in bunfig.toml).
 *
 * Makes the whole suite hermetic: no test reads or writes the developer's
 * real config, vault, store or per-user directories, and no test sees what
 * an earlier file left behind in process-wide state.
 *
 * What every test process gets (design D14 items 1 and 16, task 2.10):
 *
 *  - **No vault.** The default config (`OPEN_SECOND_BRAIN_CONFIG`) is an
 *    empty throwaway file, as on a machine with no vault configured, and
 *    an exported `VAULT_DIR` (or `OPEN_SECOND_BRAIN_VAULT`) is dropped. A test
 *    that needs a vault makes one with `makeTestVault()`
 *    (`tests/helpers/test-vault.ts`) or points the variable at its own
 *    config. A vault without `Brain/` is store-only (D14.1); a test of the
 *    legacy layout creates `Brain/` in its vault.
 *  - **A device id.** `O2B_DEVICE_ID` is `test-device`, so every brain
 *    store write has a device to name its shards by, and the legacy
 *    per-device ledgers are sharded the way a real machine shards them. A
 *    test that needs "no device id" (or the un-sharded legacy file names)
 *    sets `O2B_DEVICE_ID=""` itself (`tests/helpers/device-id.ts`).
 *  - **No store, at a root of this run.** `OPEN_SECOND_BRAIN_STORE_ROOT`
 *    names a directory of this run that does not exist. The preload does
 *    NOT create a store: one store shared by every file of the process
 *    would carry one test's records into the next test's reads, and a
 *    store found at the root also moves the search index into the store's
 *    device-local state for every search test. A test whose writes go to
 *    the store makes a store of its own with `makeTestStore()`
 *    (`tests/helpers/test-store.ts`): one `o2b store init` at a temp root,
 *    a few milliseconds, paid only by the tests that need it. A test that
 *    needs "no store" needs nothing.
 *  - **Sandboxed per-user directories.** `XDG_STATE_HOME`, `XDG_DATA_HOME`
 *    (POSIX) and `LOCALAPPDATA`/`APPDATA` (Windows) are roots of this run,
 *    so device-local state (store identity, the store-only marker, the
 *    machine state of a bare vault) never reaches `~/.local/state`,
 *    `~/.local/share` or `%LOCALAPPDATA%`.
 *  - **Per-test resets** of process-wide memos: the origin channel and
 *    the machine-state cache, and of the device-local fail-open counter
 *    of store writes, which every test of the process would otherwise
 *    share (a telemetry write that did not land in one test is a doctor
 *    finding in the next).
 *
 * Every override reaches this process and children spawned with an
 * explicit `env: { ...process.env }`. A test that needs another value sets
 * the variable itself. The roots that hold user data (the config file, the
 * device-local state and data dirs, the Windows app-data roots and the
 * dedup cache) are replaced even when the run exports them: an exported
 * `XDG_STATE_HOME` on a developer machine names the real one, and the
 * suite must never write there. Other variables a run exports are kept.
 */
import { afterAll, beforeEach } from "bun:test";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { clearOriginChannel } from "../src/core/origin-channel.ts";
import { MARKDOWN_NEUTRALIZE_MODE_ENV } from "../src/core/brain/text/neutralize-markdown.ts";
import { forgetMachineStateCache } from "../src/core/state/machine-state.ts";
import { storeWriteStatusPath } from "../src/core/store/store-write.ts";
import { installInflightRecorder } from "./helpers/inflight-recorder.ts";
import { DEFAULT_STORE_ROOT_ENV } from "./helpers/test-store.ts";
import { TEST_DEVICE_ID } from "./helpers/test-vault.ts";

// The origin channel (`src/core/origin-channel.ts`) is process-scoped by
// design: an entry point claims it once and every record written under
// that process carries it. Bun runs many test files in ONE process, so a
// file that invokes `main()` leaves `cli` claimed for every file that
// runs after it - and a byte-identity golden over a log line, a signal or
// a continuity record would then pass or fail on file ORDER.
//
// Unclaiming before each test makes the default deterministic (`unset`,
// the explicit literal for "no entry point claimed this process") without
// pinning a real channel that would hide the difference. A test that
// wants a channel claims it, exactly as the entry point does. Registered
// here rather than in each suite for the same reason `O2B_DEVICE_ID` is
// pinned below: a hermeticity rule every file needs is not a rule every
// file should have to remember.
//
// The machine-state module caches store ids and the state it adopted or
// restored (`state/machine-state.ts`), keyed by paths a test removes in
// its teardown, so a memo outliving its test can only answer for a store
// that no longer exists; forgetting it per test keeps a file's answer
// independent of the files before it. The store-only predicate's memo of
// seen switches needs no reset: it only remembers positives, keyed by a
// store root no later test reuses, and a test of what a new process
// answers asks one (`tests/helpers/fresh-process.ts`).
beforeEach(() => {
  clearOriginChannel();
  forgetMachineStateCache();
  rmSync(storeWriteStatusPath(), { force: true });
});

/**
 * Recursive removal that rides out a transient Windows refusal (EBUSY,
 * EPERM, ENOTEMPTY while a handle is still closing) instead of failing on
 * the first attempt. The retries are a no-op where the first attempt works.
 */
const REMOVE_TREE = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

// The suite runs under a real device id (see the header): a store write
// needs one, and an empty id is the explicit "no device id" a test opts
// into.
if (process.env["O2B_DEVICE_ID"] === undefined) {
  process.env["O2B_DEVICE_ID"] = TEST_DEVICE_ID;
}

// Under CI's test watchdog, every process writes down which file and test
// it is running, so a run that stops making progress names the test that
// held it (`tests/helpers/inflight-recorder.ts`). Off for a local run.
installInflightRecorder();

// A snapshot shells out to `tar` and `zstd` synchronously, and a child that
// never reports back blocks the whole test process: bun's per-test timeout
// cannot fire on a blocked thread, so the run went silent until the CI job
// timeout. The product bound is fifteen minutes (sized for a large vault);
// the suite's trees are tiny, so a minute here turns such a hang into a
// failure that names the tool. A test of the bound sets it itself. The name
// is spelled out rather than imported, so the preload every file pays for
// does not load the snapshot module's import graph; the snapshot tests pin
// it to `SNAPSHOT_TOOL_TIMEOUT_ENV`.
if (process.env["OPEN_SECOND_BRAIN_SNAPSHOT_TIMEOUT_MS"] === undefined) {
  process.env["OPEN_SECOND_BRAIN_SNAPSHOT_TIMEOUT_MS"] = "60000";
}

// Freshen-on-read starts a detached `o2b search index` whenever a search
// meets an index older than the interval. A test suite must never leave
// background indexers behind, so the default is off here; the tests of the
// feature own the variable while they run.
if (process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"] === undefined) {
  process.env["OPEN_SECOND_BRAIN_SEARCH_FRESHEN_INTERVAL_S"] = "0";
}

{
  const root = mkdtempSync(join(tmpdir(), "osb-test-default-"));
  // A preload's afterAll runs once, after the last file: the throwaway
  // default must not outlive the run that minted it.
  afterAll(() => rmSync(root, REMOVE_TREE));
  // No vault (design D14 item 16): a test that needs one makes it.
  const configPath = join(root, "config.yaml");
  writeFileSync(configPath, "");
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  // The vault resolves from `VAULT_DIR` before the config
  // (`src/core/config.ts` `resolveVault`), and the host-backup hook also
  // reads `OPEN_SECOND_BRAIN_VAULT`: a developer shell that exports either
  // would hand every in-process call the real vault. A test that needs one
  // sets it itself.
  delete process.env["VAULT_DIR"];
  delete process.env["OPEN_SECOND_BRAIN_VAULT"];
}

// The brain store root defaults to a per-user data directory, and a store
// found there moves the search index into the store's device-local state
// (`src/core/search/brain-store/location.ts`). A developer machine that
// holds a real store, or exports OPEN_SECOND_BRAIN_STORE_ROOT to one (a
// documented user setting; an empty export falls back to the default
// root), would then change where every search test's index lives. So the
// suite always points the root at a directory that does not exist: no
// store is in use unless a test creates one and sets the variable itself.
{
  const storeParent = mkdtempSync(join(tmpdir(), "osb-test-store-root-"));
  afterAll(() => rmSync(storeParent, REMOVE_TREE));
  process.env["OPEN_SECOND_BRAIN_STORE_ROOT"] = join(storeParent, "store");
  // `o2b init --vault` creates the store (design D14 item 1). The CLI
  // harness gives every run that still names this default root a store
  // root of its own (`tests/helpers/run-cli.ts`), so a store one test's
  // init creates is never seen by the next test.
  process.env[DEFAULT_STORE_ROOT_ENV] = join(storeParent, "store");
}

// The device-local state base (`src/core/platform-dirs.ts`) holds the
// brain store's per-store state, the store-only switch marker and the
// store-write counters. A test that writes the store without pointing
// XDG_STATE_HOME at a temp dir would otherwise put them in the developer's
// real `~/.local/state/open-second-brain/`, and a later doctor run (in a
// test or for real) would report another test's failures. Windows keeps
// that base under %LOCALAPPDATA%, redirected below.
//
// Always replaced, never kept from the run's environment (an exported
// value names the developer's real state).
{
  const stateRoot = mkdtempSync(join(tmpdir(), "osb-test-state-"));
  afterAll(() => rmSync(stateRoot, REMOVE_TREE));
  process.env["XDG_STATE_HOME"] = stateRoot;
}

// The per-user data base (`src/core/platform-dirs.ts`) is where the brain
// store root and the OpenCode session spool default to. The store root is
// pinned above, but a test that clears the variable (an empty export falls
// back to the default root) or a spool writer would otherwise reach the
// developer's real `~/.local/share/open-second-brain/`. Windows keeps it
// under %LOCALAPPDATA%, redirected below.
//
// Always replaced, like the state root above.
{
  const dataRoot = mkdtempSync(join(tmpdir(), "osb-test-data-"));
  afterAll(() => rmSync(dataRoot, REMOVE_TREE));
  process.env["XDG_DATA_HOME"] = dataRoot;
}

// Windows keeps the per-user config/state/cache roots under
// `%LOCALAPPDATA%` (and a few host-agent roots, e.g. Cursor's sessions,
// under `%APPDATA%`) - see `src/core/platform-dirs.ts`. Suites isolate
// themselves the POSIX way, by pointing HOME or XDG_* at a temp dir; on
// Windows a HOME-only redirect leaves `%LOCALAPPDATA%` naming the
// operator's REAL profile, and a test that mints a device id or an
// installation secret writes it into the real
// `%LOCALAPPDATA%\open-second-brain\config.yaml`. Redirecting both roots to
// a throwaway directory for the whole process gives Windows the same
// safe default the XDG layout gets from a temp HOME. A test that needs a
// specific root still sets the variable itself.
//
// Like every override in this file, it reaches only this process and
// children spawned with an explicit `env: { ...process.env }`: Bun hands a
// child without one the environment the process started with.
if (process.platform === "win32") {
  const appRoot = mkdtempSync(join(tmpdir(), "osb-test-appdata-"));
  afterAll(() => rmSync(appRoot, REMOVE_TREE));
  for (const name of ["LOCALAPPDATA", "APPDATA"] as const) {
    const dir = join(appRoot, name);
    mkdirSync(dir, { recursive: true });
    process.env[name] = dir;
  }
}

// The signal dedup index keeps a machine-local cache under the user cache
// directory (`src/core/brain/dedup-index-cache.ts`). Every capture test
// would otherwise leave one file per throwaway vault in the developer's
// real cache, so the suite points it at a root of its own.
// Always replaced, like the state root above.
{
  const cacheRoot = mkdtempSync(join(tmpdir(), "osb-test-dedup-cache-"));
  afterAll(() => rmSync(cacheRoot, REMOVE_TREE));
  process.env["OPEN_SECOND_BRAIN_DEDUP_CACHE_DIR"] = cacheRoot;
}

// The `install --check` handshake asks a host what it registered by running
// its real CLI (`codex mcp list`, `copilot mcp list`). The Copilot CLI ships
// a Node runtime of its own that enables the V8 compile cache, and with
// NODE_COMPILE_CACHE unset Node defaults that to `<tmpdir>/node-compile-cache`
// - under the inherited TMPDIR, which below is the guarded per-run root. On
// a machine with copilot installed (none on CI, where the probe skips as
// binary-missing) the run then failed blaming a temp entry no test minted.
// The foreign runtime honors Node's own variable, so the suite points the
// cache at a root of its own with the same teardown: the write lands where
// the leftover guard does not look, and the guard itself stays as strict as
// it was - every other leftover still fails the run.
if (process.env["NODE_COMPILE_CACHE"] === undefined) {
  const nodeCacheRoot = mkdtempSync(join(tmpdir(), "osb-test-node-compile-cache-"));
  afterAll(() => rmSync(nodeCacheRoot, REMOVE_TREE));
  process.env["NODE_COMPILE_CACHE"] = nodeCacheRoot;
}

// The embedding settings resolve from `OPEN_SECOND_BRAIN_EMBEDDING_*`
// twins of the config keys (model, provider, key, price pair, cost gate).
// A developer who exports one for daily use would otherwise change what
// every config-resolving test means, so the suite starts without them. A
// run that wants them kept sets `O2B_TEST_KEEP_EMBEDDING_ENV=1`; a test
// that needs one sets it itself.
if (process.env["O2B_TEST_KEEP_EMBEDDING_ENV"] !== "1") {
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("OPEN_SECOND_BRAIN_EMBEDDING_")) delete process.env[name];
  }
}

// The markdown neutralization gate resolves from an env twin of its
// config key (`neutralize-markdown.ts`), and the default posture of a
// dozen seam and doctor tests depends on it staying `off`. A developer
// who exports it for daily use would flip what those tests mean, so the
// suite starts without it - the same sweep the embedding twins get. A
// run that wants it kept sets `O2B_TEST_KEEP_NEUTRALIZE_MODE_ENV=1`; a
// test that needs a mode sets it itself.
if (
  process.env["O2B_TEST_KEEP_NEUTRALIZE_MODE_ENV"] !== "1" &&
  process.env[MARKDOWN_NEUTRALIZE_MODE_ENV] !== undefined
) {
  delete process.env[MARKDOWN_NEUTRALIZE_MODE_ENV];
}

// Every temp entry a test mints lands under ONE per-run root, and the run
// fails if any of them is still there after the last file (issue #194).
//
// `os.tmpdir()` reads TMPDIR (TEMP/TMP on Windows) on every call, so
// redirecting them here reaches every `mkdtempSync(join(tmpdir(), ...))` in
// the suite and every child spawned with `env: { ...process.env }`. Created
// after the roots above, which own their own teardown and live outside it.
//
// The root is removed whether or not the guard fires, so a leaking test
// fails the run instead of filling the temp directory run after run. On
// Windows the leftovers are reported but do not fail the run: a removal
// there can be refused while a just-exited child's handle or a virus scan
// still holds a file, which says nothing about the test's cleanup, and the
// POSIX jobs already enforce the rule for the shared suite.
{
  const runRoot = mkdtempSync(join(tmpdir(), "osb-run-"));
  for (const name of ["TMPDIR", "TMP", "TEMP"] as const) process.env[name] = runRoot;
  afterAll(() => {
    let leftovers: string[] = [];
    try {
      leftovers = readdirSync(runRoot).toSorted();
    } catch {
      // Nothing listable is nothing to report; the removal below still runs.
    }
    try {
      rmSync(runRoot, REMOVE_TREE);
    } catch (err) {
      // Windows can refuse the removal while a just-exited child's handle
      // or a scanner still holds a file; that is reported, not fatal.
      if (process.platform !== "win32") throw err;
      console.warn(`warning: could not remove ${runRoot}: ${(err as Error).message}`);
    }
    if (leftovers.length === 0) return;
    const message =
      `${leftovers.length} temp entries outlived the test that made them: ` +
      `${leftovers.join(", ")}. Remove each in afterEach/afterAll ` +
      `(tests/helpers/temp-dir.ts).`;
    if (process.platform === "win32") console.warn(`warning: ${message}`);
    else throw new Error(message);
  });
}
