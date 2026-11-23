/**
 * Named equivalence scenarios of the dream replay (task 1.2): promotions
 * that depend on the day they are judged on.
 */
import { describe, expect, test } from "bun:test";

import { compareReplay, firstDreamHistoryDifference } from "../../../helpers/dream-history.ts";
import {
  dateOf,
  preferenceFields,
  preferenceIds,
  signal,
  signalStates,
} from "../../../helpers/dream-replay-scenarios.ts";

const anchor = signal({ slug: "anchor", topic: "anchor-topic", day: 0 });

describe("dream replay: promotions judged on their own day", () => {
  test("evidence that one scan would archive is promoted in its window", () => {
    // Three matching signals in the first days of a three-week silence.
    const events = [
      anchor,
      signal({ slug: "s1", topic: "tabs", day: 1, agent: "claude" }),
      signal({ slug: "s2", topic: "tabs", day: 2, agent: "codex" }),
      signal({ slug: "s3", topic: "tabs", day: 3, agent: "hermes" }),
    ];
    const { daily, replay } = compareReplay({ seed: 101, events, coveredDay: 0, replayDay: 24 });
    const promoted = preferenceIds(daily.dump).filter((id) => id.includes("tabs"));
    expect(promoted).toHaveLength(1);
    expect(String(preferenceFields(daily.dump, promoted[0]!)?.["created_at"])).toStartWith(
      dateOf(3),
    );
    expect(signalStates(daily.dump, "s1")).toEqual(["consumed"]);
    expect(firstDreamHistoryDifference(daily.dump, replay.dump)).toBeNull();
  }, 60_000);

  test("a signal expiring in the gap still counts on the days before it expires", () => {
    const events = [
      anchor,
      signal({ slug: "e1", topic: "lint", day: 1, expires: dateOf(5) }),
      signal({ slug: "e2", topic: "lint", day: 1, agent: "codex" }),
      signal({ slug: "e3", topic: "lint", day: 2, agent: "hermes" }),
    ];
    const { daily, replay } = compareReplay({ seed: 102, events, coveredDay: 0, replayDay: 10 });
    expect(preferenceIds(daily.dump).filter((id) => id.includes("lint"))).toHaveLength(1);
    expect(firstDreamHistoryDifference(daily.dump, replay.dump)).toBeNull();
  }, 60_000);

  test("a minimum age reached on a day with no input promotes on that day", () => {
    const events = [
      anchor,
      signal({ slug: "m1", topic: "naming", day: 1, agent: "claude" }),
      signal({ slug: "m2", topic: "naming", day: 1, agent: "codex", hour: 10 }),
      signal({ slug: "m3", topic: "naming", day: 1, agent: "hermes", hour: 11 }),
    ];
    const { daily, replay } = compareReplay({
      seed: 103,
      events,
      coveredDay: 0,
      replayDay: 8,
      settings: { "guardrails.promotion_min_age_days": 3 },
    });
    const promoted = preferenceIds(daily.dump).filter((id) => id.includes("naming"));
    expect(promoted).toHaveLength(1);
    expect(String(preferenceFields(daily.dump, promoted[0]!)?.["created_at"])).toStartWith(
      dateOf(4),
    );
    expect(firstDreamHistoryDifference(daily.dump, replay.dump)).toBeNull();
  }, 60_000);

  test("a record dated weeks ahead counts on the day it is admitted", () => {
    const ahead = 30;
    const events = [
      anchor,
      signal({ slug: "f1", topic: "future", day: ahead, admitOn: 5 }),
      signal({ slug: "f2", topic: "future", day: ahead, admitOn: 5, agent: "codex" }),
      signal({ slug: "f3", topic: "future", day: ahead, admitOn: 5, agent: "hermes" }),
    ];
    const { daily, replay } = compareReplay({
      seed: 104,
      events,
      coveredDay: 0,
      replayDay: 5,
      allowFuture: true,
    });
    const promoted = preferenceIds(daily.dump).filter((id) => id.includes("future"));
    expect(promoted).toHaveLength(1);
    expect(String(preferenceFields(daily.dump, promoted[0]!)?.["created_at"])).toStartWith(
      dateOf(5),
    );
    expect(firstDreamHistoryDifference(daily.dump, replay.dump)).toBeNull();
  }, 60_000);
});
