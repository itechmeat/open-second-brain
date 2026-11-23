import { describe, expect, test } from "bun:test";

import {
  compareSeedReplay,
  DREAM_HISTORY_SEEDS,
  dreamAdmissionDay,
  firstDreamHistoryDifference,
} from "../../../helpers/dream-history.ts";

describe("dream replay equivalence over generated seeds", () => {
  test("admission is the event day unless the day was covered when the record arrived", () => {
    expect(dreamAdmissionDay(0, 0, false)).toBe(0);
    expect(dreamAdmissionDay(0, 0, true)).toBe(1);
    expect(dreamAdmissionDay(3, 0, true)).toBe(3);
  });

  for (const seed of DREAM_HISTORY_SEEDS) {
    test(`seed ${seed}: one replay ends where daily passes end`, () => {
      const { daily, replay } = compareSeedReplay(seed);
      expect(firstDreamHistoryDifference(daily.dump, replay.dump)).toBeNull();
    }, 30_000);
  }
});
