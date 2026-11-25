/**
 * A process killed while it holds the queue's lock or a run's lock (a
 * dream session ended at its budget, whose server was in a call) leaves
 * nothing that stops the next holder: the lock is judged by its holder's
 * process, not by its age, so the worker's release at the end of the
 * session and the next pass take it at once. Kept in a file of its own:
 * it spawns processes.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import {
  claimDreamOwner,
  claimSettled,
  readDreamOwner,
} from "../../../../src/core/brain/dream-owner/owner.ts";
import {
  dreamQueueOn,
  produceWork,
  releaseRunWork,
  takeWork,
  type DreamQueue,
} from "../../../../src/core/brain/dream-queue/queue.ts";
import { withDreamRunLock } from "../../../../src/core/brain/dream-queue/run-record.ts";
import { STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";
import type { StoreHandle } from "../../../../src/core/store/store-open.ts";
import {
  FIXTURE_CLOSED,
  registerFixtureOperations,
  type FixtureOperations,
} from "../../../helpers/dream-queue-fixtures.ts";
import { homeEnv } from "../../../helpers/platform.ts";
import { makeMachines, type Machines } from "../../view/fixtures/machines.ts";

const RUN = "0b0c3a2e-1111-4222-8333-444455556666";
let m: Machines;
let store: StoreHandle;
let queue: DreamQueue;
let ops: FixtureOperations;

beforeEach(() => {
  m = makeMachines(["dev-a"], "osb-dream-dead-holder-");
  store = m.open("dev-a");
  claimDreamOwner(store, "claude", { writer: "o2b", authority: "human" });
  claimSettled(store, readDreamOwner(store));
  ops = registerFixtureOperations();
  queue = dreamQueueOn(store, { vault: null, writer: "o2b" });
  produceWork(queue, {
    operation: FIXTURE_CLOSED,
    subject: "s1",
    occurrence: "2026-11-20/001",
    input: 1,
    prompt_version: "1",
    schema_version: "1",
    answer_schema: {},
    after: [],
    resources: [],
    evidence: [],
    payload: {},
    sources: ["shared"],
  });
});

afterEach(() => {
  ops.unregister();
  m.cleanup();
});

/** Run the child that is killed inside the lock named by `where`; resolves once it is dead. */
async function dieInLock(where: "queue" | "run"): Promise<void> {
  const stateHome = join(m.parent, "state", "dev-a");
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "fixtures", "die-in-lock.ts"),
      m.root("dev-a"),
      "dev-a",
      stateHome,
      where,
      RUN,
    ],
    {
      env: {
        ...process.env,
        ...homeEnv(join(m.parent, "home", "dev-a")),
        XDG_CONFIG_HOME: join(m.parent, "config"),
        XDG_DATA_HOME: join(m.parent, "data"),
        XDG_STATE_HOME: stateHome,
        XDG_CACHE_HOME: join(m.parent, "cache"),
        [STORE_ROOT_ENV]: m.root("dev-a"),
        O2B_DEVICE_ID: "dev-a",
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  await child.exited;
  expect(await new Response(child.stderr).text()).toBe("");
  // The child is dead: it did not exit by itself with code 0. The signal
  // it died of is SIGKILL on POSIX; Windows reports no signal for a killed
  // child, so the signal is asserted where it exists.
  expect(child.exitCode).not.toBe(0);
  if (process.platform !== "win32") expect(child.signalCode).toBe("SIGKILL");
}

describe("a holder killed inside a lock", () => {
  test("the queue lock: the next take is not refused as busy", async () => {
    await dieInLock("queue");
    const started = Date.now();
    const taken = takeWork(queue, { run: "next-run", budgetMs: 2_000 });
    expect(taken.reason).toBeUndefined();
    expect(taken.item?.operation).toBe(FIXTURE_CLOSED);
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(releaseRunWork(queue, "next-run")).toBe(1);
  }, 30_000);

  test("the run lock: the worker's cleanup takes it at once", async () => {
    await dieInLock("run");
    const started = Date.now();
    expect(withDreamRunLock(store.deviceStateDir, RUN, () => "taken")).toBe("taken");
    expect(Date.now() - started).toBeLessThan(2_000);
  }, 30_000);
});
