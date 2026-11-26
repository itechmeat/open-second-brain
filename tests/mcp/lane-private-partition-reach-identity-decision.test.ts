/**
 * A write decision taken from the narrowed view (identity-decision): a
 * `brain_decision record` whose title a private decision already stores
 * under the Latin-only slug an older release gave it.
 *
 * The lane's writer decides "this title is already a decision" from the
 * caller's fold, which below local reach hides the `private` partition.
 * The test seeds the private entry through the local server (then files
 * it under the older slot, as an unswitched machine would hold it),
 * records every lane record of the store, makes the remote call, and
 * compares. The same call through a local server on a twin store is the
 * control. A private decision under its current slug is the control's
 * other side: the write lands on the key the private entry holds.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { decisionPath } from "../../src/core/brain/paths.ts";
import { obligationPath } from "../../src/core/brain/paths.ts";
import { wholeLaneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import { laneEntryInPrivate, moveLanePage } from "../../src/core/store/lane-pages.ts";
import { slugify, titleSlug } from "../../src/core/vault.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  callJson,
  localServer,
  server,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";

const WITHHELD = "this entry cannot be written at this reach";
const TITLE = "Zqidentity vérifier choice";
const ARGS = {
  action: "record",
  title: TITLE,
  chosen: "zqidentity path",
  assumption: "it holds",
  review_date: "2026-12-01",
};

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function env(): LaneEnv {
  const lane = makeLaneEnv("store", "osb-lane-identity-decision-");
  lanes.push(lane);
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

/** The live entries of `laneNames` in `partition`, as `lane/entry`, from the fold of every partition. */
function liveEntries(
  lane: LaneEnv,
  laneNames: ReadonlyArray<string>,
  partition: "shared" | "private",
) {
  const fold = wholeLaneStoreFold();
  return [...fold.entries]
    .filter(
      ([key, value]) =>
        laneNames.includes(value.lane) && fold.privateKeys.has(key) === (partition === "private"),
    )
    .map(([key]) => key)
    .toSorted();
}

const DECISION_LANES = ["decisions", "obligations"];

/** Record the decision locally with private notes, then file both pages under their older slugs. */
async function seedLegacy(e: LaneEnv): Promise<{ decision: string; review: string }> {
  const recorded = await callJson(localServer(e), "brain_decision", {
    ...ARGS,
    notes: `zqidentity notes ${REGION}`,
  });
  expect(recorded["error"]).toBeUndefined();
  const decision = decisionPath(e.vault, slugify(TITLE));
  moveLanePage(e.vault, decisionPath(e.vault, titleSlug(TITLE)), decision);
  const review = obligationPath(e.vault, slugify(`Review decision: ${TITLE}`));
  moveLanePage(e.vault, obligationPath(e.vault, titleSlug(`Review decision: ${TITLE}`)), review);
  expect(laneEntryInPrivate(e.vault, decision)).toBe(true);
  expect(laneEntryInPrivate(e.vault, review)).toBe(true);
  return { decision, review };
}

describe("a record that meets a private decision under another slot", () => {
  test("a remote record that meets a private decision under its legacy slug changes nothing", async () => {
    const e = env();
    const seeded = await seedLegacy(e);
    const before = records(e);
    const remote = await callJson(server(e), "brain_decision", ARGS);
    expect({
      answer: remote,
      shared: liveEntries(e, DECISION_LANES, "shared"),
      private_kept:
        laneEntryInPrivate(e.vault, seeded.decision) && laneEntryInPrivate(e.vault, seeded.review),
    }).toEqual({
      answer: { error: `brain_decision: ${WITHHELD}` },
      shared: [],
      private_kept: true,
    });
    expect(records(e)).toEqual(before);
  });

  test("a local record of the same title is refused as a duplicate and changes nothing", async () => {
    const e = env();
    await seedLegacy(e);
    const before = records(e);
    const local = await callJson(localServer(e), "brain_decision", ARGS);
    const error = String(local["error"] ?? "");
    expect({
      duplicate: error.includes("decision already exists"),
      names_legacy: error.includes(slugify(TITLE)),
      shared: liveEntries(e, DECISION_LANES, "shared"),
    }).toEqual({ duplicate: true, names_legacy: true, shared: [] });
    expect(records(e)).toEqual(before);
  });

  test("a remote record that meets a private decision under its current slug changes nothing", async () => {
    const e = env();
    const recorded = await callJson(localServer(e), "brain_decision", {
      ...ARGS,
      notes: `zqidentity notes ${REGION}`,
    });
    expect(recorded["error"]).toBeUndefined();
    const decision = decisionPath(e.vault, titleSlug(TITLE));
    expect(laneEntryInPrivate(e.vault, decision)).toBe(true);
    const before = records(e);
    const remote = await callJson(server(e), "brain_decision", ARGS);
    // The tool wraps the refusal with its own name; the fixed text is what it carries.
    expect({
      fixed: String(remote["error"] ?? "").includes(WITHHELD),
      shared: liveEntries(e, DECISION_LANES, "shared"),
    }).toEqual({ fixed: true, shared: [] });
    expect(records(e)).toEqual(before);
    expect(laneEntryInPrivate(e.vault, decision)).toBe(true);
  });
});
