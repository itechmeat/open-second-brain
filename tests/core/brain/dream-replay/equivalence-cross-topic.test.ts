/**
 * Named equivalence scenario of the dream replay (task 1.2): one
 * cross-topic promotion per owner per day, judged against each window's day.
 */
import { describe, expect, test } from "bun:test";

import { compareReplay, firstDreamHistoryDifference } from "../../../helpers/dream-history.ts";
import {
  dateOf,
  preference,
  preferenceFields,
  preferenceIds,
  signal,
} from "../../../helpers/dream-replay-scenarios.ts";

describe("dream replay: a per-day allowance", () => {
  test("two clusters and one daily slot promote on two days", () => {
    const alpha = "Always pin exact dependency versions in every manifest file.";
    const beta = "Never commit generated build output into the source tree.";
    const events = [
      signal({ slug: "anchor", topic: "anchor-topic", day: 0 }),
      preference({ slug: "alpha-one", topic: "deps", day: 1, principle: alpha }),
      preference({ slug: "alpha-two", topic: "packaging", day: 1, principle: alpha }),
      preference({ slug: "beta-one", topic: "build", day: 1, principle: beta }),
      preference({ slug: "beta-two", topic: "repo", day: 1, principle: beta }),
    ];
    const { daily, replay } = compareReplay({ seed: 401, events, coveredDay: 0, replayDay: 10 });
    const rules = preferenceIds(daily.dump).filter((id) => id.startsWith("pref-cross-"));
    expect(rules).toHaveLength(2);
    const days = rules
      .map((id) => String(preferenceFields(daily.dump, id)?.["created_at"]).slice(0, 10))
      .toSorted();
    expect(days).toEqual([dateOf(1), dateOf(2)]);
    expect(firstDreamHistoryDifference(daily.dump, replay.dump)).toBeNull();
  }, 60_000);
});
