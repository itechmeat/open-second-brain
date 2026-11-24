/**
 * One simulated machine for the update end-to-end tests: its own HOME,
 * XDG folders, machine config and device id, and a vault copied from a
 * fixture written by Open Second Brain 1.98.0. No `store_root` is set, so
 * the brain store takes its default place in the vault. A session start
 * runs the real hook as a child process; the worker it starts is real, and
 * a test waits for the worker's log to name its last step (a file watch
 * with a deadline, no timed sleep). The only thing two machines share is
 * the vault, through {@link copyVault}.
 */
import { expect } from "bun:test";
import {
  cpSync,
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

import { autoLegacyRemovalLogPath } from "../../../src/core/store-migration/auto-removal.ts";
import {
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
  const walk = (dir: string): void => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".jsonl")) {
        for (const line of readFileSync(p, "utf8").split("\n")) {
          if (line.trim() !== "") ids.add((JSON.parse(line) as { id: string }).id);
        }
      }
    }
  };
  walk(root);
  return [...ids].toSorted();
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
