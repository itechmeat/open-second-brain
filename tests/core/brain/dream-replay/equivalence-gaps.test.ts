import { describe, expect, test } from "bun:test";

import {
  compareReplay,
  firstDreamHistoryDifference,
  generatedDreamHistory,
} from "../../../helpers/dream-history.ts";

function gap(replayDay: number) {
  return compareReplay({ seed: 1, events: generatedDreamHistory(1), coveredDay: 2, replayDay });
}

describe("dream replay over gaps of zero, one and thirty days", () => {
  test("a zero-day gap adds no pass", () => {
    const { daily, replay } = gap(2);
    expect(firstDreamHistoryDifference(daily.dump, replay.dump)).toBeNull();
  }, 30_000);

  test("a one-day gap is one ordinary pass", () => {
    const { daily, replay } = gap(3);
    expect(firstDreamHistoryDifference(daily.dump, replay.dump)).toBeNull();
  }, 30_000);

  test("a thirty-day gap ends where thirty daily passes end", () => {
    const { daily, replay } = gap(32);
    expect(firstDreamHistoryDifference(daily.dump, replay.dump)).toBeNull();
  }, 60_000);
});
