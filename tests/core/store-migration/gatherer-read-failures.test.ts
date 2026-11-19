/**
 * Every gatherer of the automatic migration's decisions, with a read that
 * fails: the failure surfaces as its own state, never as "absent" (no
 * gate, no run, no record, no legacy data, no claim). One case per
 * gatherer: the gate, the run state (the store and the state file), the
 * attempt record, the legacy tree, the worker claim and the setting.
 *
 * The cases take a permission away (`chmod 000`), so they are skipped on
 * Windows and as root, where a mode does not stop a read.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { autoStoreMigrationSetting } from "../../../src/core/config.ts";
import { migrationGatePath, readMigrationGateState } from "../../../src/core/migration-gate.ts";
import { forgetMachineStateCache } from "../../../src/core/state/machine-state.ts";
import { migrationAvailability } from "../../../src/core/store/migration-availability.ts";
import { inspectStore } from "../../../src/core/store/store-open.ts";
import { deviceStateDirFor } from "../../../src/core/store/store-paths.ts";
import { ownMigrationRunRead } from "../../../src/core/store-migration/auto-probe.ts";
import {
  autoMigrationClaimOwnership,
  autoMigrationLockPath,
  autoMigrationStateDir,
  claimAutoMigrationLock,
  recordAutoMigrationFailure,
  recordAutoMigrationWaiting,
  AUTO_MIGRATION_LOCK_JUDGE,
} from "../../../src/core/store-migration/auto-state.ts";
import { attemptSeen, gatherGate } from "../../../src/core/store-migration/gate-state.ts";
import { migrationDir, writeMigrationState } from "../../../src/core/store-migration/journal.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import {
  dropUnparseable,
  makeMigrationBench,
  type MigrationBench,
} from "./fixtures/migration-env.ts";

setDefaultTimeout(30_000);

const AUTO_ENV = "OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION";
/** Taking a mode away denies nothing on Windows or as root. */
const onPosix = test.skipIf(CHMOD_CANNOT_DENY);

let bench: MigrationBench;
let savedAuto: string | undefined;
/** Paths whose mode a case took away, given back before the bench is removed. */
let locked: string[] = [];

function lock(path: string): void {
  chmodSync(path, 0o000);
  locked.push(path);
}

beforeEach(() => {
  savedAuto = process.env[AUTO_ENV];
  process.env[AUTO_ENV] = "true";
  bench = makeMigrationBench("osb-gatherer-reads-");
  dropUnparseable(bench.vault);
  forgetMachineStateCache();
});

afterEach(() => {
  for (const path of locked.toReversed()) chmodSync(path, 0o700);
  locked = [];
  bench.cleanup();
  if (savedAuto === undefined) delete process.env[AUTO_ENV];
  else process.env[AUTO_ENV] = savedAuto;
});

function gather() {
  return gatherGate({ vault: bench.vault, asker: "worker", now: new Date() });
}

describe("a read that fails is its own state", () => {
  onPosix("the gate: a gate file that cannot be read is unreadable, not free", () => {
    const path = migrationGatePath();
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ vault: bench.vault, run_id: "x", pid: 1 }));
    lock(path);
    expect(readMigrationGateState().kind).toBe("unreadable");
    expect(gather().decision).toEqual({ act: "none", why: "running" });
  });

  onPosix("the run state: a store that cannot be read is an unreadable run, not none", () => {
    lock(bench.storeRoot);
    const g = gather();
    expect(g.context.availability?.storeExists).toBeNull();
    expect(g.state.run).toEqual({ phase: "unreadable" });
    expect(g.decision).toEqual({ act: "none", why: "run-unreadable" });
  });

  onPosix("the run state: a state folder that cannot be listed is unreadable, not none", () => {
    const storeId = inspectStore(bench.storeRoot)!.storeId;
    const dir = migrationDir({ deviceStateDir: deviceStateDirFor(storeId) });
    const at = new Date().toISOString();
    writeMigrationState(dir, {
      run_id: "migrate-20261119T000000000Z",
      phase: "rolled-back",
      started_at: at,
      updated_at: at,
      backed_up: true,
    });
    lock(dir);
    const read = ownMigrationRunRead();
    expect(read.kind === "run" && read.run.state.kind).toBe("unreadable");
    expect(gather().state.run).toEqual({ phase: "unreadable" });
  });

  onPosix("the attempt record: a record folder that cannot be listed is not 'no record'", () => {
    recordAutoMigrationFailure(bench.vault, "disk full", {
      manualCommand: "o2b brain migrate-store",
      now: new Date(),
    });
    lock(autoMigrationStateDir(bench.vault));
    expect(attemptSeen(bench.vault, new Date(), true).kind).not.toBe("none");
  });

  onPosix("the legacy tree: a vault that cannot be read is not 'nothing to migrate'", () => {
    lock(bench.vault);
    const availability = migrationAvailability({ vault: bench.vault });
    expect(availability.legacyDataPresent).toBe(true);
    expect(gather().decision).not.toEqual({ act: "none", why: "not-available" });
  });

  onPosix("the claim: a claim that cannot be read is unreadable, not lost", () => {
    const token = claimAutoMigrationLock(bench.vault, new Date(), {
      judge: AUTO_MIGRATION_LOCK_JUDGE.exact,
    });
    expect(token).not.toBeNull();
    expect(autoMigrationClaimOwnership(bench.vault, token!)).toBe("owned");
    lock(autoMigrationLockPath(bench.vault));
    expect(autoMigrationClaimOwnership(bench.vault, token!)).toBe("unreadable");
  });

  onPosix("the setting: a machine config that cannot be read is off, with the reason", () => {
    const config = process.env["OPEN_SECOND_BRAIN_CONFIG"]!;
    lock(config);
    const setting = autoStoreMigrationSetting(config);
    expect(setting.enabled).toBe(false);
    expect(setting.unreadable).not.toBeNull();
  });
});

test("the claim: another token's claim is lost, no claim is lost", () => {
  expect(autoMigrationClaimOwnership(bench.vault, "0".repeat(32))).toBe("lost");
  const token = claimAutoMigrationLock(bench.vault, new Date(), {
    judge: AUTO_MIGRATION_LOCK_JUDGE.exact,
  });
  expect(autoMigrationClaimOwnership(bench.vault, "0".repeat(32))).toBe("lost");
  expect(autoMigrationClaimOwnership(bench.vault, token!)).toBe("owned");
});

test("the attempt record on a switched machine: a store-arrival wait is moot to both reads", () => {
  // A fresh wait for a store, left after the store arrived and the machine
  // switched: the start's cheap reads and the worker's full reads agree
  // that nothing is left, so no start spawns a worker for it.
  const now = new Date();
  recordAutoMigrationWaiting(
    bench.vault,
    { missing: [], firstMachines: ["dev-b"], awaitsStore: true },
    now,
  );
  const cheap = gatherGate({ vault: bench.vault, asker: "start", now, switched: true });
  const full = gatherGate({ vault: bench.vault, asker: "worker", now, switched: true });
  expect(cheap.state.record?.kind).toBe("none");
  expect(cheap.decision).toEqual({ act: "none", why: "nothing-left" });
  expect(full.decision).toEqual({ act: "none", why: "nothing-left" });
});
