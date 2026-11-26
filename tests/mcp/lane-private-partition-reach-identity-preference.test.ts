/**
 * A write decision taken from the narrowed view (identity-preference): a
 * `brain_feedback` on a topic whose rule an older release filed under the
 * Latin-only slug, held in `private`.
 *
 * The rule's slug is the topic's identity: a local call meets the rule at
 * its old slug instead of minting a second rule. Below local reach that
 * lookup reads the whole fold, so a remote call that would meet the
 * private rule gets the fixed refusal before any write, and its answer
 * carries nothing of the rule (ruling 1). The same call at local reach is
 * the control.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { writePreference } from "../../src/core/brain/preference.ts";
import { readStoreEntities } from "../../src/core/store/read/store-entities.ts";
import { LANE_ENTRY_WITHHELD_MESSAGE } from "../../src/core/store/lane-reach-guard.ts";
import { slugify } from "../../src/core/vault.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  REGION,
  call,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

const TOPIC = "不要感叹号规则";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

/** A private rule for `TOPIC` under the slug an older release gave it. Returns that slug. */
function seed(): { e: LaneEnv; old: string } {
  const e = makeLaneEnv("store", "osb-lane-identity-preference-");
  lanes.push(e);
  const old = slugify(TOPIC);
  writePreference(e.vault, {
    slug: old,
    topic: TOPIC,
    principle: `Never use exclamation marks ${REGION}`,
    created_at: "2026-11-01T00:00:00Z",
    unconfirmed_until: "2026-11-08T00:00:00Z",
    status: "confirmed",
    confirmed_at: "2026-11-01T00:00:00Z",
    evidenced_by: [],
  });
  const held = readStoreEntities()?.preferences.get(`pref-${old}`);
  expect(held?.private).toBe(true);
  return { e, old };
}

const rulesOfTopic = (): string[] =>
  [...(readStoreEntities()?.preferences.keys() ?? [])]
    .filter((id) => id.includes("感叹号") || id.startsWith("pref-unnamed"))
    .toSorted();

const ARGS = {
  topic: TOPIC,
  signal: "positive",
  principle: "Never use exclamation marks in docs",
  force_confirmed: true,
};

describe("a feedback whose topic a private rule holds under its old slug", () => {
  test("a remote call gets the fixed refusal and mints no second rule", async () => {
    const { e, old } = seed();
    const before = rulesOfTopic();
    const answer = await call(server(e), "brain_feedback", ARGS);
    expect({
      refused: answer.includes(LANE_ENTRY_WITHHELD_MESSAGE),
      names: answer.includes(old),
      rules: rulesOfTopic(),
    }).toEqual({ refused: true, names: false, rules: before });
  });

  test("a local call meets the rule at its old slug", async () => {
    const { e, old } = seed();
    const before = rulesOfTopic();
    const answer = await call(localServer(e), "brain_feedback", ARGS);
    expect({ meets: answer.includes(`pref-${old}`), rules: rulesOfTopic() }).toEqual({
      meets: true,
      rules: before,
    });
  });
});
