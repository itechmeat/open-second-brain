/**
 * A run releases only the gate it holds. Two processes resume the same
 * run (the same run id): one holds the gate and runs, the other is
 * refused at the gate. The refused one must leave the live holder's gate
 * in place: its own cleanup checks the holder (this process, or one that
 * cannot run any more) under the gate lock, not the vault and the run id
 * alone, and a run that never took the gate releases nothing.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readMigrationGate } from "../../../src/core/migration-gate.ts";
import { forgetMachineStateCache } from "../../../src/core/state/machine-state.ts";
import { migrationDir, writeMigrationState } from "../../../src/core/store-migration/journal.ts";
import {
  finishInterruptedSwitch,
  runMigration,
} from "../../../src/core/store-migration/migrate.ts";
import {
  liftQuiesce,
  MigrationGateBusyError,
  quiesceLegacyWriters,
} from "../../../src/core/store-migration/quiesce.ts";
import { runStateOf } from "./fixtures/run-state.ts";
import {
  dropUnparseable,
  makeMigrationBench,
  type MigrationBench,
} from "./fixtures/migration-env.ts";

setDefaultTimeout(60_000);

const HOLDER = join(import.meta.dir, "fixtures", "gate-holder-child.ts");
const RUN = "migrate-20261119T040000000Z";
const LOCK_WAIT_ENV = "OPEN_SECOND_BRAIN_LOCK_WAIT_MS";

let bench: MigrationBench;
let child: ReturnType<typeof Bun.spawn> | null = null;
let done = "";
let savedWait: string | undefined;

beforeEach(() => {
  savedWait = process.env[LOCK_WAIT_ENV];
  process.env[LOCK_WAIT_ENV] = "200";
  bench = makeMigrationBench("osb-gate-owner-");
  dropUnparseable(bench.vault);
  forgetMachineStateCache();
  done = join(bench.fx.parent, "done");
});

afterEach(async () => {
  writeFileSync(done, "");
  if (child !== null) await child.exited;
  child = null;
  bench.cleanup();
  if (savedWait === undefined) delete process.env[LOCK_WAIT_ENV];
  else process.env[LOCK_WAIT_ENV] = savedWait;
});

/** A second process holds the gate of `bench.vault` for `RUN`, alive until the test ends. */
async function liveHolder(runId = RUN): Promise<number> {
  const ready = join(bench.fx.parent, "ready");
  child = Bun.spawn([process.execPath, "run", HOLDER, bench.vault, runId, ready, done], {
    env: { ...process.env },
    stdin: "ignore",
    stdout: "ignore",
    stderr: "inherit",
  });
  const deadline = Date.now() + 20_000;
  while (!existsSync(ready) && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(10);
  }
  expect(existsSync(ready)).toBe(true);
  return child.pid;
}

/** This machine's run `RUN`, in progress (the run both processes resume). */
function runInProgress(): void {
  const at = new Date().toISOString();
  writeMigrationState(migrationDir(bench.store()), {
    run_id: RUN,
    phase: "in-progress",
    started_at: at,
    updated_at: at,
    backed_up: false,
  });
}

describe("a refused contender of the same run leaves the live holder's gate", () => {
  test("the gate's own release checks the holder, not the run id alone", async () => {
    const pid = await liveHolder();
    expect(() => quiesceLegacyWriters(bench.vault, RUN, 0)).toThrow(MigrationGateBusyError);
    liftQuiesce(bench.vault, RUN);
    expect(readMigrationGate()?.pid).toBe(pid);
  });

  test("a resumed migration refused at the gate leaves it to the holder", async () => {
    runInProgress();
    const pid = await liveHolder();
    expect(() => runMigration(bench.vault, { resume: true, settleMs: 0 })).toThrow(
      MigrationGateBusyError,
    );
    expect(readMigrationGate()?.pid).toBe(pid);
  });
});

describe("finishing an interrupted switch takes the gate of its run", () => {
  test("a live holder of that gate refuses it, and its gate and the run stay as they are", async () => {
    expect(runMigration(bench.vault, { settleMs: 0 }).ok).toBe(true);
    // Killed after its switch record: the device is switched, the run in progress.
    const dir = migrationDir(bench.store());
    const finished = runStateOf(dir)!;
    writeMigrationState(dir, { ...finished, phase: "in-progress" });
    const pid = await liveHolder(finished.run_id);
    expect(() => finishInterruptedSwitch(bench.vault, bench.store(), "t")).toThrow(
      MigrationGateBusyError,
    );
    expect(readMigrationGate()?.pid).toBe(pid);
    expect(runStateOf(dir)?.phase).toBe("in-progress");
  });
});
