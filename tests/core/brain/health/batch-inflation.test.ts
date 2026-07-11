/**
 * Batch-inflation detector.
 *
 * Distinct axis from `duplicate-preferences` (near-identical principle
 * text): this flags a *burst* of individually-distinct preferences all
 * confirmed within a short window, regardless of similarity.
 */

import { describe, expect, test } from "bun:test";

import { detectBatchInflation } from "../../../../src/core/brain/health/batch-inflation.ts";
import { BRAIN_PREFERENCE_STATUS, type BrainPreferenceStatus } from "../../../../src/core/brain/types.ts";

function pref(
  id: string,
  confirmedAt: string | null,
  topic = "t",
  status: BrainPreferenceStatus = BRAIN_PREFERENCE_STATUS.confirmed,
) {
  return { id, status, confirmed_at: confirmedAt, topic };
}

describe("detectBatchInflation", () => {
  test("a burst at or above minBurstSize within the window is flagged", () => {
    const findings = detectBatchInflation(
      [
        pref("pref-a", "2026-05-01T00:00:00Z"),
        pref("pref-b", "2026-05-01T01:00:00Z"),
        pref("pref-c", "2026-05-01T02:00:00Z"),
      ],
      { windowHours: 24, minBurstSize: 3 },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ids).toEqual(["pref-a", "pref-b", "pref-c"]);
    expect(findings[0]!.count).toBe(3);
  });

  test("below minBurstSize is not flagged", () => {
    const findings = detectBatchInflation(
      [pref("pref-a", "2026-05-01T00:00:00Z"), pref("pref-b", "2026-05-01T01:00:00Z")],
      { windowHours: 24, minBurstSize: 3 },
    );
    expect(findings).toEqual([]);
  });

  test("preferences outside the window do not merge into one burst", () => {
    const findings = detectBatchInflation(
      [
        pref("pref-a", "2026-05-01T00:00:00Z"),
        pref("pref-b", "2026-05-01T01:00:00Z"),
        // 3 days later - outside a 24h window from pref-a.
        pref("pref-c", "2026-05-04T00:00:00Z"),
      ],
      { windowHours: 24, minBurstSize: 3 },
    );
    expect(findings).toEqual([]);
  });

  test("two separate bursts are reported non-overlapping", () => {
    const findings = detectBatchInflation(
      [
        pref("pref-a", "2026-05-01T00:00:00Z"),
        pref("pref-b", "2026-05-01T01:00:00Z"),
        pref("pref-c", "2026-05-01T02:00:00Z"),
        // second burst, well outside the first window
        pref("pref-d", "2026-05-10T00:00:00Z"),
        pref("pref-e", "2026-05-10T01:00:00Z"),
        pref("pref-f", "2026-05-10T02:00:00Z"),
      ],
      { windowHours: 24, minBurstSize: 3 },
    );
    expect(findings).toHaveLength(2);
    expect(findings[0]!.ids).toEqual(["pref-a", "pref-b", "pref-c"]);
    expect(findings[1]!.ids).toEqual(["pref-d", "pref-e", "pref-f"]);
  });

  test("unconfirmed preferences are excluded", () => {
    const findings = detectBatchInflation(
      [
        pref("pref-a", "2026-05-01T00:00:00Z"),
        pref("pref-b", "2026-05-01T01:00:00Z"),
        pref("pref-c", null, "t", BRAIN_PREFERENCE_STATUS.unconfirmed),
      ],
      { windowHours: 24, minBurstSize: 3 },
    );
    expect(findings).toEqual([]);
  });

  test("preferences with a null confirmed_at are excluded", () => {
    const findings = detectBatchInflation(
      [pref("pref-a", "2026-05-01T00:00:00Z"), pref("pref-b", null)],
      { windowHours: 24, minBurstSize: 1 },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.ids).toEqual(["pref-a"]);
  });

  test("default options: 24h window, burst size 5", () => {
    const findings = detectBatchInflation(
      Array.from({ length: 5 }, (_, i) => pref(`pref-${i}`, `2026-05-01T0${i}:00:00Z`)),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.count).toBe(5);
  });

  test("topics are deduped and sorted", () => {
    const findings = detectBatchInflation(
      [
        pref("pref-a", "2026-05-01T00:00:00Z", "zeta"),
        pref("pref-b", "2026-05-01T01:00:00Z", "alpha"),
        pref("pref-c", "2026-05-01T02:00:00Z", "alpha"),
      ],
      { windowHours: 24, minBurstSize: 3 },
    );
    expect(findings[0]!.topics).toEqual(["alpha", "zeta"]);
  });
});
