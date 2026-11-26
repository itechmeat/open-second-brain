/**
 * A write decision taken from the narrowed view (identity-obligation): an
 * `add` whose title a private obligation already stores, under another
 * slot (an identity-suffixed one, or the Latin-only slug an older release
 * gave it).
 *
 * The lane's writer decides "this title is already an obligation" from the
 * caller's fold, which below local reach hides the `private` partition.
 * Each test seeds the private entry through the local server, records
 * every lane record of the store, makes the remote call, and compares. The
 * same call through a local server on a twin store is the control.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { obligationPath } from "../../src/core/brain/paths.ts";
import { wholeLaneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import { laneEntryKey } from "../../src/core/store/lane-records.ts";
import { moveLanePage } from "../../src/core/store/lane-pages.ts";
import { laneEntryInPrivate } from "../../src/core/store/lane-pages.ts";
import { isIdentitySuffixedStem, slugify, titleSlug } from "../../src/core/vault.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  callJson,
  localServer,
  server,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";

const WITHHELD = "this entry cannot be written at this reach";
const DECISION_TITLE = "Zqidentity choice";
const REVIEW_TITLE = `Review decision: ${DECISION_TITLE}`;
const LEGACY_TITLE = "Zqidentity vérifier choice";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function env(): LaneEnv {
  const lane = makeLaneEnv("store", "osb-lane-identity-obligation-");
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

/** The slug of an `add` answer. */
function addedSlug(answer: Record<string, unknown>): string {
  return String((answer["obligation"] as Record<string, unknown>)["slug"]);
}

/** The stems of the live obligations `partition` holds, from the fold of every partition. */
function obligationStems(e: LaneEnv, partition: "shared" | "private"): string[] {
  const fold = wholeLaneStoreFold();
  return [...fold.entries]
    .filter(
      ([, value]) =>
        value.lane === "obligations" &&
        fold.privateKeys.has(laneEntryKey(value.lane, value.entry)) === (partition === "private"),
    )
    .map(([, value]) => value.entry.replace(/\.md$/, ""))
    .toSorted();
}

function addArgs(title: string): Record<string, unknown> {
  return { operation: "add", title, cadence: "weekly" };
}

/**
 * A private review obligation in its identity-suffixed slot: a private
 * obligation whose title keys alike holds the plain slot while the
 * decision is recorded, then that holder is removed.
 */
async function seedSuffixed(e: LaneEnv): Promise<string> {
  const local = localServer(e);
  const holder = await callJson(local, "brain_obligation", {
    ...addArgs("Review decision: Zqidentity, choice"),
    notes: `zqholder notes ${REGION}`,
  });
  const recorded = await callJson(local, "brain_decision", {
    action: "record",
    title: DECISION_TITLE,
    chosen: "zqidentity path",
    assumption: "it holds",
    review_date: "2026-12-01",
    notes: `zqidentity notes ${REGION}`,
  });
  expect(recorded["error"]).toBeUndefined();
  const removed = await callJson(local, "brain_obligation", {
    operation: "remove",
    slug: addedSlug(holder),
  });
  expect(removed["error"]).toBeUndefined();
  const suffixed = obligationStems(e, "private").filter(
    (stem) => isIdentitySuffixedStem(stem) && stem.startsWith(`${titleSlug(REVIEW_TITLE)}-`),
  );
  expect(suffixed).toHaveLength(1);
  expect(obligationStems(e, "shared").filter((stem) => stem === titleSlug(REVIEW_TITLE))).toEqual(
    [],
  );
  return suffixed[0]!;
}

describe("an add that meets a private obligation under another slot", () => {
  test("an add that meets a private obligation in an identity-suffixed slot changes nothing", async () => {
    const e = env();
    const suffixed = await seedSuffixed(e);
    const path = obligationPath(e.vault, suffixed);
    expect(laneEntryInPrivate(e.vault, path)).toBe(true);
    expect(obligationStems(e, "shared")).toEqual([]);
    const before = records(e);

    const remote = await callJson(server(e), "brain_obligation", addArgs(REVIEW_TITLE));

    expect({
      answer: remote,
      shared: obligationStems(e, "shared"),
      private_entry_kept: laneEntryInPrivate(e.vault, path),
    }).toEqual({
      answer: { error: `brain_obligation: ${WITHHELD}` },
      shared: [],
      private_entry_kept: true,
    });
    expect(records(e)).toEqual(before);
  });

  test("a local add of the same title is refused as a duplicate and changes nothing", async () => {
    const e = env();
    await seedSuffixed(e);
    const before = records(e);
    const local = await callJson(localServer(e), "brain_obligation", addArgs(REVIEW_TITLE));
    expect({
      error: String(local["error"] ?? ""),
      shared: obligationStems(e, "shared"),
      same: records(e).length === before.length,
    }).toEqual({
      error: expect.stringContaining("obligation already exists") as unknown as string,
      shared: [],
      same: true,
    });
  });

  test("an add that meets a private obligation under its legacy slug changes nothing", async () => {
    const e = env();
    expect(slugify(LEGACY_TITLE)).not.toBe(titleSlug(LEGACY_TITLE));
    const added = await callJson(localServer(e), "brain_obligation", {
      ...addArgs(LEGACY_TITLE),
      notes: `zqlegacy notes ${REGION}`,
    });
    const from = obligationPath(e.vault, addedSlug(added));
    const path = obligationPath(e.vault, slugify(LEGACY_TITLE));
    moveLanePage(e.vault, from, path);
    expect(laneEntryInPrivate(e.vault, path)).toBe(true);
    expect(laneEntryInPrivate(e.vault, from)).toBe(false);
    const before = records(e);

    const remote = await callJson(server(e), "brain_obligation", addArgs(LEGACY_TITLE));

    expect({
      answer: remote,
      shared: obligationStems(e, "shared"),
      private_entry_kept: laneEntryInPrivate(e.vault, path),
    }).toEqual({
      answer: { error: `brain_obligation: ${WITHHELD}` },
      shared: [],
      private_entry_kept: true,
    });
    expect(records(e)).toEqual(before);
  });

  test("a local add of the legacy-slug title is refused as a duplicate and changes nothing", async () => {
    const e = env();
    const added = await callJson(localServer(e), "brain_obligation", {
      ...addArgs(LEGACY_TITLE),
      notes: `zqlegacy notes ${REGION}`,
    });
    moveLanePage(
      e.vault,
      obligationPath(e.vault, addedSlug(added)),
      obligationPath(e.vault, slugify(LEGACY_TITLE)),
    );
    const before = records(e);
    const local = await callJson(localServer(e), "brain_obligation", addArgs(LEGACY_TITLE));
    expect({
      error: String(local["error"] ?? ""),
      shared: obligationStems(e, "shared"),
      same: records(e).length === before.length,
    }).toEqual({
      error: expect.stringContaining("obligation already exists") as unknown as string,
      shared: [],
      same: true,
    });
  });
});
