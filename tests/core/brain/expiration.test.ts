/**
 * C5 (t_a82b674e): caller-settable per-memory expiration date.
 *
 * The pure, LLM-free expiration model: validate a caller-supplied date on
 * write, decide whether a memory is past its expiration on read, and drop
 * expired memories from a list unless an opt-in `showExpired` flag is set.
 *
 * Date-granular semantics: a date-only `YYYY-MM-DD` value keeps the memory
 * live through the END of that UTC day (so "until 2026-07-15" stays live
 * all of the 15th and lapses on the 16th); a full ISO timestamp expires at
 * that exact instant.
 */

import { describe, expect, test } from "bun:test";

import {
  filterExpired,
  isExpired,
  normalizeExpirationDate,
} from "../../../src/core/brain/expiration.ts";

describe("normalizeExpirationDate", () => {
  test("accepts a date-only value and returns it trimmed", () => {
    expect(normalizeExpirationDate("  2026-07-15  ")).toBe("2026-07-15");
  });

  test("accepts a full ISO-8601 timestamp", () => {
    expect(normalizeExpirationDate("2026-07-15T09:30:00Z")).toBe("2026-07-15T09:30:00Z");
  });

  test("throws on an unparseable value", () => {
    expect(() => normalizeExpirationDate("not-a-date")).toThrow();
  });

  test("throws on an impossible calendar date", () => {
    expect(() => normalizeExpirationDate("2026-13-40")).toThrow();
  });
});

describe("isExpired — date-only granularity", () => {
  test("still live during the expiration day (UTC)", () => {
    expect(isExpired("2026-07-15", new Date("2026-07-15T23:00:00Z"))).toBe(false);
  });

  test("expired the following day", () => {
    expect(isExpired("2026-07-15", new Date("2026-07-16T00:00:01Z"))).toBe(true);
  });

  test("not expired well before the date", () => {
    expect(isExpired("2026-07-15", new Date("2026-01-01T00:00:00Z"))).toBe(false);
  });
});

describe("isExpired — full timestamp granularity", () => {
  test("live just before the instant", () => {
    expect(isExpired("2026-07-15T09:30:00Z", new Date("2026-07-15T09:29:59Z"))).toBe(false);
  });

  test("expired just after the instant", () => {
    expect(isExpired("2026-07-15T09:30:00Z", new Date("2026-07-15T09:30:01Z"))).toBe(true);
  });
});

describe("isExpired — malformed value fails open", () => {
  test("an unparseable stored date is treated as not-expired (never silently hides a memory)", () => {
    expect(isExpired("garbage", new Date("2999-01-01T00:00:00Z"))).toBe(false);
  });
});

describe("filterExpired", () => {
  const now = new Date("2026-08-01T00:00:00Z");
  const items = [
    { id: "a" }, // no expiration → always kept
    { id: "b", expiration_date: "2026-07-15" }, // expired before `now`
    { id: "c", expiration_date: "2026-12-31" }, // still live
  ];

  test("drops expired items by default", () => {
    const kept = filterExpired(items, { now }).map((i) => i.id);
    expect(kept).toEqual(["a", "c"]);
  });

  test("keeps expired items when showExpired is set", () => {
    const kept = filterExpired(items, { now, showExpired: true }).map((i) => i.id);
    expect(kept).toEqual(["a", "b", "c"]);
  });

  test("items without an expiration_date are always kept", () => {
    const noExpiry: { id: string; expiration_date?: string }[] = [{ id: "a" }];
    const kept = filterExpired(noExpiry, { now }).map((i) => i.id);
    expect(kept).toEqual(["a"]);
  });
});
