import { describe, expect, test } from "bun:test";

import { clamp01 } from "../../src/core/math.ts";

describe("clamp01", () => {
  test("passes values already in [0, 1] through unchanged", () => {
    expect(clamp01(0)).toBe(0);
    expect(clamp01(1)).toBe(1);
    expect(clamp01(0.42)).toBe(0.42);
  });

  test("clamps below 0 and above 1", () => {
    expect(clamp01(-0.5)).toBe(0);
    expect(clamp01(1.5)).toBe(1);
  });

  test("clamps non-finite input to 0", () => {
    expect(clamp01(NaN)).toBe(0);
    expect(clamp01(Infinity)).toBe(0);
    expect(clamp01(-Infinity)).toBe(0);
  });
});
