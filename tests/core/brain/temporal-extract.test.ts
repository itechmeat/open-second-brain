/**
 * Temporal extraction from signal text (Brain lifecycle suite,
 * Feature 5). A pure, language-agnostic parser that recognises formal
 * ISO-8601 tokens only - dates, intervals, and durations - and maps
 * them onto the bi-temporal `valid_from` / `valid_until` shape. Text
 * carrying no ISO token (including localized month/day names in any
 * language) yields `{}`.
 */

import { describe, expect, test } from "bun:test";

import { extractTemporalConstraints } from "../../../src/core/brain/temporal-extract.ts";

const now = new Date("2026-05-29T12:00:00Z");

describe("extractTemporalConstraints", () => {
  test("returns {} for text with no ISO token", () => {
    expect(extractTemporalConstraints("just a plain note", { now })).toEqual({});
  });

  test("ignores localized month names (language-agnostic)", () => {
    // Russian, Spanish, Chinese month/day phrases - no ISO token.
    expect(extractTemporalConstraints("каждый понедельник в мае", { now })).toEqual({});
    expect(extractTemporalConstraints("revisar el 5 de mayo", { now })).toEqual({});
    expect(extractTemporalConstraints("五月每周一复习", { now })).toEqual({});
  });

  test("maps an ISO interval A/B to valid_from + valid_until", () => {
    const out = extractTemporalConstraints("active 2026-06-01/2026-06-30 only", { now });
    expect(out.valid_from).toBe("2026-06-01T00:00:00Z");
    expect(out.valid_until).toBe("2026-06-30T00:00:00Z");
  });

  test("maps an ISO-8601 day duration relative to now", () => {
    const out = extractTemporalConstraints("keep this for P7D then drop", { now });
    expect(out.valid_from).toBe("2026-05-29T12:00:00Z");
    expect(out.valid_until).toBe("2026-06-05T12:00:00Z");
  });

  test("maps a week duration", () => {
    const out = extractTemporalConstraints("valid P2W", { now });
    expect(out.valid_until).toBe("2026-06-12T12:00:00Z");
  });

  test("maps a month duration via calendar arithmetic", () => {
    const out = extractTemporalConstraints("expires in P1M", { now });
    expect(out.valid_until).toBe("2026-06-29T12:00:00Z");
  });

  test("maps a year duration", () => {
    const out = extractTemporalConstraints("renew P1Y", { now });
    expect(out.valid_until).toBe("2027-05-29T12:00:00Z");
  });

  test("anchors a duration to a co-occurring explicit start date", () => {
    const out = extractTemporalConstraints("from 2026-06-01 for P1Y", { now });
    expect(out.valid_from).toBe("2026-06-01T00:00:00Z");
    expect(out.valid_until).toBe("2027-06-01T00:00:00Z");
  });

  test("treats a lone ISO date as valid_from", () => {
    const out = extractTemporalConstraints("starting 2026-07-01", { now });
    expect(out.valid_from).toBe("2026-07-01T00:00:00Z");
    expect(out.valid_until).toBeUndefined();
  });

  test("prefers the interval form over a lone date when both could match", () => {
    const out = extractTemporalConstraints("window 2026-06-01/2026-06-30", { now });
    expect(out.valid_from).toBe("2026-06-01T00:00:00Z");
    expect(out.valid_until).toBe("2026-06-30T00:00:00Z");
  });

  test("is deterministic on the injected clock and never throws", () => {
    const a = extractTemporalConstraints("P30D", { now });
    const b = extractTemporalConstraints("P30D", { now });
    expect(a).toEqual(b);
    expect(() => extractTemporalConstraints("PXYZ garbage", { now })).not.toThrow();
    expect(extractTemporalConstraints("PXYZ garbage", { now })).toEqual({});
  });
});
