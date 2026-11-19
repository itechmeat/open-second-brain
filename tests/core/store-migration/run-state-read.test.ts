/**
 * The run state of this device is read once, and that one read answers
 * absent, unreadable or the parsed run: no second look at the file
 * decides. A read that fails and a later read that succeeds is still an
 * unreadable run, and a run state that cannot be read after the worker
 * finished an interrupted switch is no finished switch.
 *
 * The guard at the end keeps every other module off the state file: they
 * all go through the one reader in the journal module.
 */
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, spyOn, test } from "bun:test";
import { join, relative, sep } from "node:path";

import { forgetMachineStateCache } from "../../../src/core/state/machine-state.ts";
import { deviceSwitchedHere } from "../../../src/core/store/store-only.ts";
import { inspectStore } from "../../../src/core/store/store-open.ts";
import { deviceStateDirFor } from "../../../src/core/store/store-paths.ts";
import { ownMigrationRunRead } from "../../../src/core/store-migration/auto-probe.ts";
import {
  readAutoMigrationFailure,
  readAutoMigrationNotice,
} from "../../../src/core/store-migration/auto-state.ts";
import {
  AUTO_MIGRATION_OUTCOME,
  runAutoStoreMigration,
} from "../../../src/core/store-migration/auto-worker.ts";
import { gatherGate } from "../../../src/core/store-migration/gate-state.ts";
import {
  MIGRATION_STATE_FILE,
  migrationDir,
  writeMigrationState,
} from "../../../src/core/store-migration/journal.ts";
import { MIGRATION_STEP } from "../../../src/core/store-migration/migrate.ts";
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
  bench = makeMigrationBench("osb-run-state-read-");
  dropUnparseable(bench.vault);
  forgetMachineStateCache();
});

afterEach(() => {
  bench.cleanup();
  if (savedAuto === undefined) delete process.env[AUTO_ENV];
  else process.env[AUTO_ENV] = savedAuto;
});

function stateFile(): string {
  const storeId = inspectStore(bench.storeRoot)!.storeId;
  return join(migrationDir({ deviceStateDir: deviceStateDirFor(storeId) }), MIGRATION_STATE_FILE);
}

/** `readFileSync` whose reads of the run state file fail while `fails()` says so. */
function failingStateReads(fails: (path: string) => boolean) {
  const real = fs.readFileSync;
  const target = stateFile();
  return spyOn(fs, "readFileSync").mockImplementation(((
    path: fs.PathOrFileDescriptor,
    options?: unknown,
  ) => {
    if (String(path) === target && fails(String(path))) {
      throw Object.assign(new Error("EIO: i/o error, read"), { code: "EIO" });
    }
    return (real as (p: fs.PathOrFileDescriptor, o?: unknown) => unknown)(path, options);
  }) as typeof fs.readFileSync);
}

describe("the run state is read once", () => {
  test("a read that fails, then a read that succeeds, is an unreadable run, not none", () => {
    const at = new Date().toISOString();
    const dir = migrationDir({
      deviceStateDir: deviceStateDirFor(inspectStore(bench.storeRoot)!.storeId),
    });
    writeMigrationState(dir, {
      run_id: "migrate-20261119T000000000Z",
      phase: "rolled-back",
      started_at: at,
      updated_at: at,
      backed_up: true,
    });
    let reads = 0;
    const spy = failingStateReads(() => ++reads === 1);
    try {
      const read = ownMigrationRunRead();
      expect(read.kind === "run" && read.run.state.kind).toBe("unreadable");
    } finally {
      spy.mockRestore();
    }
    reads = 0;
    const again = failingStateReads(() => ++reads === 1);
    try {
      const g = gatherGate({ vault: bench.vault, asker: "worker", now: new Date() });
      expect(g.state.run).toEqual({ phase: "unreadable" });
      expect(g.decision).toEqual({ act: "none", why: "run-unreadable" });
    } finally {
      again.mockRestore();
    }
  });

  test("a state that cannot be read after the switch recovery is no finished switch", () => {
    // An attempt that switched this machine and stopped right after.
    const stopped = runAutoStoreMigration(bench.vault, {
      settleMs: 0,
      hooks: {
        atStep: (step) => {
          if (step === MIGRATION_STEP.deviceSwitched) throw new Error("fault injection");
        },
      },
    });
    expect(stopped.outcome).toBe(AUTO_MIGRATION_OUTCOME.failed);
    expect(deviceSwitchedHere(bench.store(), BENCH_DEVICE)).toBe(true);
    forgetMachineStateCache();
    // Once the recovery wrote its state, no read of it succeeds.
    const real = fs.readFileSync;
    const spy = failingStateReads((path) => {
      try {
        return String(real(path, "utf8")).includes('"done"');
      } catch {
        return false;
      }
    });
    let run;
    try {
      run = runAutoStoreMigration(bench.vault, { settleMs: 0 });
    } finally {
      spy.mockRestore();
    }
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.failed);
    expect(run.error).toContain("does not read back as finished");
    expect(readAutoMigrationNotice(bench.vault)).toBeNull();
    // The attempt stays pending: the next start finishes or publishes it.
    expect(readAutoMigrationFailure(bench.vault)?.attempt).toBe(true);
  });
});

describe("guard: the run state file has one reader", () => {
  test("no module but the journal names the run state file", () => {
    const root = join(import.meta.dir, "..", "..", "..", "src");
    const offenders: string[] = [];
    for (const entry of fs.readdirSync(root, { recursive: true, encoding: "utf8" })) {
      if (!entry.endsWith(".ts")) continue;
      const rel = relative(root, join(root, entry)).split(sep).join("/");
      if (rel === "core/store-migration/journal.ts") continue;
      const text = fs.readFileSync(join(root, entry), "utf8");
      if (/\bMIGRATION_STATE_FILE\b|stateFileReadable/.test(text)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test("the journal reads the run state file in one place", () => {
    const text = fs.readFileSync(
      join(import.meta.dir, "..", "..", "..", "src", "core", "store-migration", "journal.ts"),
      "utf8",
    );
    expect(text.match(/join\(dir, STATE_FILE\)/g)?.length).toBe(2); // one read, one write
  });
});
