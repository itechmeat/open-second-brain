/**
 * The device-local store lock (`local-lock.ts`): a crashed holder's lock is
 * taken over, but a live holder stuck in a slow append keeps its lock.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { STORE_LOCK_STALE_MS, withLocalLock } from "../../../src/core/store/local-lock.ts";
import { CHMOD_CANNOT_DENY } from "../../helpers/platform.ts";
import { refuseLockMkdir, windowsRefusal } from "../../helpers/windows-lock-refusal.ts";

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

const refusal = (code: "EPERM" | "EACCES"): NodeJS.ErrnoException =>
  windowsRefusal(`${target}.lock`, code);

describe("a lock directory another writer is releasing on Windows", () => {
  afterEach(() => mock.restore());

  test("EPERM after the release finished, several times in a row, is waited out", () => {
    heldSince(0);
    // Each refused mkdir is the moment the previous holder's directory is
    // still delete-pending; by the time the waiter looks, it is gone, and
    // the next holder takes and releases it again before the next attempt.
    const refusals = refuseLockMkdir(`${target}.lock`, 3, () => {
      rmSync(`${target}.lock`, { recursive: true, force: true });
      return refusal("EPERM");
    });
    const started = Date.now();
    const result = withLocalLock(target, () => "appended", 2_000);
    expect(result).toBe("appended");
    expect(refusals.calls()).toBe(3);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("EACCES while the directory is still there is a held lock until it goes", () => {
    heldSince(0);
    refuseLockMkdir(`${target}.lock`, 4, (call) => {
      if (call === 4) rmSync(`${target}.lock`, { recursive: true, force: true });
      return refusal("EACCES");
    });
    expect(withLocalLock(target, () => "appended", 2_000)).toBe("appended");
  });

  test("a refusal that outlasts the wait ends as a busy lock within the budget", () => {
    heldSince(0);
    refuseLockMkdir(`${target}.lock`, Number.MAX_SAFE_INTEGER, () => refusal("EPERM"));
    const started = Date.now();
    expect(() => withLocalLock(target, () => "never", 200)).toThrow("store lock busy");
    expect(Date.now() - started).toBeLessThan(1_500);
  });

  test.skipIf(CHMOD_CANNOT_DENY)(
    "a directory that refuses new entries fails at once with its own reason",
    () => {
      mkdirSync(dirname(target), { recursive: true });
      chmodSync(dirname(target), 0o500);
      try {
        const started = Date.now();
        let caught: unknown;
        try {
          withLocalLock(target, () => "never", 5_000);
        } catch (err) {
          caught = err;
        }
        expect(Date.now() - started).toBeLessThan(1_000);
        expect((caught as NodeJS.ErrnoException).code).toBe("EACCES");
        expect(String((caught as Error).message)).toContain("refuses new entries");
      } finally {
        chmodSync(dirname(target), 0o700);
      }
    },
  );
});
