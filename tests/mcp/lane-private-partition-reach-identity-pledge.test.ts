/**
 * A write decision taken from the narrowed view (identity-pledge): a
 * `brain_pledge add`, or a `brain_intake_pledges` post, whose promise a
 * private pledge already stores under an identity-suffixed slot.
 *
 * The lane's writer decides "this promise is already a pledge" from the
 * caller's fold, which below local reach hides the `private` partition.
 * Each test seeds the private entry through the local server, records
 * every lane record of the store, makes the remote call, and compares. The
 * same call through a local server on a twin store is the control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { wholeLaneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import { laneEntryInPrivate } from "../../src/core/store/lane-pages.ts";
import { isIdentitySuffixedStem, titleSlug } from "../../src/core/vault.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  callJson,
  localServer,
  server,
  AGENT,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";

const WITHHELD = "this entry cannot be written at this reach";
const SOURCE = "Notes/zqidentity-source.md";
const SOURCE_TEXT = "# Source\n\nWe will ship the report.\n";
const EVIDENCE = ["We will ship the report."];
const TITLE = "Zqidentity pledge report";
const DUE = "2026-12-01";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function env(): LaneEnv {
  const lane = makeLaneEnv("store", "osb-lane-identity-pledge-");
  lanes.push(lane);
  mkdirSync(join(lane.vault, "Notes"), { recursive: true });
  writeFileSync(join(lane.vault, SOURCE), SOURCE_TEXT, "utf8");
  return lane;
}

/** Every lane record of both partitions, serialized and sorted: the store's lane bytes. */
function records(e: LaneEnv): string[] {
  return (["shared", "private"] as const)
    .flatMap((partition) =>
      e.laneRecords(partition).map((r) => `${partition} ${JSON.stringify(r)}`),
    )
    .toSorted();
}

/** The stems of the live pledges `partition` holds, from the fold of every partition. */
function pledgeStems(e: LaneEnv, partition: "shared" | "private"): string[] {
  const fold = wholeLaneStoreFold();
  return [...fold.entries]
    .filter(
      ([key, value]) =>
        value.lane === "pledges" && fold.privateKeys.has(key) === (partition === "private"),
    )
    .map(([, value]) => value.entry.replace(/\.md$/, ""))
    .filter((stem) => !stem.startsWith("archive/"))
    .toSorted();
}

function addArgs(title: string, due: string): Record<string, unknown> {
  return { operation: "add", title, due, source: SOURCE, evidence: EVIDENCE, agent: AGENT };
}

/** The slug of a pledge `add` answer. */
function addedSlug(answer: Record<string, unknown>): string {
  return String((answer["pledge"] as Record<string, unknown>)["slug"]);
}

/**
 * A private pledge titled `TITLE` due `DUE` in its identity-suffixed slot: a
 * pledge of the same title due another day holds the base slot while it is
 * added, then that holder is removed.
 */
async function seedSuffixed(e: LaneEnv): Promise<string> {
  const local = localServer(e);
  const holder = await callJson(local, "brain_pledge", addArgs(TITLE, "2026-12-02"));
  const hidden = await callJson(local, "brain_pledge", {
    ...addArgs(TITLE, DUE),
    notes: `zqidentity notes ${REGION}`,
  });
  expect(hidden["error"]).toBeUndefined();
  const removed = await callJson(local, "brain_pledge", {
    operation: "remove",
    slug: addedSlug(holder),
  });
  expect(removed["error"]).toBeUndefined();
  const suffixed = pledgeStems(e, "private").filter((stem) => stem === addedSlug(hidden));
  expect(suffixed).toHaveLength(1);
  expect(isIdentitySuffixedStem(suffixed[0]!)).toBe(true);
  expect(pledgeStems(e, "shared").filter((stem) => stem === titleSlug(TITLE))).toEqual([]);
  expect(laneEntryInPrivate(e.vault, join(e.vault, "Brain", "pledges", `${suffixed[0]}.md`))).toBe(
    true,
  );
  return suffixed[0]!;
}

describe("an add that meets a private pledge under another slot", () => {
  test("a remote add that meets a private pledge in an identity-suffixed slot changes nothing", async () => {
    const e = env();
    await seedSuffixed(e);
    const before = records(e);
    const remote = await callJson(server(e), "brain_pledge", addArgs(TITLE, DUE));
    expect({
      answer: remote,
      shared: pledgeStems(e, "shared"),
      kept: records(e).length === before.length,
    }).toEqual({ answer: { error: `brain_pledge: ${WITHHELD}` }, shared: [], kept: true });
    expect(records(e)).toEqual(before);
  });

  test("a local add of the same promise is refused as a duplicate and changes nothing", async () => {
    const e = env();
    const suffixed = await seedSuffixed(e);
    const before = records(e);
    const local = await callJson(localServer(e), "brain_pledge", addArgs(TITLE, DUE));
    const error = String(local["error"] ?? "");
    expect({
      duplicate: error.includes("pledge already exists"),
      names_suffixed: error.includes(suffixed),
      shared: pledgeStems(e, "shared"),
    }).toEqual({ duplicate: true, names_suffixed: true, shared: [] });
    expect(records(e)).toEqual(before);
  });

  test("a remote intake that meets a private pledge in an identity-suffixed slot changes nothing", async () => {
    const e = env();
    await seedSuffixed(e);
    const before = records(e);
    const remote = await callJson(server(e), "brain_intake_pledges", {
      source: SOURCE,
      pledges: [{ title: TITLE, due: DUE, evidence: EVIDENCE }],
    });
    expect({
      answer: remote,
      shared: pledgeStems(e, "shared"),
      kept: records(e).length === before.length,
    }).toEqual({ answer: { error: `brain_intake_pledges: ${WITHHELD}` }, shared: [], kept: true });
    expect(records(e)).toEqual(before);
  });

  test("a local intake of the same promise reports the duplicate and changes nothing", async () => {
    const e = env();
    const suffixed = await seedSuffixed(e);
    const before = records(e);
    const local = await callJson(localServer(e), "brain_intake_pledges", {
      source: SOURCE,
      pledges: [{ title: TITLE, due: DUE, evidence: EVIDENCE }],
    });
    expect({
      created: local["created"],
      duplicates: local["duplicates"],
      shared: pledgeStems(e, "shared"),
    }).toEqual({ created: [], duplicates: [suffixed], shared: [] });
    expect(records(e)).toEqual(before);
  });
});
