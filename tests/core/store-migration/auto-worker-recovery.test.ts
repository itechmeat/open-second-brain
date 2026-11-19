/**
 * How the automatic worker finishes what an attempt left: a pass that
 * finds the work already done by another one changes nothing, finishing
 * an interrupted switch binds only the vault that run migrated, each
 * success output (the metrics row, the brain log line, the one-time
 * notice) is written once and retried on its own, a notice a session
 * already showed is never shown again, a store that turns unreadable
 * between two reads is a wait, and conversion that meets an unparseable
 * item refuses the automatic switch.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import * as brainLog from "../../../src/core/brain/log.ts";
import { listMetrics } from "../../../src/core/brain/metrics.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { readMigrationGate } from "../../../src/core/migration-gate.ts";
import { forgetMachineStateCache } from "../../../src/core/state/machine-state.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { deviceSwitchedHere } from "../../../src/core/store/store-only.ts";
import * as storeOpen from "../../../src/core/store/store-open.ts";
import {
  autoMigrationLockPath,
  autoMigrationNoticePath,
  clearAutoMigrationNotice,
  clearAutoMigrationState,
  readAutoMigrationFailure,
  readAutoMigrationNotice,
  readAutoMigrationWaiting,
} from "../../../src/core/store-migration/auto-state.ts";
import {
  AUTO_MIGRATION_OUTCOME,
  AUTO_MIGRATION_STEP,
  AUTO_MIGRATION_SURFACE,
  runAutoStoreMigration,
  type RunAutoStoreMigrationOptions,
} from "../../../src/core/store-migration/auto-worker.ts";
import {
  AUTO_MIGRATION_SPAWN,
  planAutoMigrationStart,
} from "../../../src/core/maintenance/ensure-current.ts";
import { autoMigrationReport } from "../../../src/core/store-migration/auto-report.ts";
import { MIGRATION_STATE_FILE, migrationDir } from "../../../src/core/store-migration/journal.ts";
import { MIGRATION_STEP } from "../../../src/core/store-migration/migrate.ts";
import { migrateStore } from "../../../src/core/store-migration/outcome.ts";
import { vaultBindingStatus } from "../../../src/core/vault-adapter/vault-binding.ts";
import {
  BENCH_DEVICE,
  dropUnparseable,
  makeMigrationBench,
  type MigrationBench,
} from "./fixtures/migration-env.ts";

setDefaultTimeout(60_000);

const AUTO_ENV = "OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION";
let savedAuto: string | undefined;
let bench: MigrationBench;

beforeEach(() => {
  savedAuto = process.env[AUTO_ENV];
  process.env[AUTO_ENV] = "true";
  bench = makeMigrationBench("osb-auto-recovery-");
  dropUnparseable(bench.vault);
});

afterEach(() => {
  bench.cleanup();
  if (savedAuto === undefined) delete process.env[AUTO_ENV];
  else process.env[AUTO_ENV] = savedAuto;
});

/** The worker with no settle wait: nothing writes while it runs. */
function autoRun(opts: RunAutoStoreMigrationOptions = {}) {
  forgetMachineStateCache();
  return runAutoStoreMigration(bench.vault, { settleMs: 0, ...opts });
}

/** An attempt that switched this machine and stopped right after. */
function stopAfterSwitch(): void {
  const run = autoRun({
    hooks: {
      atStep: (step) => {
        if (step === MIGRATION_STEP.deviceSwitched) throw new Error("fault injection");
      },
    },
  });
  expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.failed);
  expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(true);
}

const rows = () => listMetrics(bench.vault, { surface: AUTO_MIGRATION_SURFACE });
const appliedRows = () => rows().filter((r) => r.payload["outcome"] === "applied");
const doneLines = () =>
  readPartition(join(bench.storeRoot, "shared"))
    .flatMap((shard) => shard.all)
    .filter((r) => r.kind === "log-event" && r.body["event_type"] === "store-migration-done");

describe("a pass that finds the switch already finished", () => {
  test("by another worker while it waited for the lock: it changes nothing", () => {
    stopAfterSwitch();
    const run = autoRun({
      hooks: {
        atStep: (step) => {
          if (step !== AUTO_MIGRATION_STEP.lockClaimed) return;
          // Another pass finished the switch and its records meanwhile.
          migrateStore(bench.vault, {});
          clearAutoMigrationState(bench.vault);
        },
      },
    });
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.notNeeded);
    expect(readAutoMigrationNotice(bench.vault)).toBeNull();
  });
});

describe("finishing an interrupted switch", () => {
  test("binds only the vault that run migrated, never one configured since", () => {
    // Another vault with legacy data of its own, which this switch never touched.
    const other = join(bench.fx.parent, "vault-b");
    bootstrapBrain(other, {});
    writeSignal(other, {
      topic: "b",
      signal: "positive",
      agent: "@b",
      principle: "A legacy signal of vault B",
      created_at: "2026-11-17T09:00:00.000Z",
      date: "2026-11-17",
      slug: "b-signal",
    });
    stopAfterSwitch();
    // It is configured now, and the automatic migration is off.
    const configPath = bench.env["OPEN_SECOND_BRAIN_CONFIG"]!;
    writeFileSync(configPath, `vault: ${other}\n`);
    process.env[AUTO_ENV] = "false";
    forgetMachineStateCache();
    runAutoStoreMigration(other, { settleMs: 0 });
    expect(vaultBindingStatus(bench.vault, { configPath }).state).toBe("match");
    expect(vaultBindingStatus(other, { configPath }).state).not.toBe("match");
    // Nothing of vault B was imported: its transition is the manual command's.
    expect(
      bench.records().some((r) => JSON.stringify(r.body).includes("A legacy signal of vault B")),
    ).toBe(false);
    expect(readMigrationGate()).toBeNull();
  });
});

describe("the success outputs", () => {
  test("a log line that could not be written is written by the next pass, the row is not", () => {
    const failing = spyOn(brainLog, "appendLogEvent").mockImplementation(() => {
      throw new Error("EIO: the log cannot be written");
    });
    try {
      expect(autoRun().outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    } finally {
      failing.mockRestore();
    }
    expect(appliedRows()).toHaveLength(1);
    expect(doneLines()).toHaveLength(0);
    // The attempt is kept until every output is written.
    expect(readAutoMigrationFailure(bench.vault)?.attempt).toBe(true);

    autoRun();
    expect(appliedRows()).toHaveLength(1);
    expect(doneLines()).toHaveLength(1);
    expect(readAutoMigrationFailure(bench.vault)).toBeNull();
    autoRun();
    expect(appliedRows()).toHaveLength(1);
    expect(doneLines()).toHaveLength(1);
  });

  test("a notice a session showed before the attempt's record was cleared is not shown again", () => {
    const run = autoRun({
      hooks: {
        atStep: (step) => {
          if (step !== AUTO_MIGRATION_STEP.noticeWritten) return;
          // A session shows the notice, then the worker stops.
          expect(readAutoMigrationNotice(bench.vault)).not.toBeNull();
          clearAutoMigrationNotice(bench.vault);
          throw new Error("fault injection: stopped after the notice");
        },
      },
    });
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.failed);
    expect(autoRun().outcome).toBe(AUTO_MIGRATION_OUTCOME.applied);
    expect(readAutoMigrationNotice(bench.vault)).toBeNull();
    expect(readAutoMigrationFailure(bench.vault)).toBeNull();
    expect(appliedRows()).toHaveLength(1);
    expect(doneLines()).toHaveLength(1);
    // Nothing of it is left behind once the attempt is finished.
    expect(existsSync(autoMigrationNoticePath(bench.vault))).toBe(false);
  });

  test("a notice record that is not a plain object with a time is no notice", () => {
    const path = autoMigrationNoticePath(bench.vault);
    mkdirSync(dirname(path), { recursive: true });
    for (const text of ["[]", "{}", '{"at":"not a time","snapshot":null}', "null"]) {
      writeFileSync(path, text);
      expect([text, readAutoMigrationNotice(bench.vault)]).toEqual([text, null]);
    }
    writeFileSync(path, '{"at":"2026-11-18T12:00:00.000Z","snapshot":null}');
    expect(readAutoMigrationNotice(bench.vault)?.snapshot).toBeNull();
  });
});

describe("a store that turns unreadable between two reads", () => {
  test("is a wait, not a failure with a cooldown", () => {
    const real = storeOpen.inspectStore;
    let calls = 0;
    const flaky = spyOn(storeOpen, "inspectStore").mockImplementation((root: string) => {
      // The availability probe reads it fine; the preflight's read fails.
      calls += 1;
      if (calls > 1) throw new Error("a partition's metadata is being replaced by sync");
      return real(root);
    });
    let run;
    try {
      run = autoRun();
    } finally {
      flaky.mockRestore();
    }
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.waiting);
    expect(readAutoMigrationFailure(bench.vault)).toBeNull();
    expect(readAutoMigrationWaiting(bench.vault)?.reason).toContain("cannot be read");
  });
});

describe("an unparseable item that conversion meets", () => {
  test("refuses the automatic switch and leaves the machine on the legacy layout", () => {
    const run = autoRun({
      hooks: {
        afterBackup: () => {
          // A legacy writer added it after the dry run, before the gate.
          writeFileSync(join(bench.vault, "Brain", "log", "2026-11-02.dev-c.jsonl"), "{torn\n");
        },
      },
    });
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.refused);
    expect(run.error).toContain("cannot be parsed");
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(false);
    expect(readMigrationGate()).toBeNull();
  });
});

describe("a worker whose claim was taken over", () => {
  test("stops before it writes anything", () => {
    const run = autoRun({
      hooks: {
        atStep: (step) => {
          if (step !== AUTO_MIGRATION_STEP.dryRun) return;
          // Another process took the worker lock over meanwhile.
          writeFileSync(
            autoMigrationLockPath(bench.vault),
            JSON.stringify({ token: "another", pid: process.pid, started: null, since: "x" }),
          );
        },
      },
    });
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.running);
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(false);
    expect(readMigrationGate()).toBeNull();
  });
});

describe("a switched machine whose run state shows no switch", () => {
  test("no start spawns a worker for it, and the report names the manual run", () => {
    stopAfterSwitch();
    // The run state is gone: nothing will ever read it back as done.
    rmSync(join(migrationDir(bench.store()), MIGRATION_STATE_FILE), { force: true });
    expect(readAutoMigrationFailure(bench.vault)?.attempt).toBe(true);
    for (let start = 0; start < 2; start++) {
      forgetMachineStateCache();
      expect(planAutoMigrationStart(bench.vault, undefined, new Date(), true)).toBe(
        AUTO_MIGRATION_SPAWN.switchUnproven,
      );
    }
    // A worker run anyway changes nothing and answers the same.
    expect(autoRun().outcome).toBe(AUTO_MIGRATION_OUTCOME.refused);
    expect(readAutoMigrationFailure(bench.vault)?.attempt).toBe(true);
    const report = autoMigrationReport({ vault: bench.vault });
    expect(report.state).not.toBe("done");
    expect(report.manualCommand).toBe("o2b brain migrate-store");
  });
});
