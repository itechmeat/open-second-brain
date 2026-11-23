/**
 * Named equivalence scenarios of the dream replay (task 1.2): records that
 * reach the machine after their day was covered.
 */
import { describe, expect, test } from "bun:test";

import { compareReplay, firstDreamHistoryDifference } from "../../../helpers/dream-history.ts";
import { preferenceIds, signal, signalStates } from "../../../helpers/dream-replay-scenarios.ts";

describe("dream replay: late records", () => {
  test("a late third signal is considered alone and the two archived stay so", () => {
    const events = [
      signal({ slug: "a1", topic: "quotes", day: 0 }),
      signal({ slug: "a2", topic: "quotes", day: 0, agent: "codex", hour: 10 }),
      // Dated on a covered day, it reaches the machine after day 16.
      signal({ slug: "a3", topic: "quotes", day: 1, agent: "hermes", admitOn: 17 }),
    ];
    const { daily, replay } = compareReplay({ seed: 201, events, coveredDay: 16, replayDay: 20 });
    expect(signalStates(daily.dump, "a1")).toEqual(["archived"]);
    expect(signalStates(daily.dump, "a2")).toEqual(["archived"]);
    expect(signalStates(daily.dump, "a3")).toEqual([]);
    expect(preferenceIds(daily.dump).filter((id) => id.includes("quotes"))).toEqual([]);
    expect(firstDreamHistoryDifference(daily.dump, replay.dump)).toBeNull();
  }, 60_000);

  test("a signal first seen older than the window is counted, not archived", () => {
    const events = [
      signal({ slug: "anchor", topic: "anchor-topic", day: 0 }),
      signal({ slug: "old", topic: "imports", day: 0, admitOn: 21 }),
    ];
    const { daily, replay } = compareReplay({ seed: 202, events, coveredDay: 20, replayDay: 23 });
    expect(signalStates(daily.dump, "old")).toEqual([]);
    expect(firstDreamHistoryDifference(daily.dump, replay.dump)).toBeNull();
  }, 60_000);
});
