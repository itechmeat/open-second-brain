/**
 * Brain time helpers.
 */

import { describe, expect, test } from "bun:test";

import { relativeAge } from "../../src/core/brain/time.ts";

const now = new Date("2026-05-29T12:00:00Z");

describe("relativeAge", () => {
  test("formats recent gaps with compact labels", () => {
    expect(relativeAge("2026-05-29T11:59:30Z", now)).toBe("just now");
    expect(relativeAge("2026-05-29T11:57:00Z", now)).toBe("3m ago");
    expect(relativeAge("2026-05-29T09:00:00Z", now)).toBe("3h ago");
    expect(relativeAge("2026-05-24T12:00:00Z", now)).toBe("5d ago");
    expect(relativeAge("2026-05-08T12:00:00Z", now)).toBe("3w ago");
    expect(relativeAge("2026-02-28T12:00:00Z", now)).toBe("3mo ago");
  });

  test("does not report 0 years before the first full year", () => {
    expect(relativeAge("2025-06-03T12:00:00Z", now)).toBe("12mo ago");
    expect(relativeAge("2025-05-29T12:00:00Z", now)).toBe("1y ago");
  });

  test("omits invalid timestamps and clamps future timestamps", () => {
    expect(relativeAge("not-a-date", now)).toBe("");
    expect(relativeAge("2026-05-29T12:01:00Z", now)).toBe("just now");
  });
});
