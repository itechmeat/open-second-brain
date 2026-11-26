/**
 * A tension detection whose second finding a private tension holds (fifth
 * closure round, finding 8).
 *
 * Detection persists every finding in turn. Below local reach a finding
 * whose tension page is held in `private` refuses the whole call with the
 * fixed answer before the first page is written, so a call that fails
 * leaves nothing of its other findings behind.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { detectTensions } from "../../src/core/brain/tensions.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { LaneEntryWithheldError } from "../../src/core/store/lane-reach-guard.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";

const FIRST = [
  { id: "pref-zqalpha-on", text: "Always use zqalpha tabs for indentation in source files." },
  { id: "pref-zqalpha-off", text: "Never use zqalpha tabs for indentation in source files." },
];
const HELD = [
  { id: "pref-zqbeta-on", text: "Always run zqbeta checks before every release build." },
  { id: "pref-zqbeta-off", text: "Never run zqbeta checks before every release build." },
];

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

/** A store whose tension of the `HELD` pair is held in `private`. */
function seed(): LaneEnv {
  const e = makeLaneEnv("store", "osb-lane-round5-tension-");
  lanes.push(e);
  const held = detectTensions(e.vault, HELD, {
    jaccard: 0.3,
    agent: "tester",
    visibilityOf: () => ["private"],
  });
  expect(held.created).toBe(1);
  expect(e.laneRecords("private").length).toBeGreaterThan(0);
  return e;
}

describe("a remote detection whose later finding a private tension holds", () => {
  test("gets the fixed refusal and writes none of its findings", () => {
    const e = seed();
    const before = JSON.stringify(e.laneRecords());
    const thrown = withPrivateWithheld(true, () => {
      try {
        detectTensions(e.vault, [...FIRST, ...HELD], { jaccard: 0.3, agent: "tester" });
        return null;
      } catch (err) {
        return err;
      }
    });
    expect(thrown).toBeInstanceOf(LaneEntryWithheldError);
    expect(JSON.stringify(e.laneRecords())).toBe(before);
  });

  test("a local detection refreshes the held tension and creates the other", () => {
    const e = seed();
    const res = detectTensions(e.vault, [...FIRST, ...HELD], { jaccard: 0.3, agent: "tester" });
    expect({ created: res.created, updated: res.updated }).toEqual({ created: 1, updated: 1 });
  });
});
