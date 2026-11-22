/**
 * The dream pass lock (design D3) judged by its holder's process: a live
 * holder keeps it however old it is, a holder that is gone is taken over,
 * and a release waits for a live holder within its budget and is refused
 * after it.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  claimDreamOwner,
  readDreamOwner,
  releaseDreamOwner,
  withDreamPassLock,
} from "../../../../src/core/brain/dream-owner/owner.ts";
import { isLockContention, STORE_LOCK_STALE_MS } from "../../../../src/core/store/local-lock.ts";
import { startDreamPassHolder } from "../../../helpers/dream-pass-holder.ts";
import { makeMachines, type Machines } from "../../view/fixtures/machines.ts";

const WAIT_ENV = "OPEN_SECOND_BRAIN_LOCK_WAIT_MS";
const human = { writer: "o2b", authority: "human" as const };

/** A clock ten stale ages ahead: any lock judged by its age is abandoned by it. */
const lateClock = () => Date.now() + 10 * STORE_LOCK_STALE_MS;

let m: Machines;
let savedWait: string | undefined;
beforeEach(() => {
  m = makeMachines(["dev-a"], "osb-dream-pass-lock-");
  savedWait = process.env[WAIT_ENV];
  process.env[WAIT_ENV] = "100";
});
afterEach(() => {
  if (savedWait === undefined) delete process.env[WAIT_ENV];
  else process.env[WAIT_ENV] = savedWait;
  m.cleanup();
});

function contention(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe("dream pass lock", () => {
  test("a live holder keeps the lock long past the stale age", async () => {
    const a = m.open("dev-a");
    const holder = await startDreamPassHolder(a, 60_000);
    try {
      const err = contention(() => withDreamPassLock(a, () => 1, { now: lateClock }));
      expect(isLockContention(err)).toBe(true);
      expect((err as Error).message).toContain(`held by process ${holder.pid}`);
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }
  });

  test("a holder whose process is gone is taken over at once", async () => {
    const a = m.open("dev-a");
    const holder = await startDreamPassHolder(a, 60_000);
    holder.kill("SIGKILL");
    await holder.exited;
    expect(withDreamPassLock(a, () => 2)).toBe(2);
  });

  test("a release waits for a live holder within its budget", async () => {
    const a = m.open("dev-a");
    claimDreamOwner(a, "claude", human);
    const holder = await startDreamPassHolder(a, 300);
    try {
      process.env[WAIT_ENV] = "10000";
      expect(releaseDreamOwner(a, human)).toEqual({ status: "released" });
    } finally {
      await holder.exited;
    }
    expect(readDreamOwner(a).owner).toBeNull();
  });

  test("a release is refused once its budget is spent while the holder lives", async () => {
    const a = m.open("dev-a");
    claimDreamOwner(a, "claude", human);
    const holder = await startDreamPassHolder(a, 60_000);
    try {
      const err = contention(() => releaseDreamOwner(a, human));
      expect(isLockContention(err)).toBe(true);
      expect((err as Error).message).toContain("busy");
    } finally {
      holder.kill("SIGKILL");
      await holder.exited;
    }
    expect(readDreamOwner(a).owner?.device).toBe("dev-a");
  });
});
