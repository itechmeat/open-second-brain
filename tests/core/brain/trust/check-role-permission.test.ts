import { describe, expect, test } from "bun:test";

import { BRAIN_OPERATIONS, BRAIN_ROLES } from "../../../../src/core/brain/trust/role.ts";
import { checkRolePermission } from "../../../../src/core/brain/trust/check-role-permission.ts";

describe("checkRolePermission - allowed paths", () => {
  test("writer may write inbox feedback", () => {
    const r = checkRolePermission(BRAIN_ROLES.writer, BRAIN_OPERATIONS.feedback_write);
    expect(r.allowed).toBe(true);
  });

  test("writer may create an unconfirmed preference", () => {
    const r = checkRolePermission(
      BRAIN_ROLES.writer,
      BRAIN_OPERATIONS.preference_create_unconfirmed,
    );
    expect(r.allowed).toBe(true);
  });

  test("dreamer may promote unconfirmed to confirmed", () => {
    const r = checkRolePermission(
      BRAIN_ROLES.dreamer,
      BRAIN_OPERATIONS.preference_promote_confirmed,
      "unconfirmed",
    );
    expect(r.allowed).toBe(true);
  });

  test("dreamer may retire a preference", () => {
    const r = checkRolePermission(
      BRAIN_ROLES.dreamer,
      BRAIN_OPERATIONS.preference_retire,
      "confirmed",
    );
    expect(r.allowed).toBe(true);
  });

  test("applier may record evidence", () => {
    const r = checkRolePermission(BRAIN_ROLES.applier, BRAIN_OPERATIONS.evidence_record);
    expect(r.allowed).toBe(true);
  });

  test("applier may append narrative log", () => {
    const r = checkRolePermission(BRAIN_ROLES.applier, BRAIN_OPERATIONS.log_append);
    expect(r.allowed).toBe(true);
  });
});

describe("checkRolePermission - forbidden paths", () => {
  test("writer must not promote a preference to confirmed", () => {
    const r = checkRolePermission(
      BRAIN_ROLES.writer,
      BRAIN_OPERATIONS.preference_promote_confirmed,
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  test("writer must not retire a preference", () => {
    const r = checkRolePermission(BRAIN_ROLES.writer, BRAIN_OPERATIONS.preference_retire);
    expect(r.allowed).toBe(false);
  });

  test("dreamer must not write inbox feedback", () => {
    const r = checkRolePermission(BRAIN_ROLES.dreamer, BRAIN_OPERATIONS.feedback_write);
    expect(r.allowed).toBe(false);
  });

  test("dreamer must not record evidence", () => {
    const r = checkRolePermission(BRAIN_ROLES.dreamer, BRAIN_OPERATIONS.evidence_record);
    expect(r.allowed).toBe(false);
  });

  test("dreamer must not promote a preference that is already confirmed", () => {
    const r = checkRolePermission(
      BRAIN_ROLES.dreamer,
      BRAIN_OPERATIONS.preference_promote_confirmed,
      "confirmed",
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/already|wrong-source-state/);
  });

  test("dreamer + promote without currentStatus is denied (fail-closed)", () => {
    const r = checkRolePermission(
      BRAIN_ROLES.dreamer,
      BRAIN_OPERATIONS.preference_promote_confirmed,
    );
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/currentStatus is required|wrong-source-state/);
  });

  test("applier must not promote a preference", () => {
    const r = checkRolePermission(
      BRAIN_ROLES.applier,
      BRAIN_OPERATIONS.preference_promote_confirmed,
    );
    expect(r.allowed).toBe(false);
  });

  test("applier must not retire a preference", () => {
    const r = checkRolePermission(BRAIN_ROLES.applier, BRAIN_OPERATIONS.preference_retire);
    expect(r.allowed).toBe(false);
  });

  test("unknown role denies every operation", () => {
    for (const op of Object.values(BRAIN_OPERATIONS)) {
      const r = checkRolePermission(BRAIN_ROLES.unknown, op);
      expect(r.allowed).toBe(false);
    }
  });
});

describe("checkRolePermission - structural invariants", () => {
  test("returned object is frozen", () => {
    const r = checkRolePermission(BRAIN_ROLES.writer, BRAIN_OPERATIONS.feedback_write);
    expect(Object.isFrozen(r)).toBe(true);
  });
});
