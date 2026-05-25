import { describe, expect, test } from "bun:test";

import {
  BRAIN_OPERATIONS,
  BRAIN_ROLES,
  isBrainOperation,
  isBrainRole,
} from "../../../../src/core/brain/trust/role.ts";

describe("BRAIN_ROLES", () => {
  test("enumerates exactly the four documented roles", () => {
    expect(Object.values(BRAIN_ROLES).sort()).toEqual([
      "applier",
      "dreamer",
      "unknown",
      "writer",
    ]);
  });

  test("isBrainRole accepts each canonical role", () => {
    for (const role of Object.values(BRAIN_ROLES)) {
      expect(isBrainRole(role)).toBe(true);
    }
  });

  test("isBrainRole rejects unknown strings and non-strings", () => {
    expect(isBrainRole("admin")).toBe(false);
    expect(isBrainRole("Writer")).toBe(false);
    expect(isBrainRole(undefined)).toBe(false);
    expect(isBrainRole(null)).toBe(false);
    expect(isBrainRole(0)).toBe(false);
  });
});

describe("BRAIN_OPERATIONS", () => {
  test("enumerates exactly the six documented operations", () => {
    expect(Object.values(BRAIN_OPERATIONS).sort()).toEqual([
      "evidence_record",
      "feedback_write",
      "log_append",
      "preference_create_unconfirmed",
      "preference_promote_confirmed",
      "preference_retire",
    ]);
  });

  test("isBrainOperation accepts each canonical operation", () => {
    for (const op of Object.values(BRAIN_OPERATIONS)) {
      expect(isBrainOperation(op)).toBe(true);
    }
  });

  test("isBrainOperation rejects unknown strings", () => {
    expect(isBrainOperation("preference_delete")).toBe(false);
    expect(isBrainOperation("")).toBe(false);
    expect(isBrainOperation(42)).toBe(false);
  });
});
