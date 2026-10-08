/**
 * Ledger validity windows (truth-correctable-time-aware, contract item 1):
 * window parsing reuses the `src/core/search/validity.ts` discipline
 * (bare dates day-snapped, datetimes, relative phrases rejected),
 * `claimWindow` is null exactly for windowless events, and
 * `windowsIntersect` is the half-open rule with null as plus/minus
 * infinity. Pure functions only - no I/O, no clock.
 */

import { describe, expect, test } from "bun:test";

import {
  claimWindow,
  isValidityPoint,
  windowsIntersect,
} from "../../../../src/core/brain/truth/validity.ts";
import type { ClaimEvent } from "../../../../src/core/brain/truth/types.ts";

function claim(over: Partial<ClaimEvent> = {}): ClaimEvent {
  return {
    v: 1,
    ts: "2026-06-01T10:00:00Z",
    agent: "claude-dev-agent",
    entity: "alice mason",
    aspect: "employer",
    value: "Google",
    valueKind: "text",
    source: "[[Brain/notes/standup.md]]",
    ...over,
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

describe("claimWindow", () => {
  test("a windowless event has no window", () => {
    expect(claimWindow(claim())).toBeNull();
  });

  test("a bare-date from day-snaps to the day start", () => {
    const window = claimWindow(claim({ validFrom: "2026-01-01" }));
    expect(window).not.toBeNull();
    expect(window!.fromMs).toBe(Date.UTC(2026, 0, 1));
    expect(window!.untilMs).toBeNull();
  });

  test("a bare-date until day-snaps to cover its whole day", () => {
    const window = claimWindow(claim({ validUntil: "2026-01-01" }));
    expect(window).not.toBeNull();
    expect(window!.fromMs).toBeNull();
    expect(window!.untilMs).toBe(Date.UTC(2026, 0, 1) + DAY_MS - 1);
  });

  test("canonical UTC datetimes parse exactly", () => {
    const window = claimWindow(
      claim({ validFrom: "2026-01-01T00:00:00Z", validUntil: "2026-06-30T12:00:00Z" }),
    );
    expect(window!.fromMs).toBe(Date.parse("2026-01-01T00:00:00Z"));
    expect(window!.untilMs).toBe(Date.parse("2026-06-30T12:00:00Z"));
  });

  test("a datetime without an offset reads as UTC", () => {
    const window = claimWindow(claim({ validFrom: "2026-01-01T10:30:00" }));
    expect(window!.fromMs).toBe(Date.parse("2026-01-01T10:30:00Z"));
  });

  test("relative phrases never parse", () => {
    expect(claimWindow(claim({ validFrom: "yesterday" }))!.fromMs).toBeNull();
    expect(claimWindow(claim({ validUntil: "last week" }))!.untilMs).toBeNull();
    expect(claimWindow(claim({ validFrom: "3 days ago" }))!.fromMs).toBeNull();
  });

  test("an impossible calendar date never parses", () => {
    expect(claimWindow(claim({ validFrom: "2026-02-30" }))!.fromMs).toBeNull();
  });

  test("an unparseable present bound reads as unbounded on that side", () => {
    // The write boundary (appendClaimEvent / coerceClaim) rejects these
    // with a named error, so this branch is defensive tolerance for
    // hand-built events only.
    const window = claimWindow(claim({ validFrom: "not a date", validUntil: "2026-01-01" }));
    expect(window).not.toBeNull();
    expect(window!.fromMs).toBeNull();
  });
});

describe("windowsIntersect", () => {
  test("overlapping half-open windows intersect", () => {
    expect(windowsIntersect({ fromMs: 10, untilMs: 20 }, { fromMs: 15, untilMs: 25 })).toBe(true);
  });

  test("touching half-open windows do not intersect", () => {
    expect(windowsIntersect({ fromMs: 10, untilMs: 20 }, { fromMs: 20, untilMs: 30 })).toBe(false);
    expect(windowsIntersect({ fromMs: 20, untilMs: 30 }, { fromMs: 10, untilMs: 20 })).toBe(false);
  });

  test("disjoint windows do not intersect", () => {
    expect(windowsIntersect({ fromMs: 10, untilMs: 20 }, { fromMs: 40, untilMs: 50 })).toBe(false);
  });

  test("a missing bound is minus infinity on the from side", () => {
    expect(windowsIntersect({ fromMs: null, untilMs: 20 }, { fromMs: 10, untilMs: 30 })).toBe(true);
    expect(windowsIntersect({ fromMs: null, untilMs: 5 }, { fromMs: 10, untilMs: 30 })).toBe(false);
  });

  test("a missing bound is plus infinity on the until side", () => {
    expect(windowsIntersect({ fromMs: 10, untilMs: null }, { fromMs: 20, untilMs: 30 })).toBe(true);
    // [40, 50) starts after [10, infinity) begins and ends never, so the
    // non-intersecting counterpart must end before the from side opens.
    expect(windowsIntersect({ fromMs: 10, untilMs: null }, { fromMs: 40, untilMs: 50 })).toBe(true);
    expect(windowsIntersect({ fromMs: 10, untilMs: null }, { fromMs: null, untilMs: 5 })).toBe(
      false,
    );
  });

  test("two fully open windows intersect", () => {
    expect(windowsIntersect({ fromMs: null, untilMs: null }, { fromMs: 0, untilMs: 1 })).toBe(true);
    expect(windowsIntersect({ fromMs: null, untilMs: null }, { fromMs: null, untilMs: null })).toBe(
      true,
    );
  });

  test("a later-opening unbounded window still intersects an earlier unbounded one", () => {
    expect(windowsIntersect({ fromMs: 10, untilMs: null }, { fromMs: 20, untilMs: null })).toBe(
      true,
    );
  });
});

describe("isValidityPoint", () => {
  test("accepts bare ISO dates and canonical UTC timestamps", () => {
    expect(isValidityPoint("2026-01-01")).toBe(true);
    expect(isValidityPoint("2026-01-01T10:00:00Z")).toBe(true);
    expect(isValidityPoint("2026-01-01T10:00:00.500Z")).toBe(true);
  });

  test("rejects relative phrases, offsets, and garbage", () => {
    expect(isValidityPoint("yesterday")).toBe(false);
    expect(isValidityPoint("last week")).toBe(false);
    expect(isValidityPoint("2026-01-01T10:00:00+02:00")).toBe(false);
    expect(isValidityPoint("")).toBe(false);
    expect(isValidityPoint("  ")).toBe(false);
    expect(isValidityPoint("not a date")).toBe(false);
    expect(isValidityPoint("2026-02-30")).toBe(false);
  });
});
