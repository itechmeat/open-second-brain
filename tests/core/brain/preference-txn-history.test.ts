/**
 * Edit-history wiring at the write chokepoint (F4, Task 6).
 *
 * When `writePreferenceTxn` is given an edit-history option and the
 * write actually changes bytes, it appends field-level before/after
 * entries keyed by the resulting revision. A no-op rewrite appends
 * nothing; callers that omit the option create no sidecar (back-compat).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  brainDirs,
  preferenceHistoryPath,
} from "../../../src/core/brain/paths.ts";
import { writePreferenceTxn } from "../../../src/core/brain/preference-txn.ts";
import { readEditHistory } from "../../../src/core/brain/health/edit-history.ts";
import { BRAIN_PREFERENCE_STATUS } from "../../../src/core/brain/types.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-pref-txn-hist-"));
  mkdirSync(brainDirs(vault).preferences, { recursive: true });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
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

const history = {
  agent: "tester",
  now: () => new Date("2026-05-27T00:00:00Z"),
};

describe("writePreferenceTxn edit-history", () => {
  test("first write seeds the trail from current state", () => {
    writePreferenceTxn(vault, baseInput(), [], {}, history);
    const entries = readEditHistory(vault, "test-rule");
    const fields = entries.map((e) => e.field).sort();
    expect(fields).toEqual(["principle", "status"]);
    const principle = entries.find((e) => e.field === "principle")!;
    expect(principle.revision).toBe(1);
    expect(principle.before).toBeNull();
    expect(principle.after).toBe("do the right thing in production code");
    expect(principle.agent).toBe("tester");
  });

  test("a content change records the changed field at the new revision", () => {
    writePreferenceTxn(vault, baseInput(), [], {}, history);
    writePreferenceTxn(
      vault,
      baseInput({ principle: "always write tests first in code" }),
      [],
      { overwrite: true },
      history,
    );
    const entries = readEditHistory(vault, "test-rule");
    const rev2 = entries.filter((e) => e.revision === 2);
    expect(rev2.length).toBe(1);
    expect(rev2[0]!.field).toBe("principle");
    expect(rev2[0]!.before).toBe("do the right thing in production code");
    expect(rev2[0]!.after).toBe("always write tests first in code");
  });

  test("a no-op rewrite appends nothing new", () => {
    writePreferenceTxn(vault, baseInput(), [], {}, history);
    const before = readEditHistory(vault, "test-rule").length;
    writePreferenceTxn(vault, baseInput(), [], { overwrite: true }, history);
    expect(readEditHistory(vault, "test-rule").length).toBe(before);
  });

  test("omitting the history option creates no sidecar", () => {
    writePreferenceTxn(vault, baseInput(), [], {});
    expect(existsSync(preferenceHistoryPath(vault, "test-rule"))).toBe(false);
  });
});
