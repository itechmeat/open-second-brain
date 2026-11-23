/**
 * Named equivalence scenarios of the dream replay (task 1.2): retirements
 * whose day is inside the gap, and a person's change made during it.
 */
import { describe, expect, test } from "bun:test";

import { appendRecord } from "../../../../src/core/store/appender.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";
import { compareReplay, firstDreamHistoryDifference } from "../../../helpers/dream-history.ts";
import {
  at,
  auditEvents,
  dateOf,
  evidence,
  preference,
  preferenceFields,
  retire,
  signal,
} from "../../../helpers/dream-replay-scenarios.ts";

const anchor = signal({ slug: "anchor", topic: "anchor-topic", day: 0 });

describe("dream replay: retirements inside the gap", () => {
  test("a trial whose deadline passed in the gap retires in that window", () => {
    const events = [
      anchor,
      preference({
        slug: "trial",
        topic: "trial-topic",
        day: 0,
        status: "unconfirmed",
        deadline: at(5, 12),
      }),
    ];
    const { daily, replay } = compareReplay({ seed: 301, events, coveredDay: 0, replayDay: 10 });
    const fields = preferenceFields(daily.dump, "pref-trial");
    expect(fields?.["status"]).toBe("retired");
    expect(String(fields?.["retired_at"])).toStartWith(dateOf(5));
    expect(firstDreamHistoryDifference(daily.dump, replay.dump)).toBeNull();
  }, 60_000);

  test("a low-recall superseded ancestor decays on its own day", () => {
    const events = [
      anchor,
      preference({ slug: "ancestor", topic: "chain-topic", day: 0 }),
      preference({ slug: "heir", topic: "chain-topic", day: 0 }),
      {
        kind: "human" as const,
        admitOn: 0,
        eventAt: at(0, 1),
        // A person marks the ancestor superseded by the heir (the field the
        // chain decay reads); the preference stays active.
        apply: (_vault: string, storeRoot: string) =>
          void appendRecord(openStore({ root: storeRoot, device: "dev-a" }), {
            partition: "shared",
            stream: "events",
            kind: "preference-set",
            agent: "person",
            body: {
              authority: "human",
              preference: "pref-ancestor",
              fields: { superseded_by: "[[pref-heir]]" },
            },
          }),
      },
    ];
    const { daily, replay } = compareReplay({ seed: 302, events, coveredDay: 0, replayDay: 12 });
    const fields = preferenceFields(daily.dump, "pref-ancestor");
    expect(fields?.["status"]).toBe("retired");
    expect(String(fields?.["retired_at"])).toStartWith(dateOf(7));
    expect(firstDreamHistoryDifference(daily.dump, replay.dump)).toBeNull();
  }, 60_000);

  test("a rule a person retired during the gap is retired in every window", () => {
    const events = [
      anchor,
      // A trial that would expire on day 5.
      preference({
        slug: "hand",
        topic: "hand-topic",
        day: 0,
        status: "unconfirmed",
        deadline: at(5, 0),
      }),
      // The person retires it on day 8; it applies from the first window,
      // so no window retires it as expired.
      retire("hand", 8, "user-rejected"),
    ];
    const { daily, replay } = compareReplay({ seed: 303, events, coveredDay: 0, replayDay: 10 });
    const fields = preferenceFields(daily.dump, "pref-hand");
    expect(fields?.["status"]).toBe("retired");
    expect(fields?.["retired_reason"]).toBe("user-rejected");
    expect(firstDreamHistoryDifference(daily.dump, replay.dump)).toBeNull();
  }, 60_000);

  test("timely evidence after a retirement is a reconciliation, not a revival", () => {
    const events = [
      anchor,
      preference({
        slug: "late-trial",
        topic: "late-topic",
        day: 0,
        status: "unconfirmed",
        deadline: at(3, 12),
      }),
      // Written on another device before the deadline; it syncs after day 5.
      evidence("late-trial", 2, { admitOn: 6, device: "dev-b" }),
    ];
    const { daily, replay } = compareReplay({ seed: 304, events, coveredDay: 5, replayDay: 8 });
    expect(preferenceFields(daily.dump, "pref-late-trial")?.["status"]).toBe("retired");
    const reconciled = auditEvents(daily.dump, "dream").filter(
      (body) => body["reconciliations"] !== undefined,
    );
    expect(JSON.stringify(reconciled)).toContain("late-trial");
    expect(firstDreamHistoryDifference(daily.dump, replay.dump)).toBeNull();
  }, 60_000);
});
