/**
 * v0.10.16: brain_apply_evidence integrates check-role-permission. The
 * applier role may record evidence; writer and dreamer roles are
 * rejected with a structured error.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendApplyEvidence,
  BrainRolePermissionError,
} from "../../../src/core/brain/apply-evidence.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { writePreference } from "../../../src/core/brain/preference.ts";
import { BRAIN_ROLES } from "../../../src/core/brain/trust/role.ts";

let vault: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-apply-role-"));
  bootstrapBrain(vault);
  writePreference(vault, {
    slug: "test-rule",
    topic: "test",
    principle: "limit X to 10",
    created_at: "2026-05-20T00:00:00Z",
    confirmed_at: "2026-05-21T00:00:00Z",
    unconfirmed_until: "2026-06-03T00:00:00Z",
    status: "confirmed",
    evidenced_by: ["[[sig-1]]"],
    applied_count: 1,
    violated_count: 0,
    last_evidence_at: "2026-05-22T00:00:00Z",
    confidence: "low",
  });
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

describe("apply-evidence role enforcement", () => {
  test("applier role can record evidence", () => {
    const r = appendApplyEvidence(
      vault,
      {
        pref_id: "test-rule",
        artifact: "[[example]]",
        result: "applied",
        agent: "test-agent",
      },
      { role: BRAIN_ROLES.applier },
    );
    expect(r.logged_at).toBeTruthy();
  });

  test("writer role rejected with BrainRolePermissionError", () => {
    expect(() =>
      appendApplyEvidence(
        vault,
        {
          pref_id: "test-rule",
          artifact: "[[example]]",
          result: "applied",
          agent: "test-agent",
        },
        { role: BRAIN_ROLES.writer },
      ),
    ).toThrow(BrainRolePermissionError);
  });

  test("dreamer role rejected", () => {
    expect(() =>
      appendApplyEvidence(
        vault,
        {
          pref_id: "test-rule",
          artifact: "[[example]]",
          result: "applied",
          agent: "test-agent",
        },
        { role: BRAIN_ROLES.dreamer },
      ),
    ).toThrow(BrainRolePermissionError);
  });

  test("unknown role rejected", () => {
    expect(() =>
      appendApplyEvidence(
        vault,
        {
          pref_id: "test-rule",
          artifact: "[[example]]",
          result: "applied",
          agent: "test-agent",
        },
        { role: BRAIN_ROLES.unknown },
      ),
    ).toThrow(BrainRolePermissionError);
  });

  test("role omitted: backward-compatible (no enforcement)", () => {
    // Existing callers that never threaded a role through stay green.
    const r = appendApplyEvidence(vault, {
      pref_id: "test-rule",
      artifact: "[[example]]",
      result: "applied",
      agent: "test-agent",
    });
    expect(r.logged_at).toBeTruthy();
  });
});
