import { describe, expect, test } from "bun:test";

import {
  BRAIN_CONFIDENCE,
  isPageConfidence,
  readConfidence,
} from "../../../../src/core/brain/page-meta/confidence.ts";

describe("PAGE_CONFIDENCE", () => {
  test("BRAIN_CONFIDENCE values are accepted", () => {
    for (const v of Object.values(BRAIN_CONFIDENCE)) {
      expect(isPageConfidence(v)).toBe(true);
    }
  });

  test("rejects junk", () => {
    expect(isPageConfidence("HIGH")).toBe(false);
    expect(isPageConfidence("super")).toBe(false);
    expect(isPageConfidence(undefined)).toBe(false);
    expect(isPageConfidence(0.9)).toBe(false);
  });
});

describe("readConfidence", () => {
  test("returns _confidence when present", () => {
    expect(readConfidence({ _confidence: "high" })).toBe("high");
    expect(readConfidence({ _confidence: "medium" })).toBe("medium");
  });

  test("falls back to legacy key", () => {
    expect(readConfidence({ confidence: "high" })).toBe("high");
  });

  test("defaults to low when missing or unrecognised", () => {
    expect(readConfidence({})).toBe("low");
    expect(readConfidence({ _confidence: "extreme" })).toBe("low");
  });

  test("modern shape wins over legacy", () => {
    expect(readConfidence({ _confidence: "high", confidence: "low" })).toBe("high");
  });
});
