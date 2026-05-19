import { describe, expect, test } from "bun:test";
import { yesterdayWindow } from "../../src/core/discipline/window.ts";

describe("yesterdayWindow", () => {
  test("Europe/Belgrade at 06:00 local → window covers prior local day", () => {
    // 2026-05-18T06:00:00 in Belgrade = 2026-05-18T04:00:00Z (CEST UTC+2).
    const now = new Date("2026-05-18T04:00:00Z");
    const w = yesterdayWindow(now, "Europe/Belgrade");
    expect(w.localDate).toBe("2026-05-17");
    // Window starts at 2026-05-17T00:00:00 local = 2026-05-16T22:00:00Z.
    expect(w.startUtc.toISOString()).toBe("2026-05-16T22:00:00.000Z");
    expect(w.endUtc.toISOString()).toBe("2026-05-17T22:00:00.000Z");
  });

  test("UTC timezone → naive 24h window", () => {
    const now = new Date("2026-05-18T03:00:00Z");
    const w = yesterdayWindow(now, "UTC");
    expect(w.localDate).toBe("2026-05-17");
    expect(w.startUtc.toISOString()).toBe("2026-05-17T00:00:00.000Z");
    expect(w.endUtc.toISOString()).toBe("2026-05-18T00:00:00.000Z");
  });

  // Regression for the CodeRabbit-flagged west-of-UTC bug: without the
  // day-delta correction in localMidnightUtc, this case settled on a
  // 24h-early instant ("2026-05-15T07:00:00Z" instead of
  // "2026-05-16T07:00:00Z"). Verifies the loop now adjusts for whole-day
  // drift as well as time-of-day drift.
  test("America/Los_Angeles (west-of-UTC) at 10:00 local → prior local day", () => {
    // 2026-05-18T10:00:00 PDT (UTC-7) = 2026-05-18T17:00:00Z.
    const now = new Date("2026-05-18T17:00:00Z");
    const w = yesterdayWindow(now, "America/Los_Angeles");
    expect(w.localDate).toBe("2026-05-17");
    // Yesterday-local midnight in LA = 2026-05-17T07:00:00Z.
    // Today-local midnight in LA    = 2026-05-18T07:00:00Z.
    expect(w.startUtc.toISOString()).toBe("2026-05-17T07:00:00.000Z");
    expect(w.endUtc.toISOString()).toBe("2026-05-18T07:00:00.000Z");
  });
});
