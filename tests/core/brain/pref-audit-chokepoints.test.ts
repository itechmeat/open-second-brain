/**
 * Audit capture at the mutation chokepoints (Brain lifecycle suite,
 * Feature 1, Task 2). `writePreferenceTxn`, `moveToRetired`, and
 * `mergePreferences` each append an authoritative audit record when a
 * mutation actually changes the preference. Callers that omit the audit
 * sink are unaffected (back-compat).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { writePreferenceTxn } from "../../../src/core/brain/preference-txn.ts";
import { moveToRetired } from "../../../src/core/brain/preference.ts";
import { mergePreferences } from "../../../src/core/brain/merge.ts";
import { readPrefAudit } from "../../../src/core/brain/pref-audit.ts";
import { preferencePath } from "../../../src/core/brain/paths.ts";
import { BRAIN_PREFERENCE_STATUS, BRAIN_RETIRED_REASON } from "../../../src/core/brain/types.ts";
import type { WritePreferenceInput } from "../../../src/core/brain/preference.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-audit-choke-"));
  mkdirSync(join(vault, "Brain", "preferences"), { recursive: true });
  mkdirSync(join(vault, "Brain", "retired"), { recursive: true });
  mkdirSync(join(vault, "Brain", "log"), { recursive: true });
  mkdirSync(join(vault, "Brain", "inbox", "processed"), { recursive: true });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

function baseInput(over: Partial<WritePreferenceInput> = {}): WritePreferenceInput {
  return {
    slug: "foo",
    topic: "foo",
    principle: "Prefer foo over bar",
    created_at: "2026-05-29T10:00:00Z",
    unconfirmed_until: "2026-06-12T10:00:00Z",
    status: BRAIN_PREFERENCE_STATUS.unconfirmed,
    evidenced_by: ["[[sig-2026-05-29-foo]]"],
    confidence_value: 0,
    ...over,
  };
}

const audit = (agent = "dream", reason?: string) => ({
  agent,
  ...(reason ? { reason } : {}),
  now: () => new Date("2026-05-29T12:00:00Z"),
});

describe("writePreferenceTxn audit sink", () => {
  test("records a create on the first write", () => {
    writePreferenceTxn(
      vault,
      baseInput(),
      [],
      { overwrite: false },
      undefined,
      audit("dream", "promoted from cluster"),
    );
    const { records } = readPrefAudit(vault, "pref-foo");
    expect(records).toHaveLength(1);
    expect(records[0]!.op).toBe("create");
    expect(records[0]!.agent).toBe("dream");
    expect(records[0]!.reason).toBe("promoted from cluster");
    expect(records[0]!.hash_before).toBeNull();
    expect(records[0]!.hash_after).not.toBeNull();
  });

  test("records a promote when status crosses to confirmed", () => {
    writePreferenceTxn(vault, baseInput(), [], { overwrite: false }, undefined, audit());
    writePreferenceTxn(
      vault,
      baseInput({
        status: BRAIN_PREFERENCE_STATUS.confirmed,
        confirmed_at: "2026-05-29T12:00:00Z",
      }),
      [],
      { overwrite: true },
      undefined,
      audit(),
    );
    const { records } = readPrefAudit(vault, "pref-foo");
    expect(records.map((r) => r.op)).toEqual(["create", "promote"]);
  });

  test("does NOT record a counter-only update (content unchanged)", () => {
    writePreferenceTxn(
      vault,
      baseInput({
        status: BRAIN_PREFERENCE_STATUS.confirmed,
        confirmed_at: "2026-05-29T12:00:00Z",
      }),
      [],
      { overwrite: false },
      undefined,
      audit(),
    );
    // Same principle/scope, only a counter moves -> update op, suppressed.
    writePreferenceTxn(
      vault,
      baseInput({
        status: BRAIN_PREFERENCE_STATUS.confirmed,
        confirmed_at: "2026-05-29T12:00:00Z",
        applied_count: 5,
      }),
      [],
      { overwrite: true },
      undefined,
      audit(),
    );
    const { records } = readPrefAudit(vault, "pref-foo");
    expect(records.map((r) => r.op)).toEqual(["create"]);
  });

  test("writes no audit file when the sink is omitted (back-compat)", () => {
    writePreferenceTxn(vault, baseInput(), [], { overwrite: false });
    const { records } = readPrefAudit(vault, "pref-foo");
    expect(records).toHaveLength(0);
  });
});

describe("moveToRetired audit sink", () => {
  test("records a retire keyed by the original pref id", () => {
    writePreferenceTxn(
      vault,
      baseInput({
        status: BRAIN_PREFERENCE_STATUS.confirmed,
        confirmed_at: "2026-05-29T12:00:00Z",
      }),
      [],
      { overwrite: false },
      undefined,
      audit(),
    );
    moveToRetired(vault, preferencePath(vault, "foo"), BRAIN_RETIRED_REASON.rebutted, {
      now: new Date("2026-05-30T09:00:00Z"),
      retired_by: "[[Brain/log/2026-05-30]]",
      audit: { agent: "operator" },
    });
    const { records } = readPrefAudit(vault, "pref-foo");
    expect(records.map((r) => r.op)).toEqual(["create", "retire"]);
    expect(records[1]!.agent).toBe("operator");
    expect(records[1]!.reason).toBe(BRAIN_RETIRED_REASON.rebutted);
  });
});

describe("mergePreferences audit", () => {
  test("records merge on keep and retire(merged-into) on drop", () => {
    for (const slug of ["keep", "drop"]) {
      writePreferenceTxn(
        vault,
        baseInput({
          slug,
          topic: "shared",
          principle: `Principle ${slug}`,
          status: BRAIN_PREFERENCE_STATUS.confirmed,
          confirmed_at: "2026-05-29T12:00:00Z",
          evidenced_by: [`[[sig-2026-05-29-${slug}]]`],
        }),
        [],
        { overwrite: false },
        undefined,
        audit(),
      );
    }
    mergePreferences(vault, "pref-keep", "pref-drop", {
      now: new Date("2026-05-31T09:00:00Z"),
      agentName: "operator",
    });
    const keep = readPrefAudit(vault, "pref-keep");
    const drop = readPrefAudit(vault, "pref-drop");
    expect(keep.records.map((r) => r.op)).toEqual(["create", "merge"]);
    expect(drop.records.map((r) => r.op)).toEqual(["create", "retire"]);
    expect(drop.records[1]!.reason).toBe(BRAIN_RETIRED_REASON.mergedInto);
  });
});
