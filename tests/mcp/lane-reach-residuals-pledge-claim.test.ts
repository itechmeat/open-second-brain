/**
 * An identity decision below local reach applies the caller's identity
 * rule to the whole fold, for a pledge add (change `lane-reach-residuals`,
 * package 8, design R8): the title claim and the slot reservation of
 * `brain_pledge add` are read on the fold of every partition with the
 * transport's reach predicate widened to every entry held in `private`.
 *
 * A private pledge whose exact title is the base slug of a new pledge,
 * filed under its own identity-suffixed stem, holds that base slot: a remote add lands on
 * the slot a local add takes on the same kind of store (the local control
 * records it), never on the held base slot; and when every slot is taken,
 * one of them by that private title, the remote add gets the fixed answer,
 * not a message naming a slug. Every refused call compares the raw records
 * of both partitions before and after.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { pledgePath } from "../../src/core/brain/paths.ts";
import { pledgeSlugCandidates } from "../../src/core/brain/pledges.ts";
import { laneEntryInPrivate, removeLanePage } from "../../src/core/store/lane-pages.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  AGENT,
  REGION,
  call,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

const WITHHELD = "this entry cannot be written at this reach";
const SOURCE = "Notes/zqclaim-source.md";
const EVIDENCE = ["We will ship the report."];
const TITLE = "Zqclaim pledge report";
const DUE = "2026-12-01";
const [BASE, SUFFIXED] = pledgeSlugCandidates(TITLE, DUE, SOURCE) as [string, string];
/** The held pledge: titled with the base slug, with its own identity and stem. */
const HELD_DUE = "2026-12-02";
const ELSEWHERE = pledgeSlugCandidates(BASE, HELD_DUE, SOURCE)[1]!;

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

/** Every record of both partitions, by id, as the store holds them. */
function rawRecords(e: LaneEnv): string {
  const ids = (partition: "shared" | "private") =>
    readPartition(join(e.env.storeRoot, partition))
      .flatMap((shard) => shard.all)
      .map((r) => r.id)
      .toSorted();
  return JSON.stringify({ shared: ids("shared"), private: ids("private") });
}

/**
 * A store holding a private pledge whose exact title is the base slug of
 * `(TITLE, DUE)`, filed under another stem; with `suffixedHeld`, the
 * suffixed slot also holds a shared pledge of another identity.
 */
async function seeded(suffixedHeld: boolean): Promise<LaneEnv> {
  const e = makeLaneEnv("store", "osb-lane-pledge-claim-");
  lanes.push(e);
  mkdirSync(join(e.vault, "Notes"), { recursive: true });
  writeFileSync(join(e.vault, SOURCE), "# Source\n\nWe will ship the report.\n", "utf8");
  const local = localServer(e);
  // A shared pledge holds the base slot while the private one is added, so
  // the private one takes its own identity-suffixed stem; the shared one
  // then goes, leaving the base slot free (no private record holds it).
  const opener = await callJson(local, "brain_pledge", add(BASE, "2026-12-09"));
  expect((opener["pledge"] as Record<string, unknown>)["slug"]).toBe(BASE);
  const held = await callJson(local, "brain_pledge", add(BASE, HELD_DUE, `held ${REGION}`));
  expect((held["pledge"] as Record<string, unknown>)["slug"]).toBe(ELSEWHERE);
  expect(removeLanePage(e.vault, pledgePath(e.vault, BASE))).toBe(true);
  expect(laneEntryInPrivate(e.vault, pledgePath(e.vault, ELSEWHERE))).toBe(true);
  if (suffixedHeld) {
    const other = await callJson(local, "brain_pledge", add(SUFFIXED, "2026-12-03"));
    expect((other["pledge"] as Record<string, unknown>)["slug"]).toBe(SUFFIXED);
    expect(laneEntryInPrivate(e.vault, pledgePath(e.vault, SUFFIXED))).toBe(false);
  }
  return e;
}

describe("a private pledge's title holds its slug against a remote create", () => {
  test("a local add takes the suffixed slot", async () => {
    const e = await seeded(false);
    const local = await callJson(localServer(e), "brain_pledge", add(TITLE, DUE));
    expect((local["pledge"] as Record<string, unknown>)["slug"]).toBe(SUFFIXED);
  });

  test("a remote add lands on the slot the local add takes, never on the held base slot", async () => {
    const e = await seeded(false);
    const remote = await callJson(server(e), "brain_pledge", add(TITLE, DUE));
    expect({
      error: remote["error"] ?? null,
      slug: (remote["pledge"] as Record<string, unknown> | undefined)?.["slug"] ?? null,
    }).toEqual({ error: null, slug: SUFFIXED });
  });
});

describe("every slot held, one of them by a private pledge's title", () => {
  test("a remote add gets the fixed answer and writes nothing", async () => {
    const e = await seeded(true);
    const before = rawRecords(e);
    const answer = await call(server(e), "brain_pledge", add(TITLE, DUE));
    expect({
      fixed: answer.includes(WITHHELD),
      names: [BASE, SUFFIXED, ELSEWHERE].filter((slug) => answer.includes(slug)),
    }).toEqual({ fixed: true, names: [] });
    expect(rawRecords(e)).toEqual(before);
  });

  test("a local add is refused by the last slot's name", async () => {
    const e = await seeded(true);
    const before = rawRecords(e);
    const answer = await call(localServer(e), "brain_pledge", add(TITLE, DUE));
    expect(answer.includes(`pledge already exists: ${SUFFIXED}`)).toBe(true);
    expect(rawRecords(e)).toEqual(before);
  });
});
