/**
 * Seam 2 - stamp comparison, the typed mismatch, and the three-mode gate.
 *
 * The module is domain-agnostic on purpose: units B, E and J each supply
 * their own token map, so these tests use field names from three
 * unrelated domains (and some that belong to none) to prove nothing is
 * baked in.
 */

import { describe, expect, test } from "bun:test";

import {
  GATE_MODE,
  GATE_MODES,
  STAMP_VERDICT,
  checkStamp,
  compareStamps,
  formatStampMismatch,
  isGateMode,
  type GateMode,
  type StampTokens,
} from "../../../src/core/integrity/stamp.ts";

function assertNever(value: never): never {
  throw new Error(`unhandled gate mode: ${String(value)}`);
}

/** Exhaustiveness proof - a new mode without an arm fails typecheck. */
function refusesOn(mode: GateMode): boolean {
  switch (mode) {
    case GATE_MODE.off:
      return false;
    case GATE_MODE.warn:
      return false;
    case GATE_MODE.fail:
      return true;
    default:
      return assertNever(mode);
  }
}

describe("GATE_MODE vocabulary", () => {
  test("is exactly off | warn | fail and is frozen", () => {
    expect([...GATE_MODES]).toEqual(["off", "warn", "fail"]);
    expect(Object.isFrozen(GATE_MODE)).toBe(true);
  });

  test("every member is handled by an exhaustive switch", () => {
    for (const mode of GATE_MODES) {
      expect(refusesOn(mode)).toBeTypeOf("boolean");
    }
  });

  test("isGateMode accepts the three tokens and nothing else", () => {
    for (const mode of GATE_MODES) {
      expect(isGateMode(mode)).toBe(true);
    }
    for (const bad of ["OFF", "Off", "on", "true", "", " off", "fail ", 0, 1, true, null, {}, []]) {
      expect(isGateMode(bad)).toBe(false);
    }
  });
});

describe("compareStamps", () => {
  test("identical token maps produce no mismatch", () => {
    const tokens: StampTokens = { corpus_generation: "41", brain_tree: "ab12" };
    expect(compareStamps(tokens, { ...tokens })).toEqual([]);
  });

  test("two empty maps produce no mismatch", () => {
    expect(compareStamps({}, {})).toEqual([]);
  });

  test("a differing value yields one mismatch carrying field, expected and actual", () => {
    const found = compareStamps(
      { embedding_model: "modelA", embedding_dimension: "384" },
      { embedding_model: "modelB", embedding_dimension: "384" },
    );
    expect(found).toEqual([{ field: "embedding_model", expected: "modelA", actual: "modelB" }]);
  });

  test("a key recorded on one side only compares against null", () => {
    expect(compareStamps({ vec_version: "0.1.7" }, {})).toEqual([
      { field: "vec_version", expected: "0.1.7", actual: null },
    ]);
    expect(compareStamps({}, { vault_id: "01J..." })).toEqual([
      { field: "vault_id", expected: null, actual: "01J..." },
    ]);
  });

  test("an explicit null is identical to an absent key", () => {
    expect(compareStamps({ vec_version: null }, {})).toEqual([]);
    expect(compareStamps({}, { vec_version: null })).toEqual([]);
    expect(compareStamps({ vec_version: null }, { vec_version: null })).toEqual([]);
  });

  test("an empty string is a recorded value, distinct from null", () => {
    expect(compareStamps({ token: "" }, { token: null })).toEqual([
      { field: "token", expected: "", actual: null },
    ]);
  });

  test("mismatches are ordered by field name regardless of key insertion order", () => {
    const a = compareStamps(
      { zeta: "1", alpha: "1", middle: "1" },
      { middle: "2", zeta: "2", alpha: "2" },
    );
    const b = compareStamps(
      { alpha: "1", middle: "1", zeta: "1" },
      { alpha: "2", middle: "2", zeta: "2" },
    );
    expect(a.map((m) => m.field)).toEqual(["alpha", "middle", "zeta"]);
    expect(a).toEqual(b);
  });

  test("is domain-agnostic: arbitrary field names are compared the same way", () => {
    const found = compareStamps(
      { "some.unrelated/field": "x", 另一个: "y" },
      { "some.unrelated/field": "x", 另一个: "z" },
    );
    expect(found).toEqual([{ field: "另一个", expected: "y", actual: "z" }]);
  });

  test("each mismatch record is frozen", () => {
    const [first] = compareStamps({ a: "1" }, { a: "2" });
    expect(first).toBeDefined();
    expect(Object.isFrozen(first)).toBe(true);
  });
});

describe("checkStamp", () => {
  const expected: StampTokens = { generation: "41", digest: "aaaa" };
  const drifted: StampTokens = { generation: "42", digest: "aaaa" };

  test("off does not compare at all - no verdict, no evidence, no output to emit", () => {
    const check = checkStamp(expected, drifted, GATE_MODE.off);
    expect(check.verdict).toBe(STAMP_VERDICT.pass);
    expect(check.mismatches).toEqual([]);
    expect(check.mode).toBe(GATE_MODE.off);
  });

  test("warn reports the drift without refusing", () => {
    const check = checkStamp(expected, drifted, GATE_MODE.warn);
    expect(check.verdict).toBe(STAMP_VERDICT.warn);
    expect(check.mismatches.map((m) => m.field)).toEqual(["generation"]);
  });

  test("fail reports the drift as a refusal", () => {
    const check = checkStamp(expected, drifted, GATE_MODE.fail);
    expect(check.verdict).toBe(STAMP_VERDICT.fail);
    expect(check.mismatches.map((m) => m.field)).toEqual(["generation"]);
  });

  test("a matching stamp passes under every mode with no mismatches", () => {
    for (const mode of GATE_MODES) {
      const check = checkStamp(expected, { ...expected }, mode);
      expect(check.verdict).toBe(STAMP_VERDICT.pass);
      expect(check.mismatches).toEqual([]);
    }
  });

  test("the check record is frozen", () => {
    expect(Object.isFrozen(checkStamp(expected, drifted, GATE_MODE.warn))).toBe(true);
  });
});

describe("formatStampMismatch", () => {
  test("renders one English line naming the field and both values", () => {
    const line = formatStampMismatch({
      field: "embedding_dimension",
      expected: "384",
      actual: "768",
    });
    expect(line.includes("\n")).toBe(false);
    expect(line).toContain("embedding_dimension");
    expect(line).toContain("384");
    expect(line).toContain("768");
  });

  test("renders an unrecorded side explicitly rather than as an empty gap", () => {
    const line = formatStampMismatch({ field: "vec_version", expected: "0.1.7", actual: null });
    expect(line.includes("\n")).toBe(false);
    expect(line).toContain("vec_version");
    expect(line).toContain("0.1.7");
    // A null side must be visibly named, not rendered as nothing.
    expect(line.trim().endsWith(":")).toBe(false);
    expect(line).not.toContain("null,");
  });

  test("distinguishes an empty recorded value from an unrecorded one", () => {
    const empty = formatStampMismatch({ field: "t", expected: "", actual: "x" });
    const missing = formatStampMismatch({ field: "t", expected: null, actual: "x" });
    expect(empty).not.toBe(missing);
  });

  test("collapses whitespace so a token carrying a newline stays on one line", () => {
    const line = formatStampMismatch({ field: "t", expected: "a\nb", actual: "c" });
    expect(line.includes("\n")).toBe(false);
  });

  test("is deterministic for equal inputs", () => {
    const m = { field: "t", expected: "a", actual: "b" } as const;
    expect(formatStampMismatch(m)).toBe(formatStampMismatch({ ...m }));
  });
});

/**
 * The gate vocabulary is closed, and `checkStamp` used to coerce
 * anything that was not `off` or `fail` into `warn` - so a mode that
 * reached it from an unvalidated path resolved to the softest verdict.
 * A gate that softens on an unrecognised token is indistinguishable from
 * an operator who asked for a warning, which is the class of silent
 * degradation this seam exists to remove.
 */
describe("checkStamp rejects a mode outside the closed vocabulary", () => {
  test("an unknown mode throws instead of resolving to warn", () => {
    expect(() => checkStamp({ a: "1" }, { a: "2" }, "lenient" as unknown as GateMode)).toThrow(
      /lenient/,
    );
  });

  test("every declared mode is accepted", () => {
    for (const mode of GATE_MODES) {
      expect(() => checkStamp({ a: "1" }, { a: "2" }, mode)).not.toThrow();
    }
  });
});
