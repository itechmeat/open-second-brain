/**
 * One simulated machine for the update end-to-end tests: its own HOME,
 * XDG folders, machine config and device id, and a vault copied from a
 * fixture written by Open Second Brain 1.98.0. No `store_root` is set, so
 * the brain store takes its default place in the vault. A session start
 * runs the real hook as a child process; the worker it starts is real, and
 * a test waits for the worker's log to name its last step (a file watch
 * with a deadline, no timed sleep), then for the worker to have ended
 * ({@link workerExited}) before anything removes the machine's folders.
 * The only thing two machines share is the vault, through {@link copyVault}.
 */
import { expect } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  SELF_HEAL_REINDEX_SURFACE,
  SELF_HEAL_SPAWN,
} from "../../../src/core/maintenance/self-heal-reindex.ts";
import { STORE_VAULT_DIR } from "../../../src/core/store/constants.ts";
import { autoLegacyRemovalLogPath } from "../../../src/core/store-migration/auto-removal.ts";
import {
  autoMigrationLockPath,
  autoMigrationStateDir,
  autoMigrationWorkerLogPath,
} from "../../../src/core/store-migration/auto-state.ts";
import { homeEnv } from "../../helpers/platform.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(HERE, "..", "..", "..", "hooks", "active-inject.ts");
const CLI = resolve(HERE, "..", "..", "..", "src", "cli", "main.ts");
const PRELOAD = resolve(HERE, "..", "..", "hooks", "fixtures", "record-spawns-preload.ts");
/** How long a worker may take before a test gives up (a deadline, not a wait). */
const WORKER_DEADLINE_MS = 90_000;

export const REMOVE_TREE = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
} as const;

export interface Machine {
  readonly root: string;
  readonly vault: string;
  readonly env: Record<string, string>;
}

/** A fresh scratch parent for one test's machines. */
export function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** One machine under `parent/name`, its vault copied from `fixture`. */
export function machine(
  parent: string,
  name: string,
  fixture: string,
  device: string,
  extraConfig = "",
): Machine {
  const root = join(parent, name);
  const vault = join(root, "vault");
  mkdirSync(root, { recursive: true });
  cpSync(fixture, vault, { recursive: true });
  const config = join(root, "config", "open-second-brain", "config.yaml");
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(
    config,
    `vault: "${vault}"\nagent_name: "agent-${name}"\ndevice_id: "${device}"\n${extraConfig}`,
  );
  const env: Record<string, string> = {
    ...homeEnv(join(root, "home")),
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_CACHE_HOME: join(root, "cache"),
    OPEN_SECOND_BRAIN_CONFIG: config,
    O2B_DEVICE_ID: device,
    // The update itself: the automatic migration at its default (on), and
    // no store root, so the store takes its default place in the vault.
    OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION: "",
    OPEN_SECOND_BRAIN_STORE_ROOT: "",
    OPEN_SECOND_BRAIN_DREAM_AUTO: "false",
  };
  return { root, vault, env };
}

/** The vault one machine's Open Second Brain 1.98.0 wrote (`legacy-v1.98-vault`). */
const V198_VAULT = join(HERE, "legacy-v1.98-vault");
/** The device id that 1.98.0 install minted; its log shards carry it. */
const V198_DEVICE = "04181d83";

/** One machine on a fresh scratch parent, its vault the one 1.98.0 wrote. */
export function v198Machine(extraConfig = ""): { parent: string; machine: Machine } {
  const parent = scratch("osb-update-1x-");
  return { parent, machine: machine(parent, "a", V198_VAULT, V198_DEVICE, extraConfig) };
}

/** Run `read` with the machine's state folders, for paths this process computes. */
function asMachine<T>(m: Machine, read: () => T): T {
  const keys = ["XDG_STATE_HOME", "LOCALAPPDATA", "HOME"] as const;
  const saved = keys.map((k) => [k, process.env[k]] as const);
  for (const k of keys) {
    const value = m.env[k];
    if (value !== undefined) process.env[k] = value;
  }
  try {
    return read();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** The migration worker's log of the machine's vault. */
export function workerLog(m: Machine): string {
  return asMachine(m, () => autoMigrationWorkerLogPath(m.vault));
}

/** The automatic removal worker's log of the machine's vault. */
export function removalLog(m: Machine): string {
  return asMachine(m, () => autoLegacyRemovalLogPath(m.vault));
}

/**
 * Move the machine's last automatic removal attempt back by `minutes`,
 * standing for the time that passes before a start asks again.
 */
export function ageRemovalAttempt(m: Machine, minutes: number): void {
  const path = asMachine(m, () => join(autoMigrationStateDir(m.vault), "legacy-removal.json"));
  const state = JSON.parse(readFileSync(path, "utf8")) as { at: string };
  state.at = new Date(Date.parse(state.at) - minutes * 60_000).toISOString();
  writeFileSync(path, `${JSON.stringify(state)}\n`);
}

/** One session start, as the host runs it; returns the context it injects. */
export async function sessionStart(m: Machine, spawns: "run" | "record"): Promise<string> {
  const argv =
    spawns === "record" ? ["bun", "--preload", PRELOAD, HOOK] : [process.execPath, "run", HOOK];
  const proc = Bun.spawn(argv, {
    cwd: m.vault,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      ...m.env,
      ...(spawns === "record" ? { RECORD_SPAWNS_TO: join(m.root, "spawns.log") } : {}),
    },
  });
  proc.stdin.write(JSON.stringify({ hook_event_name: "SessionStart", source: "startup" }));
  await proc.stdin.end();
  const [stdout] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  expect(await proc.exited).toBe(0);
  if (stdout.trim() === "") return "";
  return (JSON.parse(stdout) as { hookSpecificOutput: { additionalContext: string } })
    .hookSpecificOutput.additionalContext;
}

/** One `o2b` command as a person runs it on the machine: a child process with its environment. */
export async function runO2b(
  m: Machine,
  args: ReadonlyArray<string>,
  extraEnv: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", CLI, ...args], {
    cwd: m.vault,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...m.env, ...extraEnv },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

/** The migration worker's last step: a view pass after the removal, or an outcome that ends it. */
export function migrationWorkerDone(text: string): boolean {
  if (/ outcome (?!applied)/.test(text)) return true;
  return (text.match(/ the human view: /g) ?? []).length >= 2;
}

/** The removal worker's last step: the view pass after the removal. */
export function removalWorkerDone(text: string): boolean {
  return (
    text.includes("the automatic removal of the legacy tree: ") &&
    (text.match(/ the human view: /g) ?? []).length >= 2
  );
}

/** Resolve with the log once `done` says so; reject at the deadline. */
export function logFinished(path: string, done: (text: string) => boolean): Promise<string> {
  mkdirSync(dirname(path), { recursive: true });
  return new Promise((resolveDone, reject) => {
    const read = (): string => {
      try {
        return readFileSync(path, "utf8");
      } catch {
        return "";
      }
    };
    const watcher = watch(dirname(path), () => check());
    const deadline = setTimeout(() => {
      watcher.close();
      reject(new Error(`the worker did not finish:\n${read()}`));
    }, WORKER_DEADLINE_MS);
    function check(): void {
      const text = read();
      if (!done(text)) return;
      clearTimeout(deadline);
      watcher.close();
      resolveDone(text);
    }
    check();
  });
}

/**
 * Resolve once the migration worker of `m` has ended. The worker holds the
 * claim the start handed it until its process ends and releases it there
 * (`auto-worker.ts`, a `process.once("exit")` hook). While its claim file
 * is there, that release takes its mutex by making the machine's state
 * folder chain: it is the worker's last write, and it comes after the last
 * line of the worker's log, which is all {@link logFinished} waits for. A
 * test that removes its scratch before this resolves races that release,
 * and when the release lands last the scratch is back (`tests/setup.ts`
 * fails the run on it).
 * The lock file's removal is the release's last write that can make a
 * folder (what follows only removes the mutex and the emptied folder), so
 * its absence is the sign; a file watch with a deadline, no timed sleep.
 * The watch starts before the first look, so a removal in between is
 * still seen; a folder already gone when the watch starts means the lock
 * went with it.
 */
export function workerExited(m: Machine): Promise<void> {
  const lock = asMachine(m, () => autoMigrationLockPath(m.vault));
  const read = (): string => {
    try {
      return readFileSync(lock, "utf8");
    } catch {
      return "";
    }
  };
  return new Promise((resolveGone, reject) => {
    let watcher: ReturnType<typeof watch> | null = null;
    let deadline: ReturnType<typeof setTimeout> | null = null;
    const end = (): void => {
      if (deadline !== null) clearTimeout(deadline);
      watcher?.close();
    };
    const check = (): void => {
      if (existsSync(lock)) return;
      end();
      resolveGone();
    };
    try {
      watcher = watch(dirname(lock), check);
      watcher.on("error", check);
    } catch (err) {
      // The folder is gone already, and so is the lock in it; anything
      // else ends the wait at once rather than leaving it unwatched.
      if (existsSync(lock)) reject(err);
      else resolveGone();
      return;
    }
    deadline = setTimeout(() => {
      end();
      reject(new Error(`the migration worker did not release its claim:\n${read()}`));
    }, WORKER_DEADLINE_MS);
    check();
  });
}

/**
 * Resolve once every index rebuild that a session start of `m` at or after
 * `since` handed to a detached child has recorded its end. Such a start,
 * finding the machine's search index missing or behind, spawns `o2b search
 * reindex --self-heal <run-id>` and records the spawn on the
 * `self_heal_reindex` metrics surface (`ensure-current.ts`); the child
 * appends its own records to the store (an `index` row, then its outcome
 * under the same run id) after the start has returned, and nothing else
 * the test waits on covers them. A vault copy taken before the outcome
 * lands leaves the newest record of the machine behind. The outcome is the
 * child's last record; a file watch with a deadline, no timed sleep.
 *
 * `since` keeps out a spawn whose child can record no end: a start that
 * also starts the store migration may hand a rebuild to a child whose rows
 * the migration's gate refuses (`self-heal-reindex.ts`, case 4).
 */
export function selfHealsSettled(m: Machine, since: Date): Promise<void> {
  const device = m.env["O2B_DEVICE_ID"];
  const from = since.toISOString();
  // A run seen spawned stays pending until a complete look at the store
  // shows its outcome: a look that had to leave a file or a line out
  // (`unread`) may have missed that outcome, so it never counts as the end.
  const spawned = new Set<string>();
  const scan = (): { pending: string[]; watch: string[]; complete: boolean } => {
    const ended = new Set<string>();
    const dirs = new Set<string>();
    const look = storeRecords(join(m.vault, STORE_VAULT_DIR), true);
    for (const { file, record } of look.records) {
      if (record.kind !== "ledger-row" || record.device !== device) continue;
      const row = (
        record.body as {
          row?: { surface?: unknown; run_at?: unknown; payload?: Record<string, unknown> };
        }
      ).row;
      if (row?.surface !== SELF_HEAL_REINDEX_SURFACE) continue;
      const runId = row.payload?.["run_id"];
      if (typeof runId !== "string") continue;
      dirs.add(dirname(file));
      if (row.payload?.["decision"] === SELF_HEAL_SPAWN.spawned) {
        if (typeof row.run_at === "string" && row.run_at >= from) spawned.add(runId);
      } else if (row.payload?.["outcome"] !== undefined) ended.add(runId);
    }
    for (const dir of look.unread) dirs.add(dir);
    return {
      pending: [...spawned].filter((id) => !ended.has(id)),
      watch: [...dirs],
      complete: look.unread.length === 0,
    };
  };
  const settled = (look: ReturnType<typeof scan>): boolean =>
    look.complete && look.pending.length === 0;
  if (settled(scan())) return Promise.resolve();
  return new Promise((resolveSettled, reject) => {
    // The child writes its outcome into the shard folder its parent wrote
    // the spawn into (one ledger per device); a folder where a look left
    // something out is watched too, since the write that completes it
    // lands there.
    const watchers = new Map<string, ReturnType<typeof watch>>();
    let done = false;
    const watchNew = (dirs: string[]): boolean => {
      let added = false;
      for (const dir of dirs) {
        if (watchers.has(dir)) continue;
        try {
          const w = watch(dir, () => check());
          w.on("error", () => check());
          watchers.set(dir, w);
          added = true;
        } catch {
          // Gone already: the next look does not list it.
        }
      }
      return added;
    };
    const close = (): void => {
      for (const w of watchers.values()) w.close();
    };
    const deadline = setTimeout(() => {
      done = true;
      close();
      const look = scan();
      const left = look.pending.join(", ") || "none seen";
      const partial = look.complete ? "" : " (the last look at the store was incomplete)";
      reject(new Error(`index rebuilds never recorded their end: ${left}${partial}`));
    }, WORKER_DEADLINE_MS);
    function check(): void {
      if (done) return;
      let look = scan();
      // A folder first named by this look is watched and then looked at
      // once more, so a write into it before its watch started is seen.
      while (watchNew(look.watch)) look = scan();
      if (!settled(look)) return;
      done = true;
      clearTimeout(deadline);
      close();
      resolveSettled();
    }
    check();
  });
}

/**
 * Copy the vault of `from` over the vault of `to`, as a sync tool would:
 * every file, hidden folders too, the newer copy wins, nothing deleted.
 * The device-local `.open-second-brain/` folder never travels.
 */
export function copyVault(from: Machine, to: Machine): void {
  const walk = (src: string, dst: string): void => {
    for (const name of readdirSync(src)) {
      if (src === from.vault && name === ".open-second-brain") continue;
      const s = join(src, name);
      const d = join(dst, name);
      const st = statSync(s);
      if (st.isDirectory()) {
        mkdirSync(d, { recursive: true });
        walk(s, d);
        continue;
      }
      let newer = true;
      try {
        newer = statSync(d).mtimeMs < st.mtimeMs;
      } catch {
        // not there yet
      }
      if (newer) cpSync(s, d, { preserveTimestamps: true });
    }
  };
  walk(from.vault, to.vault);
}

/** Every record id in the vault's store folder, sorted. */
export function recordIds(m: Machine): string[] {
  return recordIdsUnder(join(m.vault, ".open-second-brain-store"));
}

/** Every record id in the store at `root`, sorted. */
export function recordIdsUnder(root: string): string[] {
  const ids = new Set<string>();
  for (const { record } of storeRecords(root).records) ids.add(record.id);
  return [...ids].toSorted();
}

interface StoreRecord {
  readonly id: string;
  readonly kind?: string;
  readonly device?: string;
  readonly body?: unknown;
}

/**
 * Every record line in the store at `root`, with the shard file it is in.
 * `live`: writers may still be at work, so a file or folder that goes while
 * it is read and a line not yet whole are left out (the write that
 * completes them is seen by the next look), and `unread` names the folder
 * each was left out of; otherwise either fails the read. A store not made
 * yet is an empty store.
 */
function storeRecords(
  root: string,
  live = false,
): { records: Array<{ file: string; record: StoreRecord }>; unread: string[] } {
  const records: Array<{ file: string; record: StoreRecord }> = [];
  const unread = new Set<string>();
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      if (live && !(dir === root && (err as NodeJS.ErrnoException).code === "ENOENT")) {
        unread.add(dir === root ? root : dirname(dir));
      }
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      let text: string | null = null;
      try {
        if (statSync(p).isDirectory()) {
          walk(p);
          continue;
        }
        if (name.endsWith(".jsonl")) text = readFileSync(p, "utf8");
      } catch (err) {
        if (!live) throw err;
        unread.add(dir);
      }
      if (text === null) continue;
      for (const line of text.split("\n")) {
        if (line.trim() === "") continue;
        let record: StoreRecord;
        try {
          record = JSON.parse(line) as StoreRecord;
        } catch (err) {
          if (!live) throw err;
          unread.add(dir);
          continue;
        }
        records.push({ file: p, record });
      }
    }
  };
  walk(root);
  return { records, unread: [...unread] };
}

/** Entries under the machine's per-user data folder. */
export function dataFolderEntries(m: Machine): string[] {
  try {
    return readdirSync(join(m.root, "data"), { recursive: true }) as string[];
  } catch {
    return [];
  }
}

export function removeScratch(parent: string | null): void {
  if (parent !== null) rmSync(parent, REMOVE_TREE);
}
