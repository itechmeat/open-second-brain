/**
 * The Windows sharing-violation retry behind `renameWithRetry` and
 * `unlinkWithRetry`, driven through their test seams (platform, operation,
 * sleep, clock) so the policy is pinned on any host, not only on Windows.
 */

import { describe, expect, test } from "bun:test";

import { renameWithRetry, unlinkWithRetry } from "../../src/core/fs-atomic.ts";

function errno(code: string): NodeJS.ErrnoException {
  const e: NodeJS.ErrnoException = new Error(code);
  e.code = code;
  return e;
}

/** A fake clock that advances only when the retry loop sleeps. */
function fakeTime() {
  let t = 1_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => t,
    sleep: (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
  };
}

describe("renameWithRetry on win32", () => {
  test("rides out transient EPERM / EACCES / EBUSY and then succeeds", () => {
    const clock = fakeTime();
    const failures = ["EPERM", "EACCES", "EBUSY"];
    const calls: Array<[string, string]> = [];
    renameWithRetry("a", "b", {
      platform: "win32",
      ...clock,
      rename: (from, to) => {
        calls.push([from, to]);
        const next = failures.shift();
        if (next !== undefined) throw errno(next);
      },
    });
    expect(calls.length).toBe(4);
    expect(calls.every(([f, t]) => f === "a" && t === "b")).toBe(true);
    // Exponential backoff from 10 ms.
    expect(clock.sleeps).toEqual([10, 20, 40]);
  });

  test("a non-transient error is thrown at once, without a sleep", () => {
    const clock = fakeTime();
    let calls = 0;
    expect(() =>
      renameWithRetry("a", "b", {
        platform: "win32",
        ...clock,
        rename: () => {
          calls += 1;
          throw errno("ENOENT");
        },
      }),
    ).toThrow("ENOENT");
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  test("a lock that never clears is rethrown once the 2 s budget is spent", () => {
    const clock = fakeTime();
    let calls = 0;
    let thrown: unknown;
    try {
      renameWithRetry("a", "b", {
        platform: "win32",
        ...clock,
        rename: () => {
          calls += 1;
          throw errno("EBUSY");
        },
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as NodeJS.ErrnoException).code).toBe("EBUSY");
    const slept = clock.sleeps.reduce((a, b) => a + b, 0);
    expect(slept).toBeLessThanOrEqual(2_000);
    expect(slept).toBeGreaterThan(1_500);
    // The backoff is capped at 250 ms.
    expect(Math.max(...clock.sleeps)).toBe(250);
    expect(calls).toBe(clock.sleeps.length + 1);
  });

  test("off Windows it is a single rename: a POSIX EPERM is a real error", () => {
    const clock = fakeTime();
    let calls = 0;
    expect(() =>
      renameWithRetry("a", "b", {
        platform: "linux",
        ...clock,
        rename: () => {
          calls += 1;
          throw errno("EPERM");
        },
      }),
    ).toThrow("EPERM");
    expect(calls).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });
});

describe("unlinkWithRetry", () => {
  test("retries a held file on win32 with the same policy", () => {
    const clock = fakeTime();
    const failures = ["EBUSY", "EPERM"];
    const seen: string[] = [];
    unlinkWithRetry("x.bak", {
      platform: "win32",
      ...clock,
      unlink: (p) => {
        seen.push(p);
        const next = failures.shift();
        if (next !== undefined) throw errno(next);
      },
    });
    expect(seen).toEqual(["x.bak", "x.bak", "x.bak"]);
    expect(clock.sleeps).toEqual([10, 20]);
  });

  test("ENOENT passes straight through for the caller to judge", () => {
    expect(() =>
      unlinkWithRetry("x", {
        platform: "win32",
        ...fakeTime(),
        unlink: () => {
          throw errno("ENOENT");
        },
      }),
    ).toThrow("ENOENT");
  });
});
