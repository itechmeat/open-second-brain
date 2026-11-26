/**
 * A pledge add whose every slot other pledges hold in `private` (fifth
 * closure round, finding 10).
 *
 * The ladder of a pledge add skips a slot another promise holds, read on
 * the fold of every partition. When every slot is held, a local add is
 * refused by the last slot's name; below local reach, when a skipped slot
 * was held in `private`, the add gets the fixed refusal instead, so the
 * answer names nothing of those pledges.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { pledgeSlugCandidates } from "../../src/core/brain/pledges.ts";
import { LANE_ENTRY_WITHHELD_MESSAGE } from "../../src/core/store/lane-reach-guard.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  AGENT,
  REGION,
  call,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

const SOURCE = "Notes/zqslots-source.md";
const EVIDENCE = ["We will ship the report."];
const TITLE = "Zqslots pledge report";
const DUE = "2026-12-01";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

const add = (title: string, due: string, notes?: string): Record<string, unknown> => ({
  operation: "add",
  title,
  due,
  source: SOURCE,
  evidence: EVIDENCE,
  agent: AGENT,
  ...(notes === undefined ? {} : { notes }),
});

/** Both slots of `(TITLE, DUE)` held in `private` by pledges of other identities. */
async function seeded(): Promise<LaneEnv> {
  const e = makeLaneEnv("store", "osb-lane-round5-pledge-");
  lanes.push(e);
  mkdirSync(join(e.vault, "Notes"), { recursive: true });
  writeFileSync(join(e.vault, SOURCE), "# Source\n\nWe will ship the report.\n", "utf8");
  const [base, suffixed] = pledgeSlugCandidates(TITLE, DUE, SOURCE);
  const local = localServer(e);
  const first = await callJson(local, "brain_pledge", add(TITLE, "2026-12-02", `held ${REGION}`));
  expect((first["pledge"] as Record<string, unknown>)["slug"]).toBe(base);
  const second = await callJson(local, "brain_pledge", add(suffixed!, DUE, `held ${REGION}`));
  expect((second["pledge"] as Record<string, unknown>)["slug"]).toBe(suffixed);
  return e;
}

describe("a pledge add whose every slot other pledges hold in private", () => {
  test("a remote add gets the fixed refusal and writes nothing", async () => {
    const e = await seeded();
    const before = JSON.stringify(e.laneRecords());
    const answer = await call(server(e), "brain_pledge", add(TITLE, DUE));
    expect({
      fixed: answer.includes(LANE_ENTRY_WITHHELD_MESSAGE),
      names: answer.includes(pledgeSlugCandidates(TITLE, DUE, SOURCE)[1]!),
    }).toEqual({ fixed: true, names: false });
    expect(JSON.stringify(e.laneRecords())).toBe(before);
  });

  test("a local add is refused by the last slot's name", async () => {
    const e = await seeded();
    const answer = await call(localServer(e), "brain_pledge", add(TITLE, DUE));
    expect(answer.includes("pledge already exists")).toBe(true);
  });
});
