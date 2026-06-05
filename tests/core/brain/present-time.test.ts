/**
 * Timezone presentation helper (t_2ccadc6a): storage stays canonical
 * UTC; `formatLocalTimestamp` converts one ISO-8601 UTC instant to
 * the operator's IANA zone for display, rendering the full offset
 * form `YYYY-MM-DDTHH:MM:SS+HH:MM`. Pure, deterministic for fixed
 * inputs, fail-soft to the UTC `Z` form on a missing or invalid zone.
 */

import { describe, expect, test } from "bun:test";

import { formatLocalTimestamp } from "../../../src/core/brain/present-time.ts";

describe("formatLocalTimestamp", () => {
  test("UTC zone renders the explicit +00:00 offset form", () => {
    expect(formatLocalTimestamp("2026-06-05T12:00:00Z", "UTC")).toBe("2026-06-05T12:00:00+00:00");
  });

  test("Europe/Berlin summer time renders +02:00", () => {
    expect(formatLocalTimestamp("2026-06-05T12:00:00Z", "Europe/Berlin")).toBe(
      "2026-06-05T14:00:00+02:00",
    );
  });

  test("Europe/Berlin winter time renders +01:00 (DST boundary honored)", () => {
    expect(formatLocalTimestamp("2026-01-15T12:00:00Z", "Europe/Berlin")).toBe(
      "2026-01-15T13:00:00+01:00",
    );
  });

  test("America/New_York renders a negative offset", () => {
    expect(formatLocalTimestamp("2026-06-05T12:00:00Z", "America/New_York")).toBe(
      "2026-06-05T08:00:00-04:00",
    );
  });

  test("a date-line crossing changes the calendar day", () => {
    expect(formatLocalTimestamp("2026-06-05T23:30:00Z", "Asia/Tokyo")).toBe(
      "2026-06-06T08:30:00+09:00",
    );
  });

  test("null zone falls back to the canonical UTC Z form", () => {
    expect(formatLocalTimestamp("2026-06-05T12:00:00Z", null)).toBe("2026-06-05T12:00:00Z");
  });

  test("an invalid zone fails soft to the UTC Z form", () => {
    expect(formatLocalTimestamp("2026-06-05T12:00:00Z", "Mars/Olympus_Mons")).toBe(
      "2026-06-05T12:00:00Z",
    );
  });

  test("an unparseable instant is returned verbatim", () => {
    expect(formatLocalTimestamp("not-a-date", "UTC")).toBe("not-a-date");
  });
});
