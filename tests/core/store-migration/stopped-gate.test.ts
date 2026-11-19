/**
 * The gate a stopped run leaves on a vault, as the automatic migration
 * judges and opens it: only a migration run's gate is the automatic
 * path's to resume or open (an interrupted rollback's is not), a gate it
 * could not open stays owed to the next start, the release answers true
 * only once the gate is gone, a failed cleanup never replaces the reason
 * a run stopped, and a live migration of another vault holds nothing of
 * this vault's back.
 *
 * The kills themselves (a gate left before the run is on record, a gate
 * left with the run in progress) are rows of the failure table
 * (`auto-failure-table-*.test.ts`); these cases plant the states a kill
 * leaves and reach what the table cannot (a busy gate lock, a removal
 * the file system refuses).
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { collectRuntimeNotices } from "../../../src/core/brain/runtime-notices.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import {
  AUTO_MIGRATION_SPAWN,
  planAutoMigrationStart,
} from "../../../src/core/maintenance/ensure-current.ts";
import {
  holdMigrationGate,
  migrationGatePath,
  readMigrationGate,
} from "../../../src/core/migration-gate.ts";
import { acquireDirLock } from "../../../src/core/store/local-lock.ts";
import { forgetMachineStateCache } from "../../../src/core/state/machine-state.ts";
import { autoMigrationReport } from "../../../src/core/store-migration/auto-report.ts";
import {
  UPDATE_STORE_MIGRATION,
  updateStoreMigration,
} from "../../../src/core/store-migration/update-step.ts";
import { ownMigrationRunRead } from "../../../src/core/store-migration/auto-probe.ts";
import { migrationAvailability } from "../../../src/core/store/migration-availability.ts";
import {
  AUTO_MIGRATION_ROLLBACK_COMMAND,
  AUTO_MIGRATION_SELF_CLAIM,
  readAutoMigrationFailure,
  recordAutoMigrationAttempt,
  recordAutoMigrationFailure,
} from "../../../src/core/store-migration/auto-state.ts";
import {
  AUTO_MIGRATION_OUTCOME,
  runAutoStoreMigration,
} from "../../../src/core/store-migration/auto-worker.ts";
import { migrationDir, writeMigrationState } from "../../../src/core/store-migration/journal.ts";
import { MigrationRefusedError, runMigration } from "../../../src/core/store-migration/migrate.ts";
import { releaseStoppedRunGate } from "../../../src/core/store-migration/quiesce.ts";
import {
  dropUnparseable,
  makeMigrationBench,
  type MigrationBench,
} from "./fixtures/migration-env.ts";

setDefaultTimeout(60_000);

const AUTO_ENV = "OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION";
const LOCK_WAIT_ENV = "OPEN_SECOND_BRAIN_LOCK_WAIT_MS";
const RUN = "migrate-20261118T090000000Z";

let bench: MigrationBench;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of [AUTO_ENV, LOCK_WAIT_ENV]) saved.set(key, process.env[key]);
  process.env[AUTO_ENV] = "true";
  // A held gate lock is given up at once instead of after the default wait.
  process.env[LOCK_WAIT_ENV] = "200";
  bench = makeMigrationBench("osb-stopped-gate-");
  dropUnparseable(bench.vault);
  forgetMachineStateCache();
});

afterEach(() => {
  bench.cleanup();
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  saved.clear();
});

/** The pid of a process that ran and is gone. */
function deadPid(): number {
  return Bun.spawnSync([process.execPath, "-e", "0"], { stdin: "ignore" }).pid;
}

/** The gate a run killed on this vault leaves: its holder is gone. */
function plantDeadGate(runId: string): void {
  const path = migrationGatePath();
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(
    path,
    JSON.stringify({
      vault: resolve(bench.vault),
      run_id: runId,
      since: new Date().toISOString(),
      pid: deadPid(),
    }),
  );
}

/** This machine's run, still in progress (killed before its switch). */
function plantRunInProgress(runId: string): void {
  const at = new Date().toISOString();
  writeMigrationState(migrationDir(bench.store()), {
    run_id: runId,
    phase: "in-progress",
    started_at: at,
    updated_at: at,
    backed_up: false,
  });
}

/** An automatic attempt that started and never reported how it ended. */
function plantAttempt(): void {
  recordAutoMigrationAttempt(bench.vault, new Date());
}

/** An entry no surface maps: every dry run refuses from now on. */
function strayEntry(): void {
  writeFileSync(join(bench.vault, "Brain", "log", "stray.txt"), "no mapping covers this\n");
}

/** What the report says the next start does. */
function nextStart(): string {
  forgetMachineStateCache();
  return autoMigrationReport({ vault: bench.vault }).nextStart;
}

function plan(): string | null {
  forgetMachineStateCache();
  return planAutoMigrationStart(bench.vault, undefined, new Date(), false);
}

/** Hold the gate's lock as a live run taking the gate would. */
function holdGateLock(): () => void {
  return acquireDirLock(migrationGatePath(), {
    staleMs: 60_000,
    budgetMs: 1000,
    label: "test",
    remedy: "test",
  });
}

describe("whose gate a stopped attempt left", () => {
  test("its own run's gate is resumed, a gate no state names is opened", () => {
    plantRunInProgress(RUN);
    plantAttempt();
    plantDeadGate(RUN);
    expect(nextStart()).toBe("finishes the stopped run in the background");
    // A gate no state names: the migration goes on, taking it over.
    plantDeadGate("migrate-20261118T100000000Z");
    expect(nextStart()).toBe("goes on with the migration in the background");
  });

  test("an interrupted rollback's gate is not resumed by the automatic path", () => {
    plantRunInProgress(RUN);
    plantAttempt();
    const rollbackRun = `rollback-${RUN}`;
    plantDeadGate(rollbackRun);
    expect(nextStart()).not.toContain("stopped attempt");

    // Opted out: nothing starts, the rollback's gate stays as it is.
    process.env[AUTO_ENV] = "false";
    expect(plan()).toBe(AUTO_MIGRATION_SPAWN.disabled);
    expect(runAutoStoreMigration(bench.vault, { settleMs: 0 }).outcome).toBe(
      AUTO_MIGRATION_OUTCOME.disabled,
    );
    expect(readMigrationGate()?.run_id).toBe(rollbackRun);

    // On: the attempt refuses and names the rollback's own command.
    process.env[AUTO_ENV] = "true";
    const run = runAutoStoreMigration(bench.vault, { settleMs: 0 });
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.refused);
    expect(run.manualCommand).toBe(AUTO_MIGRATION_ROLLBACK_COMMAND);
    expect(readMigrationGate()?.run_id).toBe(rollbackRun);
  });
});

describe("a stopped run's gate the attempt could not open", () => {
  test("stays owed: the next start recovers it whatever the opt-out says", () => {
    plantRunInProgress(RUN);
    plantAttempt();
    plantDeadGate(RUN);
    strayEntry();
    const release = holdGateLock();
    let run;
    try {
      run = runAutoStoreMigration(bench.vault, { settleMs: 0 });
    } finally {
      release();
    }
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.refused);
    expect(readMigrationGate()?.run_id).toBe(RUN);
    // The refusal did not replace the attempt's record: the gate is owed.
    expect(readAutoMigrationFailure(bench.vault)?.attempt).toBe(true);

    process.env[AUTO_ENV] = "false";
    expect(plan()).toBe("start");
    runAutoStoreMigration(bench.vault, { settleMs: 0 });
    expect(readMigrationGate()).toBeNull();
    expect(readAutoMigrationFailure(bench.vault)?.attempt).toBe(false);
    expect(plan()).toBe(AUTO_MIGRATION_SPAWN.disabled);
  });

  test("the release answers true only once the gate is gone", () => {
    plantDeadGate(RUN);
    // A removal the file system refuses (a sharing violation on Windows).
    const refused = spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
    });
    try {
      expect(releaseStoppedRunGate(bench.vault, RUN)).toBe(false);
    } finally {
      refused.mockRestore();
    }
    expect(readMigrationGate()?.run_id).toBe(RUN);
    expect(releaseStoppedRunGate(bench.vault, RUN)).toBe(true);
    expect(readMigrationGate()).toBeNull();
  });

  test("a cleanup that fails never replaces the reason the run stopped", () => {
    plantRunInProgress(RUN);
    plantDeadGate(RUN);
    strayEntry();
    const release = holdGateLock();
    let thrown: unknown = null;
    try {
      runMigration(bench.vault, { resume: true, settleMs: 0 });
    } catch (err) {
      thrown = err;
    } finally {
      release();
    }
    expect(thrown).toBeInstanceOf(MigrationRefusedError);
    expect((thrown as Error).message).toContain("no destination");
    expect((thrown as Error).message).toContain("could not be opened");
  });
});

/** The store migration's failure line, as a session start shows it. */
function failureNotice(): string {
  return (
    collectRuntimeNotices(bench.vault, {
      configPath: bench.env["OPEN_SECOND_BRAIN_CONFIG"]!,
      env: {},
      oneTime: false,
    }).find((n) => n.code === "store_migration_failed")?.message ?? ""
  );
}

describe("the session start notice of a stopped attempt's gate", () => {
  test("says the next start goes on with it, not that it waits for the cooldown", () => {
    plantRunInProgress(RUN);
    plantAttempt();
    // What the next start does with the gate: its own run is finished; a
    // gate no state names is taken over by the migration when it is on,
    // and opened when it is off.
    for (const [gateRun, auto, says] of [
      [RUN, "true", "the next start finishes that run"],
      [RUN, "false", "the next start finishes that run"],
      ["migrate-20261118T100000000Z", "true", "the next start goes on with the migration"],
      ["migrate-20261118T100000000Z", "false", "the next start opens the gate"],
    ] as const) {
      plantDeadGate(gateRun);
      process.env[AUTO_ENV] = auto;
      expect([gateRun, auto, failureNotice()]).toEqual([
        gateRun,
        auto,
        expect.stringContaining(says),
      ]);
      expect(failureNotice()).not.toContain("tries again after");
      expect(failureNotice()).not.toContain("changed anything");
    }
  });
});

describe("a live migration of another vault", () => {
  test("starts no migration of this vault and does not own its upgrade", () => {
    holdMigrationGate(join(bench.fx.parent, "other-vault"), RUN, null);
    try {
      expect(plan()).toBe(AUTO_MIGRATION_SPAWN.otherVaultRunning);
    } finally {
      rmSync(migrationGatePath(), { force: true });
    }
    // The same live gate on this vault: its own migration owns the upgrade.
    holdMigrationGate(bench.vault, RUN, null);
    expect(plan()).toBe(AUTO_MIGRATION_SPAWN.skippedRunning);
  });
});

/** Whether this machine switched to the store. */
function switchedNow(): boolean {
  forgetMachineStateCache();
  const read = ownMigrationRunRead(bench.env["OPEN_SECOND_BRAIN_CONFIG"]);
  return read.kind === "run" && read.run.switched;
}

/** Remove every legacy item, keeping the tree's bootstrap file: nothing is left to migrate. */
function emptyPayload(): void {
  const brain = join(bench.vault, "Brain");
  for (const entry of fs.readdirSync(brain)) {
    if (entry !== "_brain.yaml") rmSync(join(brain, entry), { recursive: true, force: true });
  }
  expect(
    migrationAvailability({ vault: bench.vault, configPath: bench.env["OPEN_SECOND_BRAIN_CONFIG"] })
      .available,
  ).toBe(false);
}

/** A gate whose pid runs (this process) under another start identity, taken two days ago. */
function plantAgedReusedGate(runId: string): void {
  const path = migrationGatePath();
  mkdirSync(dirname(path), { recursive: true });
  atomicWriteFileSync(
    path,
    JSON.stringify({
      vault: resolve(bench.vault),
      run_id: runId,
      since: new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString(),
      pid: process.pid,
      started: "a process that ended long ago",
    }),
  );
}

describe("a stopped run's gate, row by row of the gate decision", () => {
  test("is opened when nothing is left to migrate", () => {
    plantRunInProgress(RUN);
    plantAttempt();
    plantDeadGate(RUN);
    emptyPayload();
    expect(plan()).toBe("start");
    expect(runAutoStoreMigration(bench.vault, { settleMs: 0 }).outcome).toBe(
      AUTO_MIGRATION_OUTCOME.notNeeded,
    );
    expect(readMigrationGate()).toBeNull();
    expect(plan()).toBe(AUTO_MIGRATION_SPAWN.notAvailable);
  });

  test("left by a refused attempt killed before it opened it, is recovered whatever the cooldown and the opt-out", () => {
    for (const auto of ["false", "true"]) {
      process.env[AUTO_ENV] = auto;
      plantRunInProgress(RUN);
      plantDeadGate(RUN);
      // The refusal's record, written before the gate was opened: no attempt marker.
      recordAutoMigrationFailure(bench.vault, "refused", {
        manualCommand: "o2b brain migrate-store",
        now: new Date(),
      });
      expect([auto, plan()]).toEqual([auto, "start"]);
      runAutoStoreMigration(bench.vault, { settleMs: 0, lockToken: AUTO_MIGRATION_SELF_CLAIM });
      expect([auto, readMigrationGate()]).toEqual([auto, null]);
      // Its cooldown still stands: nothing more starts.
      expect([auto, plan()]).toEqual([
        auto,
        auto === "true" ? AUTO_MIGRATION_SPAWN.skippedBackoff : AUTO_MIGRATION_SPAWN.disabled,
      ]);
    }
  });

  test("whose pid a later process reuses reaches the worker past the ceiling, under the opt-out", () => {
    process.env[AUTO_ENV] = "false";
    plantRunInProgress(RUN);
    plantAttempt();
    plantAgedReusedGate("migrate-20261118T100000000Z");
    // The start sees a live pid past the ceiling: only the worker's identity check tells.
    expect(plan()).toBe("start");
    runAutoStoreMigration(bench.vault, { settleMs: 0, lockToken: AUTO_MIGRATION_SELF_CLAIM });
    expect(readMigrationGate()).toBeNull();
    expect(plan()).toBe(AUTO_MIGRATION_SPAWN.disabled);
  });

  test("is opened, and nothing migrated, while the run state cannot be read", () => {
    plantAttempt();
    plantDeadGate(RUN);
    const dir = migrationDir(bench.store());
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "state.json"), "{ not json");
    const run = runAutoStoreMigration(bench.vault, { settleMs: 0 });
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.waiting);
    expect(run.wait?.reason).toContain("run state cannot be read");
    expect(readMigrationGate()).toBeNull();
    // Nothing ran over it: the state file is as it was, the machine legacy.
    expect(fs.readFileSync(join(dir, "state.json"), "utf8")).toBe("{ not json");
    expect(switchedNow()).toBe(false);
  });

  test("an opted-out worker decides again under its claim and leaves a gate another pass opened", () => {
    process.env[AUTO_ENV] = "false";
    plantRunInProgress(RUN);
    plantAttempt();
    plantDeadGate(RUN);
    const run = runAutoStoreMigration(bench.vault, {
      settleMs: 0,
      hooks: {
        atStep: (step) => {
          if (step !== "lock-claimed") return;
          // Meanwhile another pass refused the attempt and opened the gate.
          recordAutoMigrationFailure(bench.vault, "refused", {
            manualCommand: "o2b brain migrate-store",
            now: new Date(),
          });
          releaseStoppedRunGate(bench.vault, RUN);
        },
      },
    });
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.disabled);
    expect(switchedNow()).toBe(false);
  });
});

describe("every surface restates the gate decision", () => {
  test("a stopped gate with nothing left to migrate: the report and the doctor say the next start opens it", () => {
    plantRunInProgress(RUN);
    plantAttempt();
    plantDeadGate(RUN);
    emptyPayload();
    forgetMachineStateCache();
    const report = autoMigrationReport({ vault: bench.vault });
    expect(report.state).toBe("failed");
    expect(report.nextStart).toBe("opens the stopped run's gate in the background");
  });

  test("a dry run of an update an interrupted rollback holds back names the refusal and records nothing", () => {
    plantDeadGate(`rollback-${RUN}`);
    const dry = updateStoreMigration(bench.vault, { skip: false, dryRun: true });
    expect(dry.outcome).toBe(UPDATE_STORE_MIGRATION.refused);
    expect(dry.manual_command).toBe(AUTO_MIGRATION_ROLLBACK_COMMAND);
    expect(readAutoMigrationFailure(bench.vault)).toBeNull();
    expect(readMigrationGate()?.run_id).toBe(`rollback-${RUN}`);
  });

  test("an opted-out failure whose stopped gate the next start opens never says the run changed nothing", () => {
    process.env[AUTO_ENV] = "false";
    plantRunInProgress(RUN);
    recordAutoMigrationFailure(bench.vault, "an earlier attempt failed", {
      manualCommand: "o2b brain migrate-store",
      now: new Date(),
    });
    plantDeadGate(RUN);
    const line = failureNotice();
    expect(line).toContain("the next start opens the gate");
    expect(line).not.toContain("changed anything");
  });
});
