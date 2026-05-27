import { describe, expect, test } from "bun:test";

import { parseOptionalFiniteNumberInput } from "../../src/core/validate.ts";

describe("parseOptionalFiniteNumberInput", () => {
  test("treats absent and blank values as not provided", () => {
    expect(parseOptionalFiniteNumberInput(undefined)).toEqual({
      value: null,
      error: null,
    });
    expect(parseOptionalFiniteNumberInput(null)).toEqual({
      value: null,
      error: null,
    });
    expect(parseOptionalFiniteNumberInput("  ")).toEqual({
      value: null,
      error: null,
    });
  });

  test("accepts finite numbers and numeric strings", () => {
    expect(parseOptionalFiniteNumberInput(0.05)).toEqual({
      value: 0.05,
      error: null,
    });
    expect(parseOptionalFiniteNumberInput(" 0.05 ")).toEqual({
      value: 0.05,
      error: null,
    });
  });

  test("classifies non-finite numbers separately from bad shapes", () => {
    expect(parseOptionalFiniteNumberInput(Number.NaN)).toEqual({
      value: null,
      error: "finite-number",
    });
    expect(parseOptionalFiniteNumberInput("abc")).toEqual({
      value: null,
      error: "number-or-numeric-string",
    });
    expect(parseOptionalFiniteNumberInput(true)).toEqual({
      value: null,
      error: "number-or-numeric-string",
    });
  });
});
