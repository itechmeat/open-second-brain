import { describe, expect, test } from "bun:test";

import {
  PAGE_TIER,
  PAGE_TIER_DEFAULT,
  isPageTier,
  readTier,
  tierWeight,
} from "../../../../src/core/brain/page-meta/tier.ts";

describe("PAGE_TIER", () => {
  test("exposes exactly three tiers", () => {
    expect(Object.values(PAGE_TIER).toSorted()).toEqual(["core", "peripheral", "supporting"]);
  });

  test("default is supporting", () => {
    expect(PAGE_TIER_DEFAULT).toBe("supporting");
  });

  test("isPageTier predicate", () => {
    expect(isPageTier("core")).toBe(true);
    expect(isPageTier("supporting")).toBe(true);
    expect(isPageTier("peripheral")).toBe(true);
    expect(isPageTier("primary")).toBe(false);
    expect(isPageTier(undefined)).toBe(false);
  });
});

describe("readTier", () => {
  test("reads `tier` from frontmatter", () => {
    expect(readTier({ tier: "core" })).toBe("core");
    expect(readTier({ tier: "peripheral" })).toBe("peripheral");
  });

  test("defaults to supporting when missing", () => {
    expect(readTier({})).toBe("supporting");
  });

  test("defaults to supporting on typo", () => {
    expect(readTier({ tier: "Core" })).toBe("supporting");
    expect(readTier({ tier: "cor" })).toBe("supporting");
  });
});

describe("tierWeight", () => {
  test("supporting is the identity weight", () => {
    expect(tierWeight("supporting")).toBe(1.0);
  });

  test("core boosts above supporting", () => {
    expect(tierWeight("core")).toBeGreaterThan(tierWeight("supporting"));
  });

  test("peripheral discounts below supporting", () => {
    expect(tierWeight("peripheral")).toBeLessThan(tierWeight("supporting"));
  });

  test("each weight is positive", () => {
    expect(tierWeight("core")).toBeGreaterThan(0);
    expect(tierWeight("peripheral")).toBeGreaterThan(0);
  });
});
