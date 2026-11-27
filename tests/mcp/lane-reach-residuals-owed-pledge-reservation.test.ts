/**
 * The pledge reservation (change `lane-reach-residuals`, package 19; owed
 * by 2.0.4, fifth closure round, finding 10a).
 *
 * A pledge whose exact title is an identity-suffixed slot of a new
 * pledge, filed under another stem, reserves that slot: a create never
 * lands there, or the slot's name would name two promises. Below local
 * reach the reservation is read on the fold of every partition with the
 * transport's reach widened to every entry held in `private`
 * (`slotReservedAtReach`). So when the base slot holds another promise and
 * the suffixed slot is reserved by a private pledge, a remote add gets
 * the fixed answer and writes nothing, where a local add is refused by
 * the slot's name; with a shared reservation the remote add is refused by
 * name as the local one is. Every refused call compares the raw records
 * of both partitions before and after.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { pledgePath } from "../../src/core/brain/paths.ts";
import { pledgeSlugCandidates } from "../../src/core/brain/pledges.ts";
import { laneEntryInPrivate, removeLanePage } from "../../src/core/store/lane-pages.ts";
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
import { rawRecords } from "./lane-reach-residuals-owed-fixture.ts";

const SOURCE = "Notes/zqreserve-source.md";
const EVIDENCE = ["We will ship the report."];
const TITLE = "Zqreserve pledge report";
const DUE = "2026-12-01";
const [BASE, SUFFIXED] = pledgeSlugCandidates(TITLE, DUE, SOURCE) as [string, string];
/** The reserving pledge: titled with the suffixed slot, filed under its own suffixed stem. */
const HELD_DUE = "2026-12-02";
const ELSEWHERE = pledgeSlugCandidates(SUFFIXED, HELD_DUE, SOURCE)[1]!;

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0).toReversed()) lane.cleanup();
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

const slugOf = (answer: Record<string, unknown>): unknown =>
  (answer["pledge"] as Record<string, unknown> | undefined)?.["slug"];

/**
 * A store where the base slot of `(TITLE, DUE)` holds another promise of
 * the same title and the suffixed slot is free but reserved: a pledge
 * whose exact title is that slot sits under its own suffixed stem,
 * `private` when `held`.
 */
async function seeded(held: boolean): Promise<LaneEnv> {
  const e = makeLaneEnv("store", "osb-lane-owed-pledge-reservation-");
  lanes.push(e);
  mkdirSync(join(e.vault, "Notes"), { recursive: true });
  writeFileSync(join(e.vault, SOURCE), "# Source\n\nWe will ship the report.\n", "utf8");
  const local = localServer(e);
  expect(slugOf(await callJson(local, "brain_pledge", add(TITLE, "2026-12-09")))).toBe(BASE);
  // A pledge holds the suffixed slot while the reserving one is added, so
  // the reserving one takes its own suffixed stem; the holder then goes,
  // leaving the slot free and only reserved.
  expect(pledgeSlugCandidates(SUFFIXED, "2026-12-08", SOURCE)[0]).toBe(SUFFIXED);
  expect(slugOf(await callJson(local, "brain_pledge", add(SUFFIXED, "2026-12-08")))).toBe(SUFFIXED);
  const reserving = add(SUFFIXED, HELD_DUE, held ? `held ${REGION}` : undefined);
  expect(slugOf(await callJson(local, "brain_pledge", reserving))).toBe(ELSEWHERE);
  expect(removeLanePage(e.vault, pledgePath(e.vault, SUFFIXED))).toBe(true);
  expect(laneEntryInPrivate(e.vault, pledgePath(e.vault, ELSEWHERE))).toBe(held);
  expect(laneEntryInPrivate(e.vault, pledgePath(e.vault, BASE))).toBe(false);
  return e;
}

describe("a suffixed slot a private pledge's title reserves", () => {
  test("a remote add gets the fixed answer and writes nothing", async () => {
    const e = await seeded(true);
    const before = rawRecords(e);
    const answer = await call(server(e), "brain_pledge", add(TITLE, DUE));
    expect({
      fixed: answer.includes(LANE_ENTRY_WITHHELD_MESSAGE),
      names: [BASE, SUFFIXED, ELSEWHERE].filter((slug) => answer.includes(slug)),
    }).toEqual({ fixed: true, names: [] });
    expect(rawRecords(e)).toBe(before);
  });

  test("the local add is refused by the reserved slot's name and writes nothing", async () => {
    const e = await seeded(true);
    const before = rawRecords(e);
    const answer = await call(localServer(e), "brain_pledge", add(TITLE, DUE));
    expect(answer.includes(`pledge already exists: ${SUFFIXED}`)).toBe(true);
    expect(rawRecords(e)).toBe(before);
  });
});

describe("a suffixed slot a shared pledge's title reserves", () => {
  test("a remote add is refused by the reserved slot's name, as the local one is", async () => {
    const e = await seeded(false);
    const before = rawRecords(e);
    const remote = await call(server(e), "brain_pledge", add(TITLE, DUE));
    const local = await call(localServer(e), "brain_pledge", add(TITLE, DUE));
    expect(remote.includes(`pledge already exists: ${SUFFIXED}`)).toBe(true);
    expect(local.includes(`pledge already exists: ${SUFFIXED}`)).toBe(true);
    expect(rawRecords(e)).toBe(before);
  });
});
