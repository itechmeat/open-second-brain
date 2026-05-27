/**
 * Sync lockfile primitive for the brain write path. Single-attempt
 * exclusive create via `fs.openSync(target + '.lock', 'wx')`. Collisions
 * surface as a regular Error with `.code === 'ELOCKED'`; the brain
 * txn layer maps that to a `BrainCollisionError({ kind: 'SourceLock' })`.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { acquireLockSync, scanStaleLocks } from "../../../src/core/brain/sync-lockfile.ts";

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "osb-sync-lock-"));
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("acquireLockSync", () => {
  test("creates a .lock sibling file and release removes it", () => {
    const target = join(tmpRoot, "pref-foo.md");
    writeFileSync(target, "---\nkind: brain-preference\n---\n");

    const handle = acquireLockSync(target);
    expect(handle.path).toBe(target + ".lock");
    expect(existsSync(target + ".lock")).toBe(true);

    handle.release();
    expect(existsSync(target + ".lock")).toBe(false);
  });

  test("throws Error with code ELOCKED when the lock is already held", () => {
    const target = join(tmpRoot, "pref-bar.md");
    writeFileSync(target, "---\nkind: brain-preference\n---\n");

    const first = acquireLockSync(target);
    try {
      let caught: unknown;
      try {
        acquireLockSync(target);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as NodeJS.ErrnoException).code).toBe("ELOCKED");
    } finally {
      first.release();
    }
  });

  test("after release, target is acquirable again", () => {
    const target = join(tmpRoot, "pref-baz.md");
    writeFileSync(target, "---\n---\n");

    const first = acquireLockSync(target);
    first.release();
    const second = acquireLockSync(target);
    expect(existsSync(target + ".lock")).toBe(true);
    second.release();
  });

  test("release is idempotent (second call is a no-op)", () => {
    const target = join(tmpRoot, "pref-idem.md");
    writeFileSync(target, "");
    const handle = acquireLockSync(target);
    handle.release();
    handle.release(); // must not throw
    expect(existsSync(target + ".lock")).toBe(false);
  });

  test("acquire creates the lock even when the target file does not exist", () => {
    // The brain txn path needs to be able to lock the target before the
    // file is created (first-time write). The lock primitive must not
    // require the target to exist.
    const target = join(tmpRoot, "pref-new.md");
    const handle = acquireLockSync(target);
    try {
      expect(existsSync(target + ".lock")).toBe(true);
      expect(existsSync(target)).toBe(false);
    } finally {
      handle.release();
    }
  });
});

describe("scanStaleLocks", () => {
  test("returns paths of every .lock file under the given root", () => {
    const a = join(tmpRoot, "pref-a.md");
    const b = join(tmpRoot, "sub", "pref-b.md");
    writeFileSync(a, "");
    const ha = acquireLockSync(a);
    // Manually drop a lock under a subdirectory to exercise the walk.
    const subDir = join(tmpRoot, "sub");
    require("node:fs").mkdirSync(subDir, { recursive: true });
    writeFileSync(b + ".lock", "");

    const found = scanStaleLocks(tmpRoot).toSorted();
    expect(found).toContain(a + ".lock");
    expect(found).toContain(b + ".lock");

    ha.release();
    require("node:fs").unlinkSync(b + ".lock");
  });

  test("returns an empty array when no locks exist", () => {
    const found = scanStaleLocks(tmpRoot);
    expect(found).toEqual([]);
  });
});
