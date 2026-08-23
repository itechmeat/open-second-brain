/**
 * The shared reconciliation vocabulary (nothing-writes-silently, shared
 * substrate). Pins:
 *
 * 1. `buildReconciliationReport` accepts a valid `{ attempted, found,
 *    missing }` triple and returns a report exposing exactly those values.
 * 2. The returned report and its `missing` array are both frozen, and the
 *    array is a defensive copy - mutating the caller's input array after
 *    the call does not change the stored report.
 * 3. `deriveReconciliationOutcome` reads `complete` when nothing is
 *    missing.
 * 4. It reads `partial` when `missing` names at least one key and no
 *    recorded claim contradicts the report.
 * 5. It reads `contradicted` when a recorded claim's `attempted` disagrees
 *    with the report's own `attempted`.
 * 6. It reads `contradicted` when a recorded claim's `found` disagrees
 *    with the report's own `found` - even when `missing` is empty, because
 *    a claim contradicting a clean report is still a contradiction.
 * 7. It is deterministic: the same report (and the same recorded claim)
 *    derives the same outcome on repeated calls.
 * 8. Refusal: a non-integer `attempted` (NaN and a fractional value) is
 *    named `invalid_count` and names the offending field.
 * 9. Refusal: a non-integer `found` (NaN and a fractional value) is named
 *    `invalid_count` and names the offending field.
 * 10. Refusal: a negative `attempted` or `found` is named `invalid_count`.
 * 11. Refusal: `found` greater than `attempted` is named
 *     `found_exceeds_attempted`, independent of `missing`.
 * 12. Refusal: `attempted !== found + missing.length` is named
 *     `count_mismatch` - the missing keys do not account for the gap.
 * 13. Refusal: a duplicate key inside `missing` is named
 *     `duplicate_missing_key` and the error names the offending key.
 * 14. There is no constructor that accepts a bare missing COUNT in place
 *     of the named array - `ReconciliationReportInput["missing"]` is a
 *     `ReadonlyArray<string>`, never a `number` (a compile-time claim
 *     checked here by a runtime probe: a report built from N distinct
 *     generated keys carries exactly those N keys back, never a count).
 * 15. `RECONCILIATION_OUTCOME` is frozen, `RECONCILIATION_OUTCOMES` lists
 *     every one of its values with no duplicates, and
 *     `isReconciliationOutcome` accepts every declared value and rejects
 *     non-member strings, non-strings, and `undefined`.
 */

import { describe, expect, test } from "bun:test";

import {
  buildReconciliationReport,
  deriveReconciliationOutcome,
  isReconciliationOutcome,
  RECONCILIATION_OUTCOME,
  RECONCILIATION_OUTCOMES,
  ReconciliationReportError,
  type ReconciliationReport,
} from "../../src/core/reconciliation-report.ts";

describe("buildReconciliationReport", () => {
  test("returns a report exposing the validated triple", () => {
    const report = buildReconciliationReport({
      attempted: 5,
      found: 3,
      missing: ["a", "b"],
    });
    expect(report.attempted).toBe(5);
    expect(report.found).toBe(3);
    expect(report.missing).toEqual(["a", "b"]);
  });

  test("the report and its missing array are frozen", () => {
    const report = buildReconciliationReport({ attempted: 1, found: 0, missing: ["only"] });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.missing)).toBe(true);
  });

  test("missing is copied defensively - mutating the input after the call is inert", () => {
    const input = ["a", "b"];
    const report = buildReconciliationReport({ attempted: 3, found: 1, missing: input });
    input.push("c");
    input[0] = "mutated";
    expect(report.missing).toEqual(["a", "b"]);
  });

  test("carries exactly the named keys back, never a count in their place", () => {
    const keys = ["alpha", "beta", "gamma"];
    const report = buildReconciliationReport({ attempted: 3, found: 0, missing: keys });
    expect(report.missing).toEqual(keys);
    expect(typeof report.missing).not.toBe("number");
  });

  describe("refusals", () => {
    test("NaN attempted is invalid_count naming the field", () => {
      expect(() =>
        buildReconciliationReport({ attempted: Number.NaN, found: 0, missing: [] }),
      ).toThrow(ReconciliationReportError);
      try {
        buildReconciliationReport({ attempted: Number.NaN, found: 0, missing: [] });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ReconciliationReportError);
        expect((err as ReconciliationReportError).code).toBe("invalid_count");
        expect((err as ReconciliationReportError).details["field"]).toBe("attempted");
      }
    });

    test("NaN found is invalid_count naming the field", () => {
      try {
        buildReconciliationReport({ attempted: 1, found: Number.NaN, missing: [] });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ReconciliationReportError);
        expect((err as ReconciliationReportError).code).toBe("invalid_count");
        expect((err as ReconciliationReportError).details["field"]).toBe("found");
      }
    });

    test("a fractional attempted is invalid_count", () => {
      try {
        buildReconciliationReport({ attempted: 2.5, found: 0, missing: [] });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ReconciliationReportError);
        expect((err as ReconciliationReportError).code).toBe("invalid_count");
      }
    });

    test("a fractional found is invalid_count", () => {
      try {
        buildReconciliationReport({ attempted: 2, found: 1.5, missing: [] });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ReconciliationReportError);
        expect((err as ReconciliationReportError).code).toBe("invalid_count");
      }
    });

    test("a negative attempted is invalid_count", () => {
      try {
        buildReconciliationReport({ attempted: -1, found: 0, missing: [] });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ReconciliationReportError);
        expect((err as ReconciliationReportError).code).toBe("invalid_count");
      }
    });

    test("a negative found is invalid_count", () => {
      try {
        buildReconciliationReport({ attempted: 1, found: -1, missing: [] });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ReconciliationReportError);
        expect((err as ReconciliationReportError).code).toBe("invalid_count");
      }
    });

    test("found greater than attempted is found_exceeds_attempted", () => {
      try {
        buildReconciliationReport({ attempted: 2, found: 5, missing: [] });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ReconciliationReportError);
        expect((err as ReconciliationReportError).code).toBe("found_exceeds_attempted");
      }
    });

    test("found exceeding attempted is refused even when missing would balance it", () => {
      // found=5 attempted=2 missing=[] never reaches the accounting check;
      // the nonsensical count is refused first, by its own name.
      try {
        buildReconciliationReport({ attempted: 2, found: 5, missing: [] });
        throw new Error("expected throw");
      } catch (err) {
        expect((err as ReconciliationReportError).code).toBe("found_exceeds_attempted");
      }
    });

    test("attempted not accounted for by found + missing.length is count_mismatch", () => {
      try {
        buildReconciliationReport({ attempted: 5, found: 2, missing: ["a"] }); // 2+1 != 5
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ReconciliationReportError);
        expect((err as ReconciliationReportError).code).toBe("count_mismatch");
      }
    });

    test("a duplicate missing key is duplicate_missing_key, naming the key", () => {
      try {
        buildReconciliationReport({ attempted: 4, found: 2, missing: ["dup", "dup"] });
        throw new Error("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(ReconciliationReportError);
        expect((err as ReconciliationReportError).code).toBe("duplicate_missing_key");
        expect((err as ReconciliationReportError).details["key"]).toBe("dup");
      }
    });
  });
});

describe("RECONCILIATION_OUTCOME vocabulary", () => {
  test("the values object is frozen", () => {
    expect(Object.isFrozen(RECONCILIATION_OUTCOME)).toBe(true);
  });

  test("the membership list is frozen and has no duplicates", () => {
    expect(Object.isFrozen(RECONCILIATION_OUTCOMES)).toBe(true);
    expect(new Set(RECONCILIATION_OUTCOMES).size).toBe(RECONCILIATION_OUTCOMES.length);
  });

  test("the guard accepts every declared value", () => {
    for (const value of Object.values(RECONCILIATION_OUTCOME)) {
      expect(isReconciliationOutcome(value)).toBe(true);
    }
  });

  test("the guard rejects non-members", () => {
    expect(isReconciliationOutcome("unknown-outcome")).toBe(false);
    expect(isReconciliationOutcome("")).toBe(false);
    expect(isReconciliationOutcome(undefined)).toBe(false);
    expect(isReconciliationOutcome(null)).toBe(false);
    expect(isReconciliationOutcome(42)).toBe(false);
  });
});

describe("deriveReconciliationOutcome", () => {
  function report(
    overrides: Partial<{ attempted: number; found: number; missing: string[] }> = {},
  ) {
    const attempted = overrides.attempted ?? 3;
    const missing = overrides.missing ?? [];
    const found = overrides.found ?? attempted - missing.length;
    return buildReconciliationReport({ attempted, found, missing });
  }

  test("complete when nothing is missing", () => {
    const r = report({ attempted: 3, missing: [] });
    expect(deriveReconciliationOutcome(r)).toBe(RECONCILIATION_OUTCOME.complete);
  });

  test("partial when missing names at least one key and no claim contradicts it", () => {
    const r = report({ attempted: 3, missing: ["x"] });
    expect(deriveReconciliationOutcome(r)).toBe(RECONCILIATION_OUTCOME.partial);
  });

  test("contradicted when a recorded claim's attempted disagrees", () => {
    const r = report({ attempted: 3, missing: [] });
    expect(deriveReconciliationOutcome(r, { attempted: 4 })).toBe(
      RECONCILIATION_OUTCOME.contradicted,
    );
  });

  test("contradicted when a recorded claim's found disagrees, even on a clean report", () => {
    const r: ReconciliationReport = report({ attempted: 3, missing: [] });
    expect(r.missing.length).toBe(0);
    expect(deriveReconciliationOutcome(r, { found: 0 })).toBe(RECONCILIATION_OUTCOME.contradicted);
  });

  test("is deterministic across repeated calls", () => {
    const r = report({ attempted: 5, missing: ["a", "b"] });
    const claim = { attempted: 5 };
    const first = deriveReconciliationOutcome(r, claim);
    const second = deriveReconciliationOutcome(r, claim);
    expect(first).toBe(second);
    expect(first).toBe(RECONCILIATION_OUTCOME.partial);
  });
});
