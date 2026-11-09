/**
 * Log readers outside the log package read the store's log events once
 * switched (task 2.10 WP7): the OKF log export, the device-aware day
 * reader behind the note-write views, and the per-day readers.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { appendLogEvent } from "../../../src/core/brain/log.ts";
import { logDayReader, logDaysWithDevices } from "../../../src/core/brain/log-days.ts";
import { buildLog } from "../../../src/core/brain/portability/okf.ts";
import { LANE_MODES, makeLaneEnv, type LaneEnv } from "./fixtures/lane-env.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

describe.each(LANE_MODES.filter((m) => m !== "no-vault"))("log readers (%s)", (mode) => {
  test("a note event is read by the day reader, the device-aware reader and the OKF export", () => {
    lane = makeLaneEnv(mode);
    const { vault } = lane;
    appendLogEvent(vault, {
      timestamp: "2026-11-06T10:00:00Z",
      eventType: "note",
      agent: "@t",
      body: { text: "Capybara milestone" },
    });
    const reader = logDayReader(vault);
    expect(reader.stored).toBe(mode !== "legacy");
    expect(reader.dates).toContain("2026-11-06");
    expect(JSON.stringify(reader.day("2026-11-06").entries)).toContain("Capybara milestone");
    const days = logDaysWithDevices(vault, "2026-11-06", "2026-11-06");
    expect(days.map((d) => d.date)).toEqual(["2026-11-06"]);
    expect(days[0]!.entryShardIds).toHaveLength(days[0]!.entries.length);
    if (mode !== "legacy") expect(days[0]!.entryShardIds).toEqual(["dev-a"]);
    expect(buildLog(vault).contents).toContain("Capybara milestone");
  });
});
