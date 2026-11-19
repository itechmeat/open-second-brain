/**
 * Nothing opens the migration gate except under the gate lock. A run whose
 * gate lock stays busy past its wait (another process holds it, taking or
 * judging the gate) leaves the gate as it is and reports busy: a dead
 * holder's gate judged without the lock could be the one a resumed run
 * wrote a moment later. A later start, the lock free again, recovers the
 * gate as it recovers any stopped run's.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { migrationGatePath, readMigrationGate } from "../../../src/core/migration-gate.ts";
import { forgetMachineStateCache } from "../../../src/core/state/machine-state.ts";
import {
  liftQuiesce,
  MigrationGateBusyError,
  releaseStoppedRunGate,
} from "../../../src/core/store-migration/quiesce.ts";
import { makeMigrationBench, type MigrationBench } from "./fixtures/migration-env.ts";

setDefaultTimeout(60_000);

const LOCK_HOLDER = join(import.meta.dir, "fixtures", "gate-lock-holder-child.ts");
const RUN = "migrate-20261119T050000000Z";
const LOCK_WAIT_ENV = "OPEN_SECOND_BRAIN_LOCK_WAIT_MS";

let bench: MigrationBench;
let child: ReturnType<typeof Bun.spawn> | null = null;
let done = "";
let savedWait: string | undefined;

beforeEach(() => {
  savedWait = process.env[LOCK_WAIT_ENV];
  process.env[LOCK_WAIT_ENV] = "200";
  bench = makeMigrationBench("osb-gate-lock-");
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

/** The pid of a process that has exited. */
function deadPid(): number {
  return spawnSync(process.execPath, ["-e", ""]).pid!;
}

/** The gate a run of `bench.vault` left when its process died. */
function deadHoldersGate(): void {
  mkdirSync(dirname(migrationGatePath()), { recursive: true });
  writeFileSync(
    migrationGatePath(),
    JSON.stringify({ vault: resolve(bench.vault), run_id: RUN, since: "", pid: deadPid() }),
  );
}

/** A second process holds the gate lock until the test lets it go. */
async function lockHeldElsewhere(): Promise<void> {
  const ready = join(bench.fx.parent, "ready");
  child = Bun.spawn([process.execPath, "run", LOCK_HOLDER, ready, done], {
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
}

async function lockFreed(): Promise<void> {
  writeFileSync(done, "");
  if (child !== null) await child.exited;
  child = null;
}

describe("a gate release while another process holds the gate lock", () => {
  test("leaves the gate, reports busy, and a later start recovers it", async () => {
    deadHoldersGate();
    await lockHeldElsewhere();
    expect(() => liftQuiesce(bench.vault, RUN)).toThrow(MigrationGateBusyError);
    expect(readMigrationGate()?.run_id).toBe(RUN);
    await lockFreed();
    // The next start opens a stopped run's gate under the lock.
    expect(releaseStoppedRunGate(bench.vault, RUN)).toBe(true);
    expect(readMigrationGate()).toBeNull();
  });

  test("guard: a stopped run's gate is not opened while the lock is held elsewhere", async () => {
    deadHoldersGate();
    await lockHeldElsewhere();
    expect(() => releaseStoppedRunGate(bench.vault, RUN)).toThrow(MigrationGateBusyError);
    expect(readMigrationGate()?.run_id).toBe(RUN);
  });
});
