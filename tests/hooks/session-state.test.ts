import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  HOOK_STATE_STALE_LOCK_MS,
  _clearStaleLockForTests,
  hookStateFilePath,
  pruneHookStateFiles,
  readHookStamp,
  updateHookState,
  writeHookStamp,
} from "../../hooks/lib/session-state.ts";
import { _resetHeldLocksForTests } from "../../src/core/brain/sync-lockfile.ts";
import { IS_WINDOWS } from "../helpers/platform.ts";

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

  test("ids that differ only by case or punctuation get separate state files", () => {
    const a = hookStateFilePath(vault, "Sess_ABC");
    const b = hookStateFilePath(vault, "sess-abc");
    expect(a).not.toBe(b);
    expect(basename(b)).toBe("sess-abc.json");
    expect(basename(a)).toMatch(/^sess-abc-[0-9a-f]{16}\.json$/);
    writeHookStamp(vault, "Sess_ABC", KEY, { expiresAt: Date.now() + 5000 });
    expect(readHookStamp(vault, "sess-abc", KEY)).toBeNull();
    expect(readHookStamp(vault, "Sess_ABC", KEY)).not.toBeNull();
  });

  test("a host UUID keeps its plain file name", () => {
    const uuid = "3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c";
    expect(basename(hookStateFilePath(vault, uuid))).toBe(`${uuid}.json`);
  });

  test("long ids sharing a 64-character prefix get separate names inside the slug shape", () => {
    const prefix = "a".repeat(64);
    const one = basename(hookStateFilePath(vault, `${prefix}-one`));
    const two = basename(hookStateFilePath(vault, `${prefix}-two`));
    expect(one).not.toBe(two);
    for (const name of [one, two]) expect(name).toMatch(/^[a-z0-9-]{1,64}\.json$/);
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

  test("tryOnce returns busy on a held lock without running the mutator", () => {
    const lockPath = holdLock("sess-1");
    try {
      let calls = 0;
      const outcome = updateHookState(
        vault,
        "sess-1",
        (state) => {
          calls += 1;
          return { state, result: 1 };
        },
        { tryOnce: true },
      );
      expect(outcome).toEqual({ status: "busy" });
      expect(calls).toBe(0);
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      unlinkSync(lockPath);
      _resetHeldLocksForTests();
    }
  });

  test("without tryOnce it keeps the bounded retry before reporting busy", () => {
    const lockPath = holdLock("sess-1");
    try {
      // Count the retry sleeps (Atomics.wait) instead of timing them.
      const original = Atomics.wait;
      let sleeps = 0;
      Atomics.wait = ((...args: Parameters<typeof Atomics.wait>) => {
        sleeps += 1;
        return original(...args);
      }) as typeof Atomics.wait;
      let outcome: unknown;
      try {
        outcome = updateHookState(vault, "sess-1", (state) => ({ state, result: 1 }));
      } finally {
        Atomics.wait = original;
      }
      expect(outcome).toEqual({ status: "busy" });
      expect(sleeps).toBeGreaterThan(0);
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
      expect(readdirSync(dir()).filter((name) => name.includes(".stale-"))).toEqual([]);
    } finally {
      _resetHeldLocksForTests();
    }
  });

  test("the stale takeover moves the lockfile aside by rename, never unlinks it in place", () => {
    const lockPath = holdLock("sess-1");
    const old = (Date.now() - HOOK_STATE_STALE_LOCK_MS - 5_000) / 1000;
    utimesSync(lockPath, old, old);
    // Occupy the rename target with a non-empty directory: the rename fails,
    // so a takeover that goes through it must leave the stale lock in place.
    const aside = `${lockPath}.stale-${process.pid}`;
    mkdirSync(aside);
    writeFileSync(join(aside, "keep"), "");
    try {
      const outcome = updateHookState(vault, "sess-1", (state) => ({ state, result: 1 }), {
        tryOnce: true,
      });
      expect(outcome).toEqual({ status: "busy" });
      expect(existsSync(lockPath)).toBe(true);
    } finally {
      unlinkSync(lockPath);
      rmSync(aside, { recursive: true, force: true });
      _resetHeldLocksForTests();
    }
  });

  test("a takeover that moved a live lock puts it back and reports no takeover", () => {
    const lockPath = holdLock("sess-1");
    const liveIno = statSync(lockPath, { bigint: true }).ino;
    // The lock reads stale at the first check, but the file the rename moved
    // is fresh: another contender re-acquired in between.
    const staleOnlyUnderLockName = (path: string): boolean => path === lockPath;
    try {
      const tookOver = _clearStaleLockForTests(
        hookStateFilePath(vault, "sess-1"),
        staleOnlyUnderLockName,
      );
      expect(tookOver).toBe(false);
      expect(existsSync(lockPath)).toBe(true);
      expect(statSync(lockPath, { bigint: true }).ino).toBe(liveIno);
      expect(readdirSync(dir()).filter((name) => name.includes(".stale-"))).toEqual([]);
    } finally {
      unlinkSync(lockPath);
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

  test.skipIf(IS_WINDOWS)("writes replace the state file by rename (new inode)", () => {
    writeHookStamp(vault, "sess-1", KEY_A, { expiresAt: Number.MAX_SAFE_INTEGER });
    const before = statSync(hookStateFilePath(vault, "sess-1")).ino;
    writeHookStamp(vault, "sess-1", KEY_B, { expiresAt: Number.MAX_SAFE_INTEGER });
    expect(statSync(hookStateFilePath(vault, "sess-1")).ino).not.toBe(before);
  });

  test("writes leave no temp file behind", () => {
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

/** Point `.open-second-brain` or its `hook-state` directory at a fresh outside directory. */
function plantOutside(link: "hook-state" | ".open-second-brain"): string {
  const outside = mkdtempSync(join(tmpdir(), "o2b-hook-state-outside-"));
  if (link === "hook-state") {
    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    symlinkSync(outside, dir(), "dir");
  } else {
    symlinkSync(outside, join(vault, ".open-second-brain"), "dir");
  }
  return outside;
}

describe("symlinked hook-state directories", () => {
  const KEY = "osb.nav_tier.last_injected";
  // Far-future expiry: a stamp that expired mid-run would read as null for
  // that reason alone and pass the "reads as empty" cases vacuously.
  const LIVE = { expiresAt: Number.MAX_SAFE_INTEGER, data: { from: "outside" } };

  test("a real directory accepts the write (control)", () => {
    expect(updateHookState(vault, "sess-1", (state) => ({ state, result: 1 }))).toEqual({
      status: "ok",
      result: 1,
    });
    expect(readdirSync(dir())).toContain("sess-1.json");
  });

  for (const link of ["hook-state", ".open-second-brain"] as const) {
    test.skipIf(IS_WINDOWS)(
      `a symlinked ${link} fails the write and leaves the target empty`,
      () => {
        const outside = plantOutside(link);
        try {
          expect(updateHookState(vault, "sess-1", (state) => ({ state, result: 1 }))).toEqual({
            status: "failed",
          });
          expect(writeHookStamp(vault, "sess-1", KEY, LIVE)).toBe(false);
          expect(readdirSync(outside)).toEqual([]);
        } finally {
          rmSync(outside, { recursive: true, force: true });
        }
      },
    );

    test.skipIf(IS_WINDOWS)(`a symlinked ${link} reads as empty state`, () => {
      const outside = plantOutside(link);
      try {
        const stateDir = link === "hook-state" ? outside : join(outside, "hook-state");
        mkdirSync(stateDir, { recursive: true });
        writeFileSync(join(stateDir, "sess-1.json"), JSON.stringify({ [KEY]: LIVE }));
        expect(readHookStamp(vault, "sess-1", KEY)).toBeNull();
      } finally {
        rmSync(outside, { recursive: true, force: true });
      }
    });
  }

  test.skipIf(IS_WINDOWS)("a state file that is itself a symlink is not followed on read", () => {
    const outside = mkdtempSync(join(tmpdir(), "o2b-hook-state-outside-"));
    try {
      const target = join(outside, "planted.json");
      writeFileSync(target, JSON.stringify({ [KEY]: LIVE }));
      mkdirSync(dir(), { recursive: true });
      symlinkSync(target, hookStateFilePath(vault, "sess-1"));
      expect(readHookStamp(vault, "sess-1", KEY)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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
    const old = seed("aa-old.json", 8 * DAY, now);
    const fresh = seed("ab-fresh.json", 1 * DAY, now);
    expect(pruneHookStateFiles(vault, { nowMs: now })).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("honours a custom maxAgeMs", () => {
    const now = Date.now();
    const a = seed("aa-a.json", 2 * DAY, now);
    expect(pruneHookStateFiles(vault, { nowMs: now, maxAgeMs: DAY })).toBe(1);
    expect(existsSync(a)).toBe(false);
  });

  test("stops at maxFiles", () => {
    const now = Date.now();
    for (const n of ["aa-1", "aa-2", "aa-3"]) seed(`${n}.json`, 8 * DAY, now);
    expect(pruneHookStateFiles(vault, { nowMs: now, maxFiles: 2 })).toBe(2);
    expect(readdirSync(dir()).length).toBe(1);
  });

  test("sweeps old write and lock residue, keeps fresh locks and unrelated files", () => {
    const now = Date.now();
    const oldTmp = seed(".default.json.1.2.ab.tmp", 8 * DAY, now);
    const oldLock = seed("default.json.lock", 8 * DAY, now);
    const oldAside = seed("default.json.lock.stale-9", 8 * DAY, now);
    const freshLock = seed("aa-sess.json.lock", 1 * DAY, now);
    const freshTmp = seed(".aa-sess.json.3.4.cd.tmp", 1 * DAY, now);
    const txt = seed("notes.txt", 8 * DAY, now);
    const foreignTmp = seed(".Upper.json.1.2.ab.tmp", 8 * DAY, now);
    expect(pruneHookStateFiles(vault, { nowMs: now })).toBe(3);
    expect(existsSync(oldTmp)).toBe(false);
    expect(existsSync(oldLock)).toBe(false);
    expect(existsSync(oldAside)).toBe(false);
    expect(existsSync(freshLock)).toBe(true);
    expect(existsSync(freshTmp)).toBe(true);
    expect(existsSync(txt)).toBe(true);
    expect(existsSync(foreignTmp)).toBe(true);
  });

  test("leaves names outside the scope-slug shape alone", () => {
    const now = Date.now();
    const hostile = ["Upper.json", "under_score.json", "dot.ted.json", `${"a".repeat(65)}.json`];
    const paths = hostile.map((name) => seed(name, 8 * DAY, now));
    expect(pruneHookStateFiles(vault, { nowMs: now })).toBe(0);
    for (const path of paths) expect(existsSync(path)).toBe(true);
  });

  test.skipIf(IS_WINDOWS)("never sweeps through a symlinked hook-state directory", () => {
    const now = Date.now();
    const outside = mkdtempSync(join(tmpdir(), "o2b-hook-state-outside-"));
    try {
      const victim = join(outside, "victim.json");
      writeFileSync(victim, "{}\n");
      const t = (now - 8 * DAY) / 1000;
      utimesSync(victim, t, t);
      mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
      symlinkSync(outside, dir());
      expect(pruneHookStateFiles(vault, { nowMs: now })).toBe(0);
      expect(existsSync(victim)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test.skipIf(IS_WINDOWS)("never sweeps through a symlinked .open-second-brain directory", () => {
    const now = Date.now();
    const outside = mkdtempSync(join(tmpdir(), "o2b-hook-state-outside-"));
    try {
      mkdirSync(join(outside, "hook-state"));
      const victim = join(outside, "hook-state", "victim.json");
      writeFileSync(victim, "{}\n");
      const t = (now - 8 * DAY) / 1000;
      utimesSync(victim, t, t);
      symlinkSync(outside, join(vault, ".open-second-brain"));
      expect(pruneHookStateFiles(vault, { nowMs: now })).toBe(0);
      expect(existsSync(victim)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test.skipIf(IS_WINDOWS)("skips an entry that is itself a symlink", () => {
    const now = Date.now();
    const outside = mkdtempSync(join(tmpdir(), "o2b-hook-state-outside-"));
    try {
      const target = join(outside, "target.json");
      writeFileSync(target, "{}\n");
      const t = (now - 8 * DAY) / 1000;
      utimesSync(target, t, t);
      mkdirSync(dir(), { recursive: true });
      const link = join(dir(), "linked.json");
      symlinkSync(target, link);
      expect(pruneHookStateFiles(vault, { nowMs: now })).toBe(0);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(existsSync(target)).toBe(true);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
