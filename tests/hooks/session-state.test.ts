import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { hookStateFilePath, readHookStamp, writeHookStamp } from "../../hooks/lib/session-state.ts";
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
