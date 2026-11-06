/**
 * The device-local store lock (`local-lock.ts`): a crashed holder's lock is
 * taken over, but a live holder stuck in a slow append keeps its lock.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isLockContention,
  STORE_LOCK_STALE_MS,
  withLocalLock,
} from "../../../src/core/store/local-lock.ts";

let parent: string;
let target: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-store-lock-"));
  target = join(parent, "locks", "shard");
});
afterEach(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

/** A lock directory another process took `ageMs` ago and never released. */
function heldSince(ageMs: number): void {
  const dir = `${target}.lock`;
  mkdirSync(dir, { recursive: true });
  const at = new Date(Date.now() - ageMs);
  utimesSync(dir, at, at);
}

describe("withLocalLock", () => {
  test("a holder stuck for 30 seconds keeps its lock", () => {
    heldSince(30_000);
    let ran = false;
    expect(() =>
      withLocalLock(
        target,
        () => {
          ran = true;
        },
        50,
      ),
    ).toThrow("store lock busy");
    expect(ran).toBe(false);
  });

  test("a lock older than the stale window is taken over from a crashed holder", () => {
    heldSince(STORE_LOCK_STALE_MS + 5_000);
    expect(withLocalLock(target, () => "ran", 50)).toBe("ran");
  });
});

const eperm = (): NodeJS.ErrnoException => Object.assign(new Error("EPERM"), { code: "EPERM" });

describe("isLockContention", () => {
  test("a held lock is contention on every platform", () => {
    const held = Object.assign(new Error("held"), { code: "ELOCKED" });
    expect(isLockContention(held, target, "linux")).toBe(true);
    expect(isLockContention(held, target, "win32")).toBe(true);
  });

  test("a Windows EPERM on a lock directory still going away is contention", () => {
    heldSince(0);
    expect(isLockContention(eperm(), target, "win32")).toBe(true);
  });

  test("a Windows EPERM with nothing at the lock name is a real refusal", () => {
    expect(isLockContention(eperm(), target, "win32")).toBe(false);
  });

  test("EPERM stays an error on POSIX", () => {
    heldSince(0);
    expect(isLockContention(eperm(), target, "linux")).toBe(false);
  });
});
