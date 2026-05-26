/**
 * `writePreferenceTxn` - the single chokepoint that wraps every
 * preference write. Acquires the sync lock, re-reads the current
 * file state, runs an expectations chain that can raise typed
 * `BrainCollisionError`, then mutates via `writeFrontmatterAtomic`.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  brainDirs,
  preferencePath,
} from "../../../src/core/brain/paths.ts";
import { parsePreference } from "../../../src/core/brain/preference.ts";
import {
  BrainCollisionError,
  BRAIN_COLLISION_KIND,
  writePreferenceTxn,
  type WritePreferenceExpectation,
} from "../../../src/core/brain/preference-txn.ts";
import { acquireLockSync } from "../../../src/core/brain/sync-lockfile.ts";
import { BRAIN_PREFERENCE_STATUS } from "../../../src/core/brain/types.ts";

let tmpRoot: string;
let vault: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "osb-pref-txn-"));
  vault = tmpRoot;
  // Ensure Brain/preferences/ exists so the writer can drop the file.
  require("node:fs").mkdirSync(brainDirs(vault).preferences, {
    recursive: true,
  });
});

afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

const baseInput = (overrides: Record<string, unknown> = {}) => ({
  slug: "test-rule",
  topic: "test-topic",
  principle: "do the right thing in production code",
  created_at: "2026-05-26T12:00:00Z",
  unconfirmed_until: "2026-06-02T12:00:00Z",
  status: BRAIN_PREFERENCE_STATUS.unconfirmed,
  evidenced_by: [] as ReadonlyArray<string>,
  ...overrides,
});

describe("BRAIN_COLLISION_KIND", () => {
  test("exposes the four discriminant string values", () => {
    expect(BRAIN_COLLISION_KIND.staleUpdate).toBe("StaleUpdate");
    expect(BRAIN_COLLISION_KIND.unsafeShrink).toBe("UnsafeShrink");
    expect(BRAIN_COLLISION_KIND.sourceLock).toBe("SourceLock");
    expect(BRAIN_COLLISION_KIND.duplicateWrite).toBe("DuplicateWrite");
  });
});

describe("BrainCollisionError", () => {
  test("kind field is preserved on instances", () => {
    const err = new BrainCollisionError(
      BRAIN_COLLISION_KIND.staleUpdate,
      "test message",
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe("StaleUpdate");
    expect(err.name).toBe("BrainCollisionError");
    expect(err.message).toBe("test message");
  });
});

describe("writePreferenceTxn", () => {
  test("with empty expectations writes a preference identical to writePreference", () => {
    const result = writePreferenceTxn(vault, baseInput(), [], {});
    expect(result.id).toBe("pref-test-rule");
    expect(existsSync(result.path)).toBe(true);
    // Lock file must be cleaned up after the txn returns.
    expect(existsSync(result.path + ".lock")).toBe(false);
    const parsed = parsePreference(result.path);
    expect(parsed.principle).toBe("do the right thing in production code");
    expect(parsed.topic).toBe("test-topic");
  });

  test("raises BrainCollisionError(SourceLock) when the lock is already held", () => {
    const path = preferencePath(vault, "held-rule");
    const handle = acquireLockSync(path);
    try {
      let caught: unknown;
      try {
        writePreferenceTxn(vault, baseInput({ slug: "held-rule" }), [], {});
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BrainCollisionError);
      expect((caught as BrainCollisionError).kind).toBe("SourceLock");
    } finally {
      handle.release();
    }
  });

  test("runs expectations chain in order; first failure short-circuits", () => {
    // First write to seed the on-disk state.
    writePreferenceTxn(vault, baseInput({ slug: "chain-rule" }), [], {});

    const calls: string[] = [];
    const ok: WritePreferenceExpectation = () => {
      calls.push("ok");
    };
    const fail: WritePreferenceExpectation = () => {
      calls.push("fail");
      throw new BrainCollisionError(
        BRAIN_COLLISION_KIND.staleUpdate,
        "deliberate failure",
      );
    };
    const never: WritePreferenceExpectation = () => {
      calls.push("never");
    };

    let caught: unknown;
    try {
      writePreferenceTxn(
        vault,
        baseInput({
          slug: "chain-rule",
          principle: "updated principle text",
        }),
        [ok, fail, never],
        { overwrite: true },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BrainCollisionError);
    expect((caught as BrainCollisionError).kind).toBe("StaleUpdate");
    expect(calls).toEqual(["ok", "fail"]); // `never` was not invoked
  });

  test("releases the lock even when an expectation throws", () => {
    writePreferenceTxn(vault, baseInput({ slug: "release-rule" }), [], {});
    const failingExpectation: WritePreferenceExpectation = () => {
      throw new BrainCollisionError(
        BRAIN_COLLISION_KIND.duplicateWrite,
        "blocked",
      );
    };

    let caught: unknown;
    try {
      writePreferenceTxn(
        vault,
        baseInput({ slug: "release-rule" }),
        [failingExpectation],
        { overwrite: true },
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(BrainCollisionError);

    // Lock must be released even though the write was aborted.
    const lockPath = preferencePath(vault, "release-rule") + ".lock";
    expect(existsSync(lockPath)).toBe(false);

    // A follow-up write with empty expectations must succeed.
    const ok = writePreferenceTxn(
      vault,
      baseInput({ slug: "release-rule" }),
      [],
      { overwrite: true },
    );
    expect(existsSync(ok.path)).toBe(true);
  });

  test("expectation receives the existing preference when overwriting", () => {
    writePreferenceTxn(
      vault,
      baseInput({ slug: "ctx-rule", principle: "original principle text" }),
      [],
      {},
    );

    let observedExistingPrinciple: string | null = null;
    const inspect: WritePreferenceExpectation = (ctx) => {
      observedExistingPrinciple = ctx.existing?.principle ?? null;
    };

    writePreferenceTxn(
      vault,
      baseInput({ slug: "ctx-rule", principle: "replacement principle text" }),
      [inspect],
      { overwrite: true },
    );
    expect(observedExistingPrinciple).toBe("original principle text");
  });

  test("expectation context shows existing=null on first write", () => {
    let observedExisting: unknown = "unset";
    const inspect: WritePreferenceExpectation = (ctx) => {
      observedExisting = ctx.existing;
    };
    writePreferenceTxn(vault, baseInput({ slug: "first-rule" }), [inspect], {});
    expect(observedExisting).toBeNull();
  });

  test("file bytes match what writePreference would have produced (no txn overhead)", () => {
    const result = writePreferenceTxn(
      vault,
      baseInput({ slug: "bytewise-rule", principle: "exact bytes please" }),
      [],
      {},
    );
    const text = readFileSync(result.path, "utf8");
    expect(text).toContain("principle: exact bytes please");
    expect(text).toContain("kind: brain-preference");
    expect(text).toContain("_status: unconfirmed");
  });
});
