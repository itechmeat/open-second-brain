/**
 * Dead-ends as a record lane (task 2.10 WP6), in every mode: an
 * unswitched machine writes the pages, a store-only machine and a machine
 * with no vault write lane-entry records and change nothing in the vault,
 * and all three read back the same entries, collision suffix and overflow
 * archive included.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { existsSync } from "node:fs";

import { listDeadEnds, recordDeadEnd } from "../../../src/core/brain/dead-ends.ts";
import { renderLessonsForReader } from "../../../src/core/brain/lessons.ts";
import { laneVaultRoot } from "../../../src/core/store/lane-pages.ts";
import { LANE_MODES, makeLaneEnv, type LaneEnv } from "./fixtures/lane-env.ts";

let lane: LaneEnv | null = null;
afterEach(() => {
  lane?.cleanup();
  lane = null;
});

const NOW = new Date("2026-11-07T12:00:00Z");

describe.each(LANE_MODES)("dead-ends (%s)", (mode) => {
  test("record, collide, list and archive the overflow", () => {
    lane = makeLaneEnv(mode);
    const before = lane.vaultHash();
    const record = (approach: string, maxActive?: number) =>
      recordDeadEnd(lane!.vault, {
        approach,
        reason: "It failed",
        agent: "@t",
        now: NOW,
        ...(maxActive !== undefined ? { maxActive } : {}),
      });
    const first = record("Global cache");
    const second = record("Global cache");
    expect(first.entry.id).toBe("de-2026-11-07-global-cache");
    expect(second.entry.id).toBe("de-2026-11-07-global-cache-2");
    expect(
      listDeadEnds(lane.vault)
        .entries.map((e) => e.id)
        .toSorted(),
    ).toEqual(["de-2026-11-07-global-cache", "de-2026-11-07-global-cache-2"]);
    expect(listDeadEnds(lane.vault).entries[0]?.reason).toBe("It failed");
    const third = record("Another way", 2);
    expect(third.archived).toHaveLength(1);
    expect(listDeadEnds(lane.vault).entries).toHaveLength(2);
    if (mode !== "legacy") {
      expect(lane.vaultHash()).toBe(before);
      expect(existsSync(laneVaultRoot(null))).toBe(false);
      // Three creates, then the overflow move: the oldest entry's tombstone
      // and its archive entry. `every` alone would pass on no records at all.
      const records = lane.laneRecords();
      expect(records).toHaveLength(5);
      expect(records.every((r) => r.body["lane"] === "dead-ends")).toBe(true);
      const archivedEntry = `archive/${third.archived[0]}`;
      expect(records.map((r) => r.body["entry"])).toContain(archivedEntry);
    }
  });
});

describe("dead-ends reach the lessons digest", () => {
  test("with no vault a recorded dead end is scored like on a vault", () => {
    lane = makeLaneEnv("no-vault");
    recordDeadEnd(lane.vault, {
      approach: "Global cache",
      reason: "It failed",
      agent: "@t",
      now: NOW,
    });
    const rendered = renderLessonsForReader(null, {});
    expect(rendered.body).toContain("Global cache");
  });
});
