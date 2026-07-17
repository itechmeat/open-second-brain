import { describe, expect, test } from "bun:test";

import type { DreamWarning } from "../../../../src/core/brain/dream.ts";
import type { DoctorIssue } from "../../../../src/core/brain/types.ts";
import { computeTrustVerdict } from "../../../../src/core/brain/trust/compute-trust-verdict.ts";
import type { VerificationDeltaSummaryCounts } from "../../../../src/core/brain/trust/compute-verification-delta.ts";

const ZERO_DELTA: VerificationDeltaSummaryCounts = {
  confirmed: 0,
  drift: 0,
  regression: 0,
  missing_evidence: 0,
};

function issue(severity: "warning" | "error"): DoctorIssue {
  return { severity, code: "test-issue", message: "test" };
}

function dreamWarn(): DreamWarning {
  return { code: "test-warn", message: "test" };
}

describe("computeTrustVerdict", () => {
  test("clean: zero everything", () => {
    expect(
      computeTrustVerdict({
        doctorWarnings: [],
        doctorErrors: [],
        dreamWarnings: [],
        verification: ZERO_DELTA,
      }),
    ).toBe("clean");
  });

  test("investigate: any doctor error", () => {
    expect(
      computeTrustVerdict({
        doctorWarnings: [],
        doctorErrors: [issue("error")],
        dreamWarnings: [],
        verification: ZERO_DELTA,
      }),
    ).toBe("investigate");
  });

  test("investigate: any regression entry", () => {
    expect(
      computeTrustVerdict({
        doctorWarnings: [],
        doctorErrors: [],
        dreamWarnings: [],
        verification: { ...ZERO_DELTA, regression: 1 },
      }),
    ).toBe("investigate");
  });

  test("investigate: any missing_evidence entry", () => {
    expect(
      computeTrustVerdict({
        doctorWarnings: [],
        doctorErrors: [],
        dreamWarnings: [],
        verification: { ...ZERO_DELTA, missing_evidence: 1 },
      }),
    ).toBe("investigate");
  });

  test("investigate: drift count above threshold", () => {
    expect(
      computeTrustVerdict({
        doctorWarnings: [],
        doctorErrors: [],
        dreamWarnings: [],
        verification: { ...ZERO_DELTA, drift: 5 },
      }),
    ).toBe("investigate");
  });

  test("watch: doctor warning alone", () => {
    expect(
      computeTrustVerdict({
        doctorWarnings: [issue("warning")],
        doctorErrors: [],
        dreamWarnings: [],
        verification: ZERO_DELTA,
      }),
    ).toBe("watch");
  });

  test("watch: dream warning alone", () => {
    expect(
      computeTrustVerdict({
        doctorWarnings: [],
        doctorErrors: [],
        dreamWarnings: [dreamWarn()],
        verification: ZERO_DELTA,
      }),
    ).toBe("watch");
  });

  test("watch: drift count below threshold", () => {
    expect(
      computeTrustVerdict({
        doctorWarnings: [],
        doctorErrors: [],
        dreamWarnings: [],
        verification: { ...ZERO_DELTA, drift: 2 },
      }),
    ).toBe("watch");
  });

  test("clean: confirmed entries do NOT downgrade verdict", () => {
    expect(
      computeTrustVerdict({
        doctorWarnings: [],
        doctorErrors: [],
        dreamWarnings: [],
        verification: { ...ZERO_DELTA, confirmed: 42 },
      }),
    ).toBe("clean");
  });

  test("investigate overrides watch", () => {
    expect(
      computeTrustVerdict({
        doctorWarnings: [issue("warning")],
        doctorErrors: [issue("error")],
        dreamWarnings: [dreamWarn()],
        verification: ZERO_DELTA,
      }),
    ).toBe("investigate");
  });
});

describe("computeTrustVerdict - custom threshold", () => {
  test("custom drift threshold honored", () => {
    expect(
      computeTrustVerdict({
        doctorWarnings: [],
        doctorErrors: [],
        dreamWarnings: [],
        verification: { ...ZERO_DELTA, drift: 1 },
        driftWatchThreshold: 0,
      }),
    ).toBe("investigate");
  });
});
