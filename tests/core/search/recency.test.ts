import { test, expect } from "bun:test";
import { weibullDecay, DEFAULT_RECENCY } from "../../../src/core/search/recency.ts";

test("age 0 yields the full amplitude", () => {
  expect(weibullDecay(0, DEFAULT_RECENCY)).toBeCloseTo(DEFAULT_RECENCY.amplitude, 10);
});

test("a future item (negative age) is clamped to the full amplitude", () => {
  expect(weibullDecay(-5, DEFAULT_RECENCY)).toBeCloseTo(DEFAULT_RECENCY.amplitude, 10);
});

test("boost is monotonically non-increasing as age grows", () => {
  const ages = [1, 3, 7, 20, 45, 90, 150];
  let prev = Infinity;
  for (const a of ages) {
    const b = weibullDecay(a, DEFAULT_RECENCY);
    expect(b).toBeLessThanOrEqual(prev);
    prev = b;
  }
});

test("boost stays within [0, amplitude] across the curve", () => {
  for (const a of [0, 1, 10, 50, 100, 500, 5000]) {
    const b = weibullDecay(a, DEFAULT_RECENCY);
    expect(b).toBeGreaterThanOrEqual(0);
    expect(b).toBeLessThanOrEqual(DEFAULT_RECENCY.amplitude + 1e-12);
  }
});

test("very old content decays to exactly zero via the epsilon floor", () => {
  expect(weibullDecay(365, DEFAULT_RECENCY)).toBe(0);
});

test("a larger scale decays more slowly (higher boost at the same age)", () => {
  const fast = weibullDecay(60, { ...DEFAULT_RECENCY, scale: 15 });
  const slow = weibullDecay(60, { ...DEFAULT_RECENCY, scale: 120 });
  expect(slow).toBeGreaterThan(fast);
});

test("non-positive shape, scale, or amplitude disable the boost (returns 0)", () => {
  expect(weibullDecay(3, { shape: 0, scale: 30, amplitude: 0.05 })).toBe(0);
  expect(weibullDecay(3, { shape: 0.8, scale: 0, amplitude: 0.05 })).toBe(0);
  expect(weibullDecay(3, { shape: 0.8, scale: 30, amplitude: 0 })).toBe(0);
});

test("amplitude above 1 is clamped into [0, 1]", () => {
  expect(weibullDecay(0, { shape: 0.8, scale: 30, amplitude: 5 })).toBe(1);
});

test("is deterministic for identical inputs", () => {
  const a = weibullDecay(12.5, DEFAULT_RECENCY);
  const b = weibullDecay(12.5, DEFAULT_RECENCY);
  expect(a).toBe(b);
});
