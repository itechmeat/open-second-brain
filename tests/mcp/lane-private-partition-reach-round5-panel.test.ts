/**
 * A panel session whose topic a private panel of the day holds under its
 * old name (fifth closure round, finding 9).
 *
 * A panel an older release wrote for a topic on a day sits under the
 * Latin-only slug of the topic; a new session of the same topic and day
 * targets that name. The lookup lists the lane (a store-only machine has
 * no file there), so below local reach a private panel of the topic
 * refuses the call with the fixed answer, and at local reach the session
 * targets the held name.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { openPanelSession } from "../../src/core/brain/write-session/panel.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { LaneEntryWithheldError } from "../../src/core/store/lane-reach-guard.ts";
import { laneEntryInPrivate, writeLanePage } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { REGION } from "./lane-private-partition-reach-writes-fixture.ts";

const TOPIC = "Тема zqpanel";
const NOW = "2026-11-20T10:00:00.000Z";
const HELD = "Brain/decisions/panels/panel-2026-11-20-zqpanel.md";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function seed(): LaneEnv {
  const e = makeLaneEnv("store", "osb-lane-round5-panel-");
  lanes.push(e);
  writeLanePage(
    e.vault,
    join(e.vault, HELD),
    { topic: TOPIC, created_at: NOW },
    `held panel ${REGION}\n`,
    { overwrite: false, vaultForRelativePath: e.vault },
  );
  expect(laneEntryInPrivate(e.vault, join(e.vault, HELD))).toBe(true);
  return e;
}

const open = (e: LaneEnv) => openPanelSession(e.vault, { agent: "tester", topic: TOPIC, now: NOW });

describe("a panel session whose topic a private panel of the day holds", () => {
  test("a remote open gets the fixed refusal and writes nothing", () => {
    const e = seed();
    const before = JSON.stringify(e.laneRecords());
    const thrown = withPrivateWithheld(true, () => {
      try {
        open(e);
        return null;
      } catch (err) {
        return err;
      }
    });
    expect(thrown).toBeInstanceOf(LaneEntryWithheldError);
    expect(JSON.stringify(e.laneRecords())).toBe(before);
  });

  test("a local open targets the held panel's name", () => {
    const e = seed();
    expect(JSON.stringify(open(e))).toContain("panel-2026-11-20-zqpanel");
  });
});
