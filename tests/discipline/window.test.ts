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
});
