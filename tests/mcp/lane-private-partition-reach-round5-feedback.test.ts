/**
 * A forced confirmation whose rule a private preference holds at the same
 * slug (fifth closure round, finding 7).
 *
 * A `brain_feedback` with `force_confirmed` writes a signal and a log line,
 * then the confirmed rule at the topic's slug. Below local reach a rule
 * held in `private` at that slug refuses the call with the fixed answer
 * before the signal is written, so nothing is half done.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { writePreference } from "../../src/core/brain/preference.ts";
import { LANE_ENTRY_WITHHELD_MESSAGE } from "../../src/core/store/lane-reach-guard.ts";
import { readStoreEntities } from "../../src/core/store/read/store-entities.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { REGION, call, server } from "./lane-private-partition-reach-writes-fixture.ts";

const TOPIC = "zqheld bun rule";
const SLUG = "zqheld-bun-rule";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function seed(): LaneEnv {
  const e = makeLaneEnv("store", "osb-lane-round5-feedback-");
  lanes.push(e);
  writePreference(e.vault, {
    slug: SLUG,
    topic: TOPIC,
    principle: `Use bun ${REGION}`,
    created_at: "2026-11-01T00:00:00Z",
    unconfirmed_until: "2026-11-08T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-11-01T00:00:00Z",
    evidenced_by: [],
  });
  expect(readStoreEntities()?.preferences.get(`pref-${SLUG}`)?.private).toBe(true);
  return e;
}

const signals = (): number => readStoreEntities()?.signals.size ?? 0;

describe("a forced confirmation whose slug a private rule holds", () => {
  test("a remote call gets the fixed refusal before any signal is written", async () => {
    const e = seed();
    const before = signals();
    const answer = await call(server(e), "brain_feedback", {
      topic: TOPIC,
      signal: "positive",
      principle: "Use bun for scripts",
      force_confirmed: true,
    });
    expect({
      fixed: answer.includes(LANE_ENTRY_WITHHELD_MESSAGE),
      names: answer.includes(`pref-${SLUG}`),
      signals: signals(),
    }).toEqual({ fixed: true, names: false, signals: before });
  });

  test("a remote call without a forced confirmation records its signal", async () => {
    const e = seed();
    const before = signals();
    const answer = await call(server(e), "brain_feedback", {
      topic: TOPIC,
      signal: "positive",
      principle: "Use bun for scripts",
    });
    expect(answer.includes(LANE_ENTRY_WITHHELD_MESSAGE)).toBe(false);
    expect(signals()).toBe(before + 1);
  });
});
