/** What the tombstones voided and the shards still hold (FORMAT.md, "Removal"). */
import { expect, test } from "bun:test";

import { removalBacklog } from "../../../src/core/store/removal-backlog.ts";
import { authored, rec } from "./fixtures/fold-records.ts";

const T = Date.UTC(2026, 10, 7, 12, 0, 0);

test("counts forgotten signals, removed preferences and removed lane entries, not lane moves", () => {
  const records = [
    rec({
      physical: T,
      kind: "signal",
      body: { id: "s1", path: "Brain/inbox/s1.md", staged: false, frontmatter: {}, raw: "x" },
    }),
    rec({ physical: T + 1, kind: "signal-removed", body: authored("human", { signal: "s1" }) }),
    rec({
      physical: T,
      kind: "preference-set",
      body: authored("agent", { preference: "pref-a", fields: { principle: "p" } }),
    }),
    rec({
      physical: T + 1,
      kind: "preference-remove",
      body: authored("human", { preference: "pref-a" }),
    }),
    // A removed lane entry.
    rec({
      physical: T,
      kind: "lane-entry",
      body: authored("agent", { lane: "sources", entry: "src-a", fields: { k: 1 }, text: "gone" }),
    }),
    rec({
      physical: T + 1,
      kind: "lane-entry-remove",
      body: authored("agent", { lane: "sources", entry: "src-a" }),
    }),
    // A moved lane entry: its content lives on under the new entry.
    rec({
      physical: T,
      kind: "lane-entry",
      body: authored("agent", {
        lane: "obligations",
        entry: "o1",
        fields: { k: 2 },
        text: "moved",
      }),
    }),
    rec({
      physical: T + 1,
      kind: "lane-entry-remove",
      body: authored("agent", { lane: "obligations", entry: "o1" }),
    }),
    rec({
      physical: T + 1,
      kind: "lane-entry",
      body: authored("agent", {
        lane: "obligations",
        entry: "archive/o1",
        fields: { k: 2 },
        text: "moved",
      }),
    }),
  ];
  expect(removalBacklog(records)).toEqual({ signals: 1, preferences: 1, laneEntries: 1, total: 3 });
  expect(removalBacklog([])).toEqual({ signals: 0, preferences: 0, laneEntries: 0, total: 0 });
});

test("a removed entry whose content another lane holds is still a removal; a reordered move is a move", () => {
  const entry = (physical: number, lane: string, id: string, fields: Record<string, unknown>) =>
    rec({
      physical,
      kind: "lane-entry",
      body: authored("agent", { lane, entry: id, fields, text: "t" }),
    });
  const remove = (physical: number, lane: string, id: string) =>
    rec({ physical, kind: "lane-entry-remove", body: authored("agent", { lane, entry: id }) });
  // Removed from `sources`; identical content lives in `obligations`.
  const removed = [
    entry(T, "sources", "a", { k: 1 }),
    remove(T + 1, "sources", "a"),
    entry(T, "obligations", "b", { k: 1 }),
  ];
  expect(removalBacklog(removed).laneEntries).toBe(1);
  // Moved within `pledges`, its fields written back in another order.
  const moved = [
    entry(T, "pledges", "p", { x: 1, y: 2 }),
    remove(T + 1, "pledges", "p"),
    entry(T + 1, "pledges", "archive/p", { y: 2, x: 1 }),
  ];
  expect(removalBacklog(moved).laneEntries).toBe(0);
});
