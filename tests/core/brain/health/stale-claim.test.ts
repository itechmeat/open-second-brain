/**
 * Stale-claim detector (F3).
 *
 * Flags confirmed preferences whose newest supporting evidence is older
 * than a configured age window. The clock is injected so the detector
 * stays deterministic; preferences with no evidence date are skipped
 * (their absence is reported by other lints).
 */

import { describe, expect, test } from "bun:test";

import { BRAIN_PREFERENCE_STATUS } from "../../../../src/core/brain/types.ts";
import {
  detectStaleClaims,
  type PreferenceForStaleClaim,
} from "../../../../src/core/brain/health/stale-claim.ts";

const NOW = new Date("2026-05-27T00:00:00Z");

function pref(
  over: Partial<PreferenceForStaleClaim> & Pick<PreferenceForStaleClaim, "id">,
): PreferenceForStaleClaim {
  return {
    status: BRAIN_PREFERENCE_STATUS.confirmed,
    last_evidence_at: null,
    ...over,
  };
}

describe("detectStaleClaims", () => {
  test("flags a confirmed preference older than the window", () => {
    const stale = detectStaleClaims(
      [pref({ id: "pref-old", last_evidence_at: "2026-01-01T00:00:00Z" })],
      { maxAgeDays: 90, now: NOW },
    );
    expect(stale).toEqual([
      { id: "pref-old", lastEvidenceAt: "2026-01-01T00:00:00Z", ageDays: 146 },
    ]);
  });

  test("does not flag a preference inside the window", () => {
    const stale = detectStaleClaims(
      [pref({ id: "pref-fresh", last_evidence_at: "2026-05-01T00:00:00Z" })],
      { maxAgeDays: 90, now: NOW },
    );
    expect(stale).toEqual([]);
  });

  test("skips preferences with no evidence date", () => {
    const stale = detectStaleClaims([pref({ id: "pref-none", last_evidence_at: null })], {
      maxAgeDays: 90,
      now: NOW,
    });
    expect(stale).toEqual([]);
  });

  test("skips unconfirmed preferences", () => {
    const stale = detectStaleClaims(
      [
        pref({
          id: "pref-unconf",
          status: BRAIN_PREFERENCE_STATUS.unconfirmed,
          last_evidence_at: "2026-01-01T00:00:00Z",
        }),
      ],
      { maxAgeDays: 90, now: NOW },
    );
    expect(stale).toEqual([]);
  });

  test("ignores a future evidence date (negative age)", () => {
    const stale = detectStaleClaims(
      [pref({ id: "pref-future", last_evidence_at: "2026-12-01T00:00:00Z" })],
      { maxAgeDays: 90, now: NOW },
    );
    expect(stale).toEqual([]);
  });

  test("parses a date-only evidence value deterministically as UTC midnight", () => {
    const stale = detectStaleClaims(
      [pref({ id: "pref-dateonly", last_evidence_at: "2026-01-01" })],
      { maxAgeDays: 90, now: NOW },
    );
    expect(stale).toEqual([{ id: "pref-dateonly", lastEvidenceAt: "2026-01-01", ageDays: 146 }]);
  });

  test("orders findings by age descending", () => {
    const stale = detectStaleClaims(
      [
        pref({ id: "pref-b", last_evidence_at: "2026-02-01T00:00:00Z" }),
        pref({ id: "pref-a", last_evidence_at: "2026-01-01T00:00:00Z" }),
      ],
      { maxAgeDays: 30, now: NOW },
    );
    expect(stale.map((s) => s.id)).toEqual(["pref-a", "pref-b"]);
  });
});
