/**
 * The automatic store migration's report (change auto-store-migration,
 * design D6): one state per machine - not needed, pending, running,
 * waiting, failed, done - with what the next start will do. The doctor,
 * the store status block, `o2b brain upgrade --dry-run` and the session
 * start notices all word their answer from it.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import {
  MIGRATION_AVAILABLE_CODE,
  STORE_MIGRATION_FAILED_CODE,
} from "../../../src/core/brain/doctor/migration-check.ts";
import { forgetMachineStateCache } from "../../../src/core/state/machine-state.ts";
import { vaultBindingPath } from "../../../src/core/vault-adapter/vault-binding.ts";

// One case runs a real migration (with its settle wait).
setDefaultTimeout(60_000);
import {
  claimAutoMigrationLock,
  recordAutoMigrationFailure,
  recordAutoMigrationWaiting,
  releaseAutoMigrationLock,
} from "../../../src/core/store-migration/auto-state.ts";
import {
  autoMigrationReport,
  AUTO_MIGRATION_STATE,
} from "../../../src/core/store-migration/auto-report.ts";
import { runAutoStoreMigration } from "../../../src/core/store-migration/auto-worker.ts";
import {
  dropUnparseable,
  makeMigrationBench,
  type MigrationBench,
} from "./fixtures/migration-env.ts";

const AUTO_ENV = "OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION";
/** A fixed clock: the report reads it, never advances it. */
const NOW = new Date("2026-11-18T12:00:00.000Z");

let bench: MigrationBench;
let savedAuto: string | undefined;
beforeEach(() => {
  savedAuto = process.env[AUTO_ENV];
  process.env[AUTO_ENV] = "true";
  bench = makeMigrationBench("osb-auto-report-");
  dropUnparseable(bench.vault);
});
afterEach(() => {
  bench.cleanup();
  if (savedAuto === undefined) delete process.env[AUTO_ENV];
  else process.env[AUTO_ENV] = savedAuto;
});

const report = () => autoMigrationReport({ vault: bench.vault, now: NOW });

describe("autoMigrationReport", () => {
  test("pending: the next start runs it", () => {
    const r = report();
    expect(r.state).toBe(AUTO_MIGRATION_STATE.pending);
    expect(r.automatic).toBe(true);
    expect(r.nextStart).toContain("runs the migration");
  });

  test("pending with the opt-out: offered, never run", () => {
    process.env[AUTO_ENV] = "false";
    const r = report();
    expect(r.state).toBe(AUTO_MIGRATION_STATE.pending);
    expect(r.automatic).toBe(false);
    expect(r.nextStart).toContain("auto_store_migration");
    expect(r.manualCommand).toBe("o2b brain migrate-store --dry-run");
  });

  test("running: since when and which process", () => {
    // Staleness compares the clock with the lock file's own mtime, so this
    // test reads the wall clock once and hands the same instant to both.
    const claimedAt = new Date();
    const token = claimAutoMigrationLock(bench.vault, claimedAt);
    try {
      const r = autoMigrationReport({ vault: bench.vault, now: claimedAt });
      expect(r.state).toBe(AUTO_MIGRATION_STATE.running);
      expect(r.pid).toBe(process.pid);
      expect(r.since).toBe(claimedAt.toISOString());
    } finally {
      releaseAutoMigrationLock(bench.vault, token!);
    }
  });

  test("waiting: for another device's cut", () => {
    recordAutoMigrationWaiting(
      bench.vault,
      { missing: ["shared/events/dev-b/2026-11.jsonl"], firstMachines: ["dev-b"] },
      NOW,
    );
    const r = report();
    expect(r.state).toBe(AUTO_MIGRATION_STATE.waiting);
    expect(r.message).toContain("dev-b");
    // What is missing, and what to do when it will not arrive by itself.
    expect(r.message).toContain("shared/events/dev-b/2026-11.jsonl");
    expect(r.message).toContain("sync");
    expect(r.manualCommand).toBe("o2b brain migrate-store");
  });

  test("failed: the reason, the next automatic attempt and the manual command", () => {
    recordAutoMigrationFailure(bench.vault, "the disk is full", {
      manualCommand: "o2b brain migrate-store",
      now: NOW,
    });
    const r = report();
    expect(r.state).toBe(AUTO_MIGRATION_STATE.failed);
    expect(r.error).toBe("the disk is full");
    expect(r.retryAfter).toBe("2026-11-18T13:00:00.000Z");
    expect(r.manualCommand).toBe("o2b brain migrate-store");
    expect(r.message).toContain("the disk is full");
  });

  test("failed, then the opt-out: the failure stays reported, with no retry promised", () => {
    recordAutoMigrationFailure(bench.vault, "the disk is full", {
      manualCommand: "o2b brain migrate-store",
      now: NOW,
    });
    process.env[AUTO_ENV] = "false";
    const r = report();
    expect(r.state).toBe(AUTO_MIGRATION_STATE.failed);
    expect(r.automatic).toBe(false);
    expect(r.error).toBe("the disk is full");
    expect(r.manualCommand).toBe("o2b brain migrate-store");
    expect(r.nextStart).toContain("off");
    expect(r.nextStart).not.toContain("tries again");
  });

  test("done: this machine switched", () => {
    expect(runAutoStoreMigration(bench.vault).outcome).toBe("applied");
    forgetMachineStateCache();
    const r = report();
    expect(r.state).toBe(AUTO_MIGRATION_STATE.done);
    expect(r.nextStart).toBe("nothing");
  });

  test("not needed: a vault with no legacy data", () => {
    const root = mkdtempSync(join(tmpdir(), "osb-auto-report-fresh-"));
    try {
      mkdirSync(join(root, "Brain"), { recursive: true });
      const r = autoMigrationReport({ vault: root, now: NOW });
      expect(r.state).toBe(AUTO_MIGRATION_STATE.notNeeded);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

/** An automatic attempt that switched and stopped at `step`. */
function stopAfterSwitch(step: string): void {
  const r = runAutoStoreMigration(bench.vault, {
    hooks: {
      atStep: (at) => {
        if (at === step) throw new Error(`fault injection: ${step}`);
      },
    },
  });
  expect(r.outcome).toBe("failed");
  forgetMachineStateCache();
}

const doctorFindings = () => {
  const result = runDoctor(bench.vault, { now: NOW });
  return [...result.warnings, ...(result.uncertain ?? [])];
};

describe("a switched machine whose vault is not bound", () => {
  test("an unreadable binding is reported as the binding to repair, not as an unimported vault", () => {
    expect(runAutoStoreMigration(bench.vault).outcome).toBe("applied");
    forgetMachineStateCache();
    writeFileSync(vaultBindingPath(), "{ not a binding");
    const r = report();
    expect(r.message).not.toContain("never imported");
    expect(r.message).toContain("cannot be read");
    expect(r.manualCommand).toBe("o2b init --vault");
  });

  test("the doctor reports a switch stopped before the vault binding, not an unimported vault", () => {
    stopAfterSwitch("switch-marker");
    const found = doctorFindings().filter((f) => f.code === MIGRATION_AVAILABLE_CODE);
    expect(found.map((f) => f.message).join(" ")).not.toContain("never imported");
    expect(found.map((f) => f.message).join(" ")).toContain("did not finish");
  });

  test("the doctor reports a failure of finishing that switch, bound or not", () => {
    for (const step of ["switch-marker", "view-writer"]) {
      stopAfterSwitch(step);
      // The finishing itself failed: a failure record of its own.
      recordAutoMigrationFailure(bench.vault, "the disk is full", {
        manualCommand: "o2b brain migrate-store",
        now: NOW,
      });
      const warning = runDoctor(bench.vault, { now: NOW }).warnings.find(
        (w) => w.code === STORE_MIGRATION_FAILED_CODE,
      );
      expect([step, warning?.message.includes("the disk is full")]).toEqual([step, true]);
      bench.cleanup();
      bench = makeMigrationBench("osb-auto-report-");
      dropUnparseable(bench.vault);
    }
  });
});
