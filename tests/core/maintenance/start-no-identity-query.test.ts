/**
 * A session start (or a server start) pays no subprocess for the automatic
 * store migration (change auto-store-migration): reading a process's start
 * identity can cost PowerShell on Windows or `ps` on macOS, so the start
 * path judges a held worker lock or a held migration gate by the pid and
 * the age alone, and leaves the exact identity check to the worker and the
 * manual verb.
 *
 * Pinned in every state a start meets: the identity query is spied on and
 * must not be called by `ensureVaultCurrent` or by the runtime notices.
 * The spawn of the worker itself (the one process a start may start) is
 * replaced by a stand-in, so no real worker runs here; it is counted.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { collectRuntimeNotices } from "../../../src/core/brain/runtime-notices.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { resetFreezeMarkerCache } from "../../../src/core/brain/freeze-marker.ts";
import { resetVaultIdentityPins } from "../../../src/core/brain/vault-identity.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import {
  AUTO_MIGRATION_SPAWN,
  ensureVaultCurrent,
} from "../../../src/core/maintenance/ensure-current.ts";
import { migrationGatePath } from "../../../src/core/migration-gate.ts";
import { forgetMachineStateCache } from "../../../src/core/state/machine-state.ts";
import { STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import {
  autoMigrationLockPath,
  recordAutoMigrationWaiting,
} from "../../../src/core/store-migration/auto-state.ts";
import { runAutoStoreMigration } from "../../../src/core/store-migration/auto-worker.ts";
import * as processIdentity from "../../../src/core/store-migration/process-identity.ts";

const DEVICE = "dev-a";
const ENV_KEYS = [
  STORE_ROOT_ENV,
  "O2B_DEVICE_ID",
  "OPEN_SECOND_BRAIN_CONFIG",
  "OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "LOCALAPPDATA",
  "APPDATA",
] as const;

let root: string;
let vault: string;
let configPath: string;
const saved = new Map<string, string | undefined>();
let identity: ReturnType<typeof spyOn<typeof processIdentity, "processStartIdentity">>;
let spawn: ReturnType<typeof spyOn<typeof Bun, "spawn">>;
/** A live process that is not this one, standing in for a running worker or migration. */
let holder: ReturnType<typeof Bun.spawn> | null = null;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osb-start-identity-"));
  vault = join(root, "vault");
  configPath = join(root, "config.yaml");
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  Object.assign(process.env, {
    [STORE_ROOT_ENV]: join(root, "store"),
    O2B_DEVICE_ID: DEVICE,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION: "true",
    XDG_STATE_HOME: join(root, "state"),
    XDG_DATA_HOME: join(root, "data"),
    LOCALAPPDATA: join(root, "state"),
    APPDATA: join(root, "data"),
  });
  resetFreezeMarkerCache();
  resetVaultIdentityPins();
  forgetMachineStateCache();
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  bootstrapBrain(vault, { configPath });
  writeSignal(vault, {
    topic: "legacy",
    signal: "positive",
    agent: "@a",
    principle: "A legacy signal to migrate",
    created_at: "2026-11-17T09:00:00.000Z",
    date: "2026-11-17",
    slug: "legacy-signal",
  });
});

afterEach(async () => {
  identity?.mockRestore();
  spawn?.mockRestore();
  if (holder !== null) {
    holder.kill();
    await holder.exited;
    holder = null;
  }
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
  resetFreezeMarkerCache();
  resetVaultIdentityPins();
  forgetMachineStateCache();
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function liveHolder(): number {
  holder = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 120000)"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  return holder.pid;
}

/** Spy on the identity query and stand in for every spawn; returns the worker spawns. */
function watchStart(): { workers: () => number } {
  identity = spyOn(processIdentity, "processStartIdentity");
  spawn = spyOn(Bun, "spawn").mockImplementation((() => ({
    pid: 2 ** 22 + 1,
    unref: () => {},
    // A worker that runs: its exit is never seen while the test runs.
    exited: new Promise<number>(() => {}),
    signalCode: null,
  })) as unknown as typeof Bun.spawn);
  return {
    workers: () =>
      spawn.mock.calls.filter((call) => (call[0] as string[]).includes("migrate-store")).length,
  };
}

async function start(): Promise<string | null> {
  forgetMachineStateCache();
  const result = await ensureVaultCurrent(vault, { configPath, background: true });
  collectRuntimeNotices(vault, { configPath, oneTime: true });
  return result.migrationSpawn;
}

describe("a start queries no process identity", () => {
  test("a legacy machine with no worker: it starts one", async () => {
    const watch = watchStart();
    expect(await start()).toBe(AUTO_MIGRATION_SPAWN.spawned);
    expect(watch.workers()).toBe(1);
    expect(identity).not.toHaveBeenCalled();
  });

  test("a legacy machine whose worker runs: it starts nothing", async () => {
    const pid = liveHolder();
    mkdirSync(dirname(autoMigrationLockPath(vault)), { recursive: true });
    writeFileSync(
      autoMigrationLockPath(vault),
      JSON.stringify({ token: "t", pid, started: "test:worker", since: new Date().toISOString() }),
    );
    const watch = watchStart();
    expect(await start()).toBe(AUTO_MIGRATION_SPAWN.skippedRunning);
    expect(watch.workers()).toBe(0);
    expect(identity).not.toHaveBeenCalled();
  });

  test("a legacy machine whose gate a live migration holds: it starts nothing", async () => {
    const pid = liveHolder();
    mkdirSync(dirname(migrationGatePath()), { recursive: true });
    writeFileSync(
      migrationGatePath(),
      JSON.stringify({
        vault,
        run_id: "migrate-live",
        since: new Date().toISOString(),
        pid,
        started: "test:migration",
      }),
    );
    const watch = watchStart();
    expect(await start()).toBe(AUTO_MIGRATION_SPAWN.skippedRunning);
    expect(watch.workers()).toBe(0);
    expect(identity).not.toHaveBeenCalled();
  });

  test("a machine waiting for another device's store: it starts nothing", async () => {
    recordAutoMigrationWaiting(
      vault,
      { missing: [], firstMachines: ["dev-b"], awaitsStore: true },
      new Date(),
    );
    const watch = watchStart();
    expect(await start()).toBe(AUTO_MIGRATION_SPAWN.waiting);
    expect(watch.workers()).toBe(0);
    expect(identity).not.toHaveBeenCalled();
  });

  test("a switched machine whose migration finished: it starts nothing", async () => {
    expect(runAutoStoreMigration(vault, { configPath }).outcome).toBe("applied");
    const watch = watchStart();
    expect(await start()).toBeNull();
    expect(watch.workers()).toBe(0);
    expect(identity).not.toHaveBeenCalled();
  });

  test("a switched machine whose switch did not finish: it starts the worker", async () => {
    runAutoStoreMigration(vault, {
      configPath,
      hooks: {
        atStep: (step) => {
          if (step === "device-switched") throw new Error("fault injection: device-switched");
        },
      },
    });
    const watch = watchStart();
    expect(await start()).toBe(AUTO_MIGRATION_SPAWN.spawned);
    expect(watch.workers()).toBe(1);
    expect(identity).not.toHaveBeenCalled();
  });

  test("a switched machine whose switch did not finish, while a live migration holds the gate", async () => {
    runAutoStoreMigration(vault, {
      configPath,
      hooks: {
        atStep: (step) => {
          if (step === "device-switched") throw new Error("fault injection: device-switched");
        },
      },
    });
    const pid = liveHolder();
    writeFileSync(
      migrationGatePath(),
      JSON.stringify({
        vault,
        run_id: "migrate-live",
        since: new Date().toISOString(),
        pid,
        started: "test:migration",
      }),
    );
    const watch = watchStart();
    expect(await start()).toBe(AUTO_MIGRATION_SPAWN.skippedRunning);
    expect(watch.workers()).toBe(0);
    expect(identity).not.toHaveBeenCalled();
  });
});

/** A gate path no read can answer (a directory where the file should be). */
function unreadableGate(): void {
  mkdirSync(migrationGatePath(), { recursive: true });
}

describe("a gate file that cannot be read", () => {
  test("a switched machine whose switch did not finish starts no worker, start after start", async () => {
    runAutoStoreMigration(vault, {
      configPath,
      hooks: {
        atStep: (step) => {
          if (step === "device-switched") throw new Error("fault injection: device-switched");
        },
      },
    });
    unreadableGate();
    const watch = watchStart();
    expect(await start()).toBe(AUTO_MIGRATION_SPAWN.skippedRunning);
    expect(await start()).toBe(AUTO_MIGRATION_SPAWN.skippedRunning);
    expect(watch.workers()).toBe(0);
  });

  test("a legacy machine starts no worker, start after start", async () => {
    unreadableGate();
    const watch = watchStart();
    expect(await start()).toBe(AUTO_MIGRATION_SPAWN.skippedRunning);
    expect(await start()).toBe(AUTO_MIGRATION_SPAWN.skippedRunning);
    expect(watch.workers()).toBe(0);
  });
});
