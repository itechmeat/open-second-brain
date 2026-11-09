/**
 * Lane entries (design D14): the generic record of a Brain record lane,
 * folded by (lane, entry) by authority, then clock, with tombstones, in
 * any delivery order.
 */
import { describe, expect, test } from "bun:test";

import {
  foldLaneEntries,
  laneEntryKey,
  laneEntryRecord,
  laneEntryRemoveRecord,
  laneNameOf,
  LANE_ENTRY_KIND,
  LANE_ENTRY_REMOVE_KIND,
} from "../../../src/core/store/lane-records.ts";
import { authored, rec, seededRandom, shuffled } from "./fixtures/fold-records.ts";

const entry = (physical: number, authority: "human" | "agent" | "model", text: string) =>
  rec({
    physical,
    kind: LANE_ENTRY_KIND,
    body: authored(authority, { lane: "obligations", entry: "obl-a", fields: { s: 1 }, text }),
  });

describe("lane entries", () => {
  test("the builder writes the generic events record", () => {
    const record = laneEntryRecord({
      lane: "standing-rule",
      entry: "standing-rules",
      fields: { scope: "coding" },
      text: "Be kind.",
      authority: "human",
      private: false,
    });
    expect(record).toMatchObject({
      stream: "events",
      kind: LANE_ENTRY_KIND,
      scope: "coding",
      private: false,
      body: {
        authority: "human",
        lane: "standing-rule",
        entry: "standing-rules",
        text: "Be kind.",
      },
    });
    expect(() =>
      laneEntryRecord({
        lane: "Bad Lane",
        entry: "x",
        fields: {},
        text: "",
        authority: "agent",
        private: false,
      }),
    ).toThrow("invalid lane name");
  });

  test("a later agent edit wins over an earlier one, a human edit over a later agent edit", () => {
    const records = [
      entry(1, "agent", "one"),
      entry(2, "human", "two"),
      entry(3, "agent", "three"),
    ];
    for (const seed of [1, 2, 3]) {
      const fold = foldLaneEntries(shuffled(seededRandom(seed), [...records, records[0]!]));
      const state = fold.entries.get(laneEntryKey("obligations", "obl-a"))!;
      expect(state.value?.text).toBe("two");
      expect(state.history).toHaveLength(3);
    }
  });

  test("a tombstone removes the entry and keeps its history", () => {
    const remove = rec({
      physical: 4,
      kind: LANE_ENTRY_REMOVE_KIND,
      body: authored("agent", { lane: "obligations", entry: "obl-a" }),
    });
    const state = foldLaneEntries([entry(1, "agent", "one"), remove]).entries.get(
      "obligations/obl-a",
    )!;
    expect(state.removed).toBe(true);
    expect(state.value).toBeNull();
    expect(state.history).toHaveLength(2);
  });

  test("a record without authority or with a bad body is rejected", () => {
    const bad = rec({
      physical: 1,
      kind: LANE_ENTRY_KIND,
      body: { lane: "x", entry: "y", fields: {}, text: "" },
    });
    const fold = foldLaneEntries([bad]);
    expect(fold.entries.size).toBe(0);
    expect(fold.rejected[0]?.reason).toBe("missing or invalid authority");
  });

  test("a tombstone with a bad lane or entry is refused, as an entry is", () => {
    const base = { authority: "agent", private: false } as const;
    expect(() => laneEntryRemoveRecord({ ...base, lane: "Bad Lane", entry: "x" })).toThrow();
    expect(() => laneEntryRemoveRecord({ ...base, lane: "dead-ends", entry: "../x" })).toThrow();
    expect(laneEntryRemoveRecord({ ...base, lane: "dead-ends", entry: "x" }).kind).toBe(
      "lane-entry-remove",
    );
  });

  test("lane names come from folder names", () => {
    expect(laneNameOf("gap-tasks")).toBe("gap-tasks");
    expect(laneNameOf(".sessions")).toBe("sessions");
    expect(laneNameOf("Procedural Memory")).toBe("procedural-memory");
  });
});
