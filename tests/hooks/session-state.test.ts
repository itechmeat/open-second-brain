import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HOOK_STATE_STALE_LOCK_MS,
  hookStateFilePath,
  pruneHookStateFiles,
  readHookStamp,
  updateHookState,
  writeHookStamp,
} from "../../hooks/lib/session-state.ts";
import { _resetHeldLocksForTests } from "../../src/core/brain/sync-lockfile.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-hook-state-"));
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("hook session state", () => {
  const KEY = "osb.nav_tier.last_injected";

  test("missing state reads as absent (null), never throws", () => {
    expect(readHookStamp(vault, "sess-1", KEY)).toBeNull();
  });

  test("write then read returns the live stamp within its window", () => {
    const now = 1_000_000;
    expect(writeHookStamp(vault, "sess-1", KEY, { expiresAt: now + 5000 })).toBe(true);
    const stamp = readHookStamp(vault, "sess-1", KEY, now + 1000);
    expect(stamp).not.toBeNull();
    expect(stamp!.expiresAt).toBe(now + 5000);
  });

  test("an expired stamp reads as absent", () => {
    const now = 1_000_000;
    writeHookStamp(vault, "sess-1", KEY, { expiresAt: now + 5000 });
    expect(readHookStamp(vault, "sess-1", KEY, now + 6000)).toBeNull();
  });

  test("a stamp exactly at expiry reads as absent (expiry is exclusive)", () => {
    const now = 1_000_000;
    writeHookStamp(vault, "sess-1", KEY, { expiresAt: now + 5000 });
    expect(readHookStamp(vault, "sess-1", KEY, now + 5000)).toBeNull();
  });

  test("optional data payload round-trips", () => {
    const now = 2_000_000;
    writeHookStamp(vault, "sess-1", KEY, { expiresAt: now + 1000, data: { turns: 3 } });
    const stamp = readHookStamp(vault, "sess-1", KEY, now);
    expect(stamp!.data).toEqual({ turns: 3 });
  });

  test("distinct sessions have isolated state", () => {
    const now = 3_000_000;
    writeHookStamp(vault, "sess-a", KEY, { expiresAt: now + 1000 });
    expect(readHookStamp(vault, "sess-b", KEY, now)).toBeNull();
    expect(readHookStamp(vault, "sess-a", KEY, now)).not.toBeNull();
  });

  test("a malformed state file reads as absent, never throws", () => {
    const path = hookStateFilePath(vault, "sess-1");
    mkdirSync(join(vault, ".open-second-brain", "hook-state"), { recursive: true });
    writeFileSync(path, "{ not valid json");
    expect(readHookStamp(vault, "sess-1", KEY)).toBeNull();
  });

  test("a stamp with a non-numeric expiry reads as absent", () => {
    const path = hookStateFilePath(vault, "sess-1");
    mkdirSync(join(vault, ".open-second-brain", "hook-state"), { recursive: true });
    writeFileSync(path, JSON.stringify({ [KEY]: { expiresAt: "soon" } }));
    expect(readHookStamp(vault, "sess-1", KEY)).toBeNull();
  });

  test("an absent/empty session id falls back to a stable default scope", () => {
    const now = 4_000_000;
    writeHookStamp(vault, undefined, KEY, { expiresAt: now + 1000 });
    expect(readHookStamp(vault, undefined, KEY, now)).not.toBeNull();
    expect(readHookStamp(vault, "", KEY, now)).not.toBeNull();
  });

  test("writing one key preserves other keys in the same session file", () => {
    const now = 5_000_000;
    writeHookStamp(vault, "sess-1", "osb.nav_tier.last_injected", { expiresAt: now + 1000 });
    writeHookStamp(vault, "sess-1", "osb.oriented.recent", { expiresAt: now + 2000 });
    expect(readHookStamp(vault, "sess-1", "osb.nav_tier.last_injected", now)).not.toBeNull();
    expect(readHookStamp(vault, "sess-1", "osb.oriented.recent", now)).not.toBeNull();
  });

  test("a contended scope lock fails the write open without clobbering existing stamps", () => {
    const now = 6_000_000;
    const KEY_A = "osb.nav_tier.last_injected";
    const KEY_B = "osb.oriented.recent";
    // First stamp lands normally.
    expect(writeHookStamp(vault, "sess-1", KEY_A, { expiresAt: now + 1000 })).toBe(true);

    // Simulate a concurrent hook process holding the per-scope advisory lock:
    // pre-create the `.lock` sidecar so acquireLockSync sees EEXIST/ELOCKED.
    const lockPath = hookStateFilePath(vault, "sess-1") + ".lock";
    writeFileSync(lockPath, "held by another process\n");
    try {
      // The read-merge-write cannot acquire the lock within its retry budget,
      // so it degrades to a fail-open false rather than throwing or racing.
      expect(writeHookStamp(vault, "sess-1", KEY_B, { expiresAt: now + 2000 })).toBe(false);
      // The earlier stamp was neither dropped nor corrupted by the blocked write.
      expect(readHookStamp(vault, "sess-1", KEY_A, now)).not.toBeNull();
      expect(readHookStamp(vault, "sess-1", KEY_B, now)).toBeNull();
    } finally {
      unlinkSync(lockPath);
      _resetHeldLocksForTests();
    }

    // Once the lock clears, the write succeeds and both keys coexist.
    expect(writeHookStamp(vault, "sess-1", KEY_B, { expiresAt: now + 2000 })).toBe(true);
    expect(readHookStamp(vault, "sess-1", KEY_A, now)).not.toBeNull();
    expect(readHookStamp(vault, "sess-1", KEY_B, now)).not.toBeNull();
  });
});

function holdLock(sessionId: string): string {
  const lockPath = hookStateFilePath(vault, sessionId) + ".lock";
  mkdirSync(join(vault, ".open-second-brain", "hook-state"), { recursive: true });
  writeFileSync(lockPath, "held by another process\n");
  return lockPath;
}

function dir(): string {
  return join(vault, ".open-second-brain", "hook-state");
}

describe("updateHookState", () => {
  const KEY_A = "osb.test.a";
  const KEY_B = "osb.test.b";

  test("applies a mutator under the scope lock and preserves other keys", () => {
    const now = 7_000_000;
    writeHookStamp(vault, "sess-1", KEY_A, { expiresAt: now + 1000 });
    const outcome = updateHookState(
      vault,
      "sess-1",
      (state, nowMs) => {
        state[KEY_B] = { expiresAt: nowMs + 2000, data: { n: 1 } };
        return { state, result: "done" };
      },
      { nowMs: now },
    );
    expect(outcome).toEqual({ status: "ok", result: "done" });
    expect(readHookStamp(vault, "sess-1", KEY_A, now)).not.toBeNull();
    expect(readHookStamp(vault, "sess-1", KEY_B, now)!.data).toEqual({ n: 1 });
    expect(existsSync(hookStateFilePath(vault, "sess-1") + ".lock")).toBe(false);
  });

  test("the mutator receives the current state and the clock", () => {
    writeHookStamp(vault, "sess-1", KEY_A, { expiresAt: 99 });
    let seen: unknown = null;
    let seenNow = 0;
    updateHookState(
      vault,
      "sess-1",
      (state, nowMs) => {
        seen = state[KEY_A];
        seenNow = nowMs;
        return { state, result: null };
      },
      { nowMs: 42 },
    );
    expect(seen).toEqual({ expiresAt: 99 });
    expect(seenNow).toBe(42);
  });

  test("tryOnce returns busy within 20 ms on a held lock, without a retry loop", () => {
    const lockPath = holdLock("sess-1");
    try {
      let calls = 0;
      const started = performance.now();
      const outcome = updateHookState(
        vault,
        "sess-1",
        (state) => {
          calls += 1;
          return { state, result: 1 };
        },
        { tryOnce: true },
      );
      const elapsed = performance.now() - started;
      expect(outcome).toEqual({ status: "busy" });
      expect(calls).toBe(0);
      expect(elapsed).toBeLessThan(20);
    } finally {
      unlinkSync(lockPath);
      _resetHeldLocksForTests();
    }
  });

  test("without tryOnce it keeps the bounded retry before reporting busy", () => {
    const lockPath = holdLock("sess-1");
    try {
      const started = performance.now();
      const outcome = updateHookState(vault, "sess-1", (state) => ({ state, result: 1 }));
      const elapsed = performance.now() - started;
      expect(outcome).toEqual({ status: "busy" });
      // 20 attempts x 5 ms sleep: well above a single attempt.
      expect(elapsed).toBeGreaterThanOrEqual(50);
    } finally {
      unlinkSync(lockPath);
      _resetHeldLocksForTests();
    }
  });

  test("a lockfile older than the stale threshold is taken over", () => {
    const lockPath = holdLock("sess-1");
    const old = (Date.now() - HOOK_STATE_STALE_LOCK_MS - 5_000) / 1000;
    utimesSync(lockPath, old, old);
    try {
      const outcome = updateHookState(
        vault,
        "sess-1",
        (state) => {
          state[KEY_A] = { expiresAt: Number.MAX_SAFE_INTEGER };
          return { state, result: "took" };
        },
        { tryOnce: true },
      );
      expect(outcome).toEqual({ status: "ok", result: "took" });
      expect(readHookStamp(vault, "sess-1", KEY_A)).not.toBeNull();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      _resetHeldLocksForTests();
    }
  });

  test("a fresh lockfile is not taken over", () => {
    const lockPath = holdLock("sess-1");
    try {
      const outcome = updateHookState(vault, "sess-1", (state) => ({ state, result: 1 }), {
        tryOnce: true,
      });
      expect(outcome).toEqual({ status: "busy" });
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      unlinkSync(lockPath);
      _resetHeldLocksForTests();
    }
  });

  test("a throwing mutator reports failed and leaves the file untouched", () => {
    writeHookStamp(vault, "sess-1", KEY_A, { expiresAt: Number.MAX_SAFE_INTEGER });
    const before = readFileSync(hookStateFilePath(vault, "sess-1"), "utf8");
    const outcome = updateHookState(vault, "sess-1", () => {
      throw new Error("boom");
    });
    expect(outcome).toEqual({ status: "failed" });
    expect(readFileSync(hookStateFilePath(vault, "sess-1"), "utf8")).toBe(before);
    expect(existsSync(hookStateFilePath(vault, "sess-1") + ".lock")).toBe(false);
  });

  test("writes replace the state file by rename and leave no temp file behind", () => {
    writeHookStamp(vault, "sess-1", KEY_A, { expiresAt: Number.MAX_SAFE_INTEGER });
    updateHookState(vault, "sess-1", (state) => {
      state[KEY_B] = { expiresAt: Number.MAX_SAFE_INTEGER };
      return { state, result: null };
    });
    const names = readdirSync(dir());
    expect(names).toEqual(["sess-1.json"]);
    const parsed = JSON.parse(readFileSync(join(dir(), "sess-1.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(parsed).toSorted()).toEqual([KEY_A, KEY_B]);
  });
});

function seed(name: string, ageMs: number, now: number): string {
  mkdirSync(dir(), { recursive: true });
  const path = join(dir(), name);
  writeFileSync(path, "{}\n");
  const t = (now - ageMs) / 1000;
  utimesSync(path, t, t);
  return path;
}

describe("pruneHookStateFiles", () => {
  const DAY = 86_400_000;

  test("returns 0 on a missing directory", () => {
    expect(pruneHookStateFiles(vault)).toBe(0);
  });

  test("removes only scope files older than maxAgeMs", () => {
    const now = Date.now();
    const old = seed("AA-old.json", 8 * DAY, now);
    const fresh = seed("AB-fresh.json", 1 * DAY, now);
    expect(pruneHookStateFiles(vault, { nowMs: now })).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("honours a custom maxAgeMs", () => {
    const now = Date.now();
    const a = seed("AA-a.json", 2 * DAY, now);
    expect(pruneHookStateFiles(vault, { nowMs: now, maxAgeMs: DAY })).toBe(1);
    expect(existsSync(a)).toBe(false);
  });

  test("stops at maxFiles", () => {
    const now = Date.now();
    for (const n of ["AA-1", "AA-2", "AA-3"]) seed(`${n}.json`, 8 * DAY, now);
    expect(pruneHookStateFiles(vault, { nowMs: now, maxFiles: 2 })).toBe(2);
    expect(readdirSync(dir()).length).toBe(1);
  });

  test("ignores lockfiles and non-JSON files", () => {
    const now = Date.now();
    const lock = seed("AA-sess.json.lock", 8 * DAY, now);
    const txt = seed("AB-notes.txt", 8 * DAY, now);
    expect(pruneHookStateFiles(vault, { nowMs: now })).toBe(0);
    expect(existsSync(lock)).toBe(true);
    expect(existsSync(txt)).toBe(true);
  });
});
