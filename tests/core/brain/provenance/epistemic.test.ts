import { describe, expect, test } from "bun:test";

import {
  asEpistemicStatus,
  deriveEpistemicStatus,
  EPISTEMIC_STATUS,
  readEvidenceRefs,
} from "../../../../src/core/brain/provenance/epistemic.ts";

describe("asEpistemicStatus", () => {
  test("narrows a valid token case/space-insensitively", () => {
    expect(asEpistemicStatus("observed")).toBe("observed");
    expect(asEpistemicStatus("  Derived ")).toBe("derived");
    expect(asEpistemicStatus("PLAN")).toBe("plan");
  });

  test("rejects unknown strings and non-strings", () => {
    expect(asEpistemicStatus("guess")).toBeNull();
    expect(asEpistemicStatus(42)).toBeNull();
    expect(asEpistemicStatus(undefined)).toBeNull();
  });
});

describe("readEvidenceRefs", () => {
  test("reads an array, dropping blanks and trimming", () => {
    expect(readEvidenceRefs({ evidenced_by: ["[[sig-a]]", "  [[sig-b]] ", "", 7] })).toEqual([
      "[[sig-a]]",
      "[[sig-b]]",
    ]);
  });

  test("accepts a lone string and tolerates absence", () => {
    expect(readEvidenceRefs({ evidenced_by: "[[pref-x]]" })).toEqual(["[[pref-x]]"]);
    expect(readEvidenceRefs({})).toEqual([]);
    expect(readEvidenceRefs({ evidenced_by: null })).toEqual([]);
  });
});

describe("deriveEpistemicStatus", () => {
  test("stated + confirmed is observed and carries evidence refs", () => {
    const m = deriveEpistemicStatus({
      provenance: "stated",
      status: "confirmed",
      evidenced_by: ["[[sig-1]]"],
    });
    expect(m.status).toBe(EPISTEMIC_STATUS.observed);
    expect(m.evidenceRefs).toEqual(["[[sig-1]]"]);
  });

  test("absent provenance defaults to stated -> observed", () => {
    expect(deriveEpistemicStatus({ status: "confirmed" }).status).toBe(EPISTEMIC_STATUS.observed);
    // a page with no status at all is still an authored (observed) statement
    expect(deriveEpistemicStatus({}).status).toBe(EPISTEMIC_STATUS.observed);
  });

  test("deduced / inferred provenance is derived", () => {
    expect(deriveEpistemicStatus({ provenance: "deduced", evidenced_by: ["[[pref-a]]"] })).toEqual({
      status: EPISTEMIC_STATUS.derived,
      evidenceRefs: ["[[pref-a]]"],
    });
    expect(deriveEpistemicStatus({ provenance: "inferred" }).status).toBe(EPISTEMIC_STATUS.derived);
  });

  test("unconfirmed / quarantine stated preference is hypothesis", () => {
    expect(deriveEpistemicStatus({ status: "unconfirmed" }).status).toBe(
      EPISTEMIC_STATUS.hypothesis,
    );
    expect(deriveEpistemicStatus({ status: "quarantine" }).status).toBe(
      EPISTEMIC_STATUS.hypothesis,
    );
  });

  test("a disputed lifecycle is unknown regardless of provenance", () => {
    expect(
      deriveEpistemicStatus({ _lifecycle: "disputed", provenance: "stated", status: "confirmed" })
        .status,
    ).toBe(EPISTEMIC_STATUS.unknown);
    expect(deriveEpistemicStatus({ lifecycle: "disputed" }).status).toBe(EPISTEMIC_STATUS.unknown);
  });

  test("an explicit epistemic value overrides derivation - the only plan path", () => {
    const m = deriveEpistemicStatus({
      epistemic: "plan",
      provenance: "stated",
      status: "confirmed",
      evidenced_by: ["[[sig-2]]"],
    });
    expect(m.status).toBe(EPISTEMIC_STATUS.plan);
    // evidence refs still surface under an override
    expect(m.evidenceRefs).toEqual(["[[sig-2]]"]);
  });

  test("an invalid explicit value falls through to derivation", () => {
    expect(deriveEpistemicStatus({ epistemic: "bogus", status: "unconfirmed" }).status).toBe(
      EPISTEMIC_STATUS.hypothesis,
    );
  });
});
