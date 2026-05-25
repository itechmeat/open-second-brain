import { describe, expect, test } from "bun:test";

import {
  PAGE_LIFECYCLE,
  PAGE_STALE_DAYS_DEFAULT,
  ageDaysFromIso,
  isPageLifecycle,
  isStale,
  readLifecycle,
} from "../../../../src/core/brain/page-meta/lifecycle.ts";

describe("PAGE_LIFECYCLE", () => {
  test("enumerates exactly the six documented values", () => {
    expect(Object.values(PAGE_LIFECYCLE).sort()).toEqual([
      "archived",
      "deprecated",
      "disputed",
      "draft",
      "stable",
      "verified",
    ]);
  });

  test("isPageLifecycle accepts each canonical value", () => {
    for (const v of Object.values(PAGE_LIFECYCLE)) {
      expect(isPageLifecycle(v)).toBe(true);
    }
  });

  test("isPageLifecycle rejects junk", () => {
    expect(isPageLifecycle("draft ")).toBe(false);
    expect(isPageLifecycle("DRAFT")).toBe(false);
    expect(isPageLifecycle("retired")).toBe(false);
    expect(isPageLifecycle(undefined)).toBe(false);
    expect(isPageLifecycle(null)).toBe(false);
    expect(isPageLifecycle(0)).toBe(false);
  });
});

describe("readLifecycle", () => {
  test("returns _lifecycle when present", () => {
    expect(readLifecycle({ _lifecycle: "verified" })).toBe("verified");
  });

  test("falls back to legacy lifecycle key when _-prefixed absent", () => {
    expect(readLifecycle({ lifecycle: "deprecated" })).toBe("deprecated");
  });

  test("defaults to stable when both absent", () => {
    expect(readLifecycle({})).toBe("stable");
    expect(readLifecycle({ topic: "x" })).toBe("stable");
  });

  test("defaults to stable on unknown value", () => {
    expect(readLifecycle({ _lifecycle: "rotten" })).toBe("stable");
  });

  test("modern shape wins over legacy", () => {
    expect(
      readLifecycle({ _lifecycle: "verified", lifecycle: "draft" }),
    ).toBe("verified");
  });
});

describe("isStale", () => {
  test("returns false when ageDays is below the threshold", () => {
    expect(isStale("stable", 10)).toBe(false);
    expect(isStale("draft", 100)).toBe(false);
  });

  test("returns true for stable past threshold", () => {
    expect(isStale("stable", 200)).toBe(true);
    expect(isStale("stable", PAGE_STALE_DAYS_DEFAULT)).toBe(true);
  });

  test("returns true for draft past threshold", () => {
    expect(isStale("draft", 365)).toBe(true);
  });

  test("never reports verified or deprecated as stale", () => {
    expect(isStale("verified", 9999)).toBe(false);
    expect(isStale("deprecated", 9999)).toBe(false);
  });

  test("archived and disputed are not stale (they have their own meaning)", () => {
    expect(isStale("archived", 9999)).toBe(false);
    expect(isStale("disputed", 9999)).toBe(false);
  });

  test("honours an explicit threshold override", () => {
    expect(isStale("stable", 50, 30)).toBe(true);
    expect(isStale("stable", 50, 100)).toBe(false);
  });
});

describe("ageDaysFromIso", () => {
  test("computes days between an ISO timestamp and now", () => {
    const now = new Date("2026-05-25T00:00:00Z");
    expect(ageDaysFromIso("2026-05-20T00:00:00Z", now)).toBe(5);
    expect(ageDaysFromIso("2025-11-26T00:00:00Z", now)).toBeCloseTo(180, 0);
  });

  test("returns Infinity for missing or unparseable timestamps", () => {
    const now = new Date("2026-05-25T00:00:00Z");
    expect(ageDaysFromIso(undefined, now)).toBe(Infinity);
    expect(ageDaysFromIso(null, now)).toBe(Infinity);
    expect(ageDaysFromIso("", now)).toBe(Infinity);
    expect(ageDaysFromIso("not-a-date", now)).toBe(Infinity);
  });
});
