/**
 * The migration step of `ensureVaultCurrent` (change auto-store-migration,
 * decision D1): on an initialised legacy vault whose migration is
 * available and not opted out, the start claims the per-vault worker lock
 * and starts a detached `o2b brain migrate-store --auto` worker, on the
 * pattern of the self-heal upgrade worker. A live claim makes a start skip
 * without waiting (the start never waits on the worker, by construction);
 * a fresh install starts nothing; a switched machine skips the step.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { listMetrics } from "../../../src/core/brain/metrics.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { forgetMachineStateCache } from "../../../src/core/state/machine-state.ts";
import {
  holdMigrationGate,
  migrationGatePath,
  releaseMigrationGate,
} from "../../../src/core/migration-gate.ts";
import { acquireDirLock } from "../../../src/core/store/local-lock.ts";
import { STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import {
  ensureVaultCurrent,
  AUTO_MIGRATION_SPAWN,
} from "../../../src/core/maintenance/ensure-current.ts";
import {
  autoMigrationLockPath,
  autoMigrationStatePath,
  claimAutoMigrationLock,
  readAutoMigrationFailure,
  recordAutoMigrationFailure,
  releaseAutoMigrationLock,
} from "../../../src/core/store-migration/auto-state.ts";
import { BENCH_DEVICE } from "../store-migration/fixtures/migration-env";
import { brainManualPath } from "../../../src/core/brain/paths.ts";
import {
  claimSelfHealUpgradeLock,
  releaseSelfHealUpgradeLock,
  selfHealUpgradeLockPath,
} from "../../../src/core/maintenance/self-heal-upgrade-state.ts";
import {
  AUTO_MIGRATION_OUTCOME,
  AUTO_MIGRATION_SURFACE,
  runAutoStoreMigration,
} from "../../../src/core/store-migration/auto-worker.ts";

/** A claim token no worker holds. */
const FOREIGN_CLAIM = "not-the-claim";

const START_CHILD = join(import.meta.dir, "fixtures", "ensure-start-child.ts");

// The spawned-worker test waits for a detached child; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(60_000);

let root: string;
let vault: string;
let storeRoot: string;
let configPath: string;
/** The worker lock's path: one place on every layout. */
let lockPath: string;
/**
 * The managed-file upgrade worker's lock, captured while the machine is
 * unswitched: that worker's state still follows the machine-state root.
 */
let upgradeLockPath: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "o2b-ensure-auto-"));
  vault = join(root, "vault");
  storeRoot = join(root, "store");
  configPath = join(root, "config.yaml");
  for (const key of [
    STORE_ROOT_ENV,
    "O2B_DEVICE_ID",
    "OPEN_SECOND_BRAIN_CONFIG",
    "OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION",
    "OPEN_SECOND_BRAIN_STORE_DUAL_WRITE",
  ]) {
    savedEnv[key] = process.env[key];
  }
  process.env[STORE_ROOT_ENV] = storeRoot;
  process.env["O2B_DEVICE_ID"] = BENCH_DEVICE;
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  delete process.env["OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION"];
  delete process.env["OPEN_SECOND_BRAIN_STORE_DUAL_WRITE"];
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
  lockPath = autoMigrationLockPath(vault);
  upgradeLockPath = selfHealUpgradeLockPath(vault);
});

/** The pid a worker lock names, or null. */
function lockHolder(path: string): number | null {
  try {
    const pid = (JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown }).pid;
    return typeof pid === "number" ? pid : null;
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  // No worker outlives its fixture. A detached worker of the spawned case
  // releases its lock when it ends (its completion event); one still
  // running at the deadline is stopped by the pid its lock names (the
  // claim is handed to the worker's pid), and waited for, before the tree
  // goes away.
  const holders = new Set<number>();
  const deadline = Date.now() + 50_000;
  while ((existsSync(lockPath) || existsSync(upgradeLockPath)) && Date.now() < deadline) {
    for (const path of [lockPath, upgradeLockPath]) {
      const pid = lockHolder(path);
      if (pid !== null && pid !== process.pid) holders.add(pid);
    }
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(50);
  }
  for (const pid of holders) {
    if (!alive(pid)) continue;
    process.kill(pid, "SIGKILL");
    // Bounded: a pid the system has already handed to another process
    // stays "alive" here, and this hook must still end.
    const killed = Date.now() + 10_000;
    while (alive(pid) && Date.now() < killed) {
      // eslint-disable-next-line no-await-in-loop
      await Bun.sleep(20);
    }
  }
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  forgetMachineStateCache();
  // A start also hands a stale search index to a detached reindex, which no
  // lock here names and which may still write into the vault for a moment.
  // It holds the index database open until it ends: POSIX removes an open
  // file, Windows refuses (EBUSY) until the child exits. Its paired outcome
  // row is no completion event to wait on here: a migration worker started
  // by the same test may hold the gate or switch the machine while the
  // child runs, and the concurrent-start case was seen with the pair
  // missing. So a busy tree is removed again until it is gone and stays
  // gone for a second.
  let quiet = 0;
  const settle = Date.now() + 60_000;
  while (quiet < 4 && Date.now() < settle) {
    if (existsSync(root)) {
      quiet = 0;
      try {
        rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "EBUSY" && code !== "EPERM" && code !== "ENOTEMPTY") throw e;
      }
    } else {
      quiet += 1;
    }
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(250);
  }
  expect(existsSync(root)).toBe(false);
}, 130_000);

describe("the migration step of ensureVaultCurrent", () => {
  test("a legacy vault whose migration is available starts a detached worker", async () => {
    const r = await ensureVaultCurrent(vault, { background: true, configPath });

    expect(r.migrationSpawn).toBe(AUTO_MIGRATION_SPAWN.spawned);
    // The claim is held until the worker ends; the afterEach wait covers it.
    expect(existsSync(autoMigrationLockPath(vault))).toBe(true);

    // The worker migrates the fixture and records its outcome; the lock's
    // release is its completion event.
    const deadline = Date.now() + 55_000;
    while (Date.now() < deadline && existsSync(autoMigrationLockPath(vault))) {
      // eslint-disable-next-line no-await-in-loop
      await Bun.sleep(100);
    }
    expect(listMetrics(vault, { surface: AUTO_MIGRATION_SURFACE }).length).toBeGreaterThan(0);
    expect(readAutoMigrationFailure(vault)).toBeNull();
  });

  test("a live claim on the worker lock: the start skips without waiting and starts nothing", () => {
    // A live worker's claim: fresh mtime, so not stale.
    const token = claimAutoMigrationLock(vault, new Date());
    expect(token).not.toBeNull();
    const before = listMetrics(vault, { surface: AUTO_MIGRATION_SURFACE }).length;

    return ensureVaultCurrent(vault, { background: true, configPath }).then((r) => {
      expect(r.migrationSpawn).toBe(AUTO_MIGRATION_SPAWN.skippedRunning);
      expect(listMetrics(vault, { surface: AUTO_MIGRATION_SURFACE })).toHaveLength(before);
      // The claim is left exactly as it was: the start waited on nothing.
      expect(existsSync(autoMigrationLockPath(vault))).toBe(true);
      releaseAutoMigrationLock(vault, token!);
    });
  });

  test("a live migration holding the gate starts no worker", async () => {
    // This process holds the gate, as a manual run would.
    holdMigrationGate(vault, "manual-run");
    try {
      const r = await ensureVaultCurrent(vault, { background: true, configPath });
      expect(r.migrationSpawn).toBe(AUTO_MIGRATION_SPAWN.skippedRunning);
      expect(existsSync(autoMigrationLockPath(vault))).toBe(false);
    } finally {
      releaseMigrationGate(vault, "manual-run");
    }
  });

  test("a recorded failure inside its cooldown starts nothing", async () => {
    recordAutoMigrationFailure(vault, "unmapped entry", {
      manualCommand: "o2b brain migrate-store --dry-run",
      now: new Date(),
    });

    const r = await ensureVaultCurrent(vault, { background: true, configPath });

    expect(r.migrationSpawn).toBe(AUTO_MIGRATION_SPAWN.skippedBackoff);
    expect(existsSync(autoMigrationLockPath(vault))).toBe(false);
  });

  test("the opt-out starts nothing", async () => {
    process.env["OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION"] = "false";

    const r = await ensureVaultCurrent(vault, { background: true, configPath });

    expect(r.migrationSpawn).toBe(AUTO_MIGRATION_SPAWN.disabled);
    expect(existsSync(autoMigrationLockPath(vault))).toBe(false);
    expect(existsSync(storeRoot)).toBe(false);
  });

  test("a vault with no legacy data starts nothing and creates no store", async () => {
    // A fresh bootstrap: the signal of the setup is what made this vault
    // legacy, so rebuild the brain files without it.
    rmSync(vault, { recursive: true, force: true });
    mkdirSync(vault, { recursive: true });
    bootstrapBrain(vault, { configPath });

    const r = await ensureVaultCurrent(vault, { background: true, configPath });

    expect(r.migrationSpawn).toBe(AUTO_MIGRATION_SPAWN.notAvailable);
    expect(existsSync(storeRoot)).toBe(false);
    expect(existsSync(autoMigrationLockPath(vault))).toBe(false);
  });

  test("a switched machine skips the step entirely", async () => {
    // Switch the machine by hand, the way a migration (or a fresh store
    // init) would, then start again: no probe, no worker, no trace.
    const { initStore } = await import("../../../src/core/store/store-init.ts");
    const { recordFreshInstallSwitch } = await import("../../../src/core/store/fresh-switch.ts");
    initStore({ root: storeRoot });
    rmSync(join(vault, "Brain", "inbox"), { recursive: true, force: true });
    recordFreshInstallSwitch({ vault, configPath });
    forgetMachineStateCache();

    const r = await ensureVaultCurrent(vault, { background: true, configPath });

    expect(r.migrationSpawn).toBeNull();
    expect(existsSync(autoMigrationStatePath(vault))).toBe(false);
  });

  test("the foreground mode runs the worker in the process", async () => {
    const r = await ensureVaultCurrent(vault, { background: false, configPath });

    expect(r.migrationSpawn).toBe(AUTO_MIGRATION_SPAWN.foreground);
    expect(listMetrics(vault, { surface: AUTO_MIGRATION_SURFACE })[0]?.payload["outcome"]).toBe(
      "applied",
    );
    expect(existsSync(autoMigrationLockPath(vault))).toBe(false);
  });

  test("an uninitialised vault is skipped before any probe", async () => {
    rmSync(brainConfigPath(vault));
    const r = await ensureVaultCurrent(vault, { background: true, configPath });
    expect(r.skipped).toBe("not-initialized");
    expect(r.migrationSpawn).toBeNull();
  });
});

describe("two starts at once", () => {
  test("two processes starting together start one worker", async () => {
    const barrier = join(root, "go");
    // The worker the first start spawns keeps its claim until both starts
    // have decided: it blocks on the migration gate's lock, which this test
    // holds until then (the gate file stays absent, so neither start sees a
    // migration running). Its claim cannot end early, so the starts overlap
    // it whatever the scheduling.
    mkdirSync(dirname(migrationGatePath()), { recursive: true });
    const releaseGate = acquireDirLock(migrationGatePath(), {
      staleMs: 120_000,
      budgetMs: 1000,
      label: "test",
      remedy: "test",
    });
    const child = (): ReturnType<typeof Bun.spawn> =>
      Bun.spawn([process.execPath, "run", START_CHILD, vault, configPath, barrier], {
        env: { ...process.env, OPEN_SECOND_BRAIN_LOCK_WAIT_MS: "60000" },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        timeout: 50_000,
      });
    const starts = [child(), child()];
    // Both children are loaded and polling before the barrier opens.
    const ready = () => starts.every((p) => existsSync(`${barrier}.ready-${p.pid}`));
    const deadline = Date.now() + 45_000;
    while (!ready() && Date.now() < deadline) {
      // eslint-disable-next-line no-await-in-loop
      await Bun.sleep(20);
    }
    let decisions: string[];
    try {
      expect(ready()).toBe(true);
      writeFileSync(barrier, "");
      decisions = await Promise.all(
        starts.map(async (p) => {
          await p.exited;
          return (await new Response(p.stdout as ReadableStream).text()).trim();
        }),
      );
    } finally {
      releaseGate();
    }

    // The lock decides: one start spawned the worker; the other found it
    // running and started nothing.
    expect(decisions.toSorted()).toEqual([
      AUTO_MIGRATION_SPAWN.skippedRunning,
      AUTO_MIGRATION_SPAWN.spawned,
    ]);
  });
});

describe("the managed-file upgrade and the migration", () => {
  test("a start that spawns the migration worker leaves the upgrade to it", async () => {
    const r = await ensureVaultCurrent(vault, { background: true, configPath });

    expect(r.migrationSpawn).toBe(AUTO_MIGRATION_SPAWN.spawned);
    // The migration worker runs the upgrade first; a second worker in the
    // same start would race it into the migration gate.
    expect(r.brainUpgradeSpawn).toBeNull();
  });

  test("a start while the migration worker runs starts no upgrade worker", async () => {
    const token = claimAutoMigrationLock(vault, new Date());
    expect(token).not.toBeNull();
    try {
      const r = await ensureVaultCurrent(vault, { background: true, configPath });

      expect(r.migrationSpawn).toBe(AUTO_MIGRATION_SPAWN.skippedRunning);
      expect(r.brainUpgradeSpawn).toBeNull();
      expect(existsSync(upgradeLockPath)).toBe(false);
    } finally {
      releaseAutoMigrationLock(vault, token!);
    }
  });

  test("an opted-out machine still gets its upgrade worker", async () => {
    process.env["OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION"] = "false";

    const r = await ensureVaultCurrent(vault, { background: true, configPath });

    expect(r.migrationSpawn).toBe(AUTO_MIGRATION_SPAWN.disabled);
    expect(r.brainUpgradeSpawn).toBe("spawned");
  });

  test("the worker brings the managed files up to date before it migrates", () => {
    writeFileSync(brainManualPath(vault), "stale operator copy\n");

    const run = runAutoStoreMigration(vault, { configPath });

    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    expect(readFileSync(brainManualPath(vault), "utf8")).not.toBe("stale operator copy\n");
  });

  test("a live upgrade worker holds the attempt off without a record", () => {
    const token = claimSelfHealUpgradeLock(vault, new Date());
    expect(token).not.toBeNull();
    try {
      const run = runAutoStoreMigration(vault, { configPath });

      expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.running);
      expect(readAutoMigrationFailure(vault)).toBeNull();
      expect(listMetrics(vault, { surface: AUTO_MIGRATION_SURFACE })).toHaveLength(0);
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      releaseSelfHealUpgradeLock(vault, token!);
    }
  });
});

describe("the worker entry point's lock handling", () => {
  test("a foreign claim answers as running; the handed claim runs", () => {
    const token = claimAutoMigrationLock(vault, new Date());
    expect(token).not.toBeNull();

    // A wrong token means the claim was taken over by another process.
    const notOurs = runAutoStoreMigration(vault, { lockToken: FOREIGN_CLAIM });
    expect(notOurs.outcome).toBe(AUTO_MIGRATION_OUTCOME.running);
    expect(existsSync(autoMigrationLockPath(vault))).toBe(true);

    // The real claim runs the attempt in this process.
    const ours = runAutoStoreMigration(vault, { lockToken: token! });
    expect(ours.outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    // A handed claim covers the whole process: it is released on exit,
    // not here, so the test releases it itself. It is where it was taken,
    // although the attempt switched the machine.
    expect(existsSync(lockPath)).toBe(true);
    releaseAutoMigrationLock(vault, token!);
    expect(existsSync(lockPath)).toBe(false);
  });
});
