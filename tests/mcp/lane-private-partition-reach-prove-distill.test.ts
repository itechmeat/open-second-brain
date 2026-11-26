/**
 * A create the caller addresses below local reach (prove-distill): a
 * `brain_distill_source` whose distillation page of this source a private
 * page holds, under its own suffixed stem or under an older Latin-only
 * slug (claim 6).
 *
 * Each test seeds the private page through the local server (its claim
 * carries a private region), records every lane record of the store,
 * makes the remote call, and compares. The same call through a local
 * server on a twin store is the control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sourceIdentityHash } from "../../src/core/brain/provenance/provenance.ts";
import { distillationPagePath } from "../../src/core/brain/paths.ts";
import { wholeLaneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import { laneEntryInPrivate, moveLanePage } from "../../src/core/store/lane-pages.ts";
import { slugify, titleKeySlug } from "../../src/core/vault.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  callJson,
  localServer,
  server,
  AGENT,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";

const WITHHELD = "this entry cannot be written at this reach";
const SOURCE = "Notes/zqprove-vérifier.md";
const SOURCE_TEXT = "# Source\n\nWe will ship the report.\n";
const HASH = sourceIdentityHash([SOURCE]).slice(0, 12);

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function env(prefix: string): LaneEnv {
  const lane = makeLaneEnv("store", `osb-lane-prove-distill-${prefix}-`);
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

/** The distillation pages `partition` holds, from the fold of every partition. */
function pages(e: LaneEnv, partition: "shared" | "private"): string[] {
  const fold = wholeLaneStoreFold();
  return [...fold.entries]
    .filter(
      ([key, value]) =>
        value.lane === "distillations" && fold.privateKeys.has(key) === (partition === "private"),
    )
    .map(([, value]) => value.entry.replace(/\.md$/, ""))
    .toSorted();
}

function distillArgs(claim: string): Record<string, unknown> {
  return { source_path: SOURCE, claims: [{ text: claim }], agent: AGENT };
}

/** A private distillation of the source at `stem`, re-filed there from the page the local server wrote. */
async function seedPrivate(e: LaneEnv, stem: string): Promise<string> {
  const local = await callJson(
    localServer(e),
    "brain_distill_source",
    distillArgs(`zqprove held claim ${REGION}`),
  );
  expect(local["error"]).toBeUndefined();
  const written = pages(e, "private");
  expect(written).toHaveLength(1);
  expect(pages(e, "shared")).toEqual([]);
  const from = distillationPagePath(e.vault, written[0]!.replace(/^dist-/, ""));
  const to = distillationPagePath(e.vault, stem);
  if (from !== to) moveLanePage(e.vault, from, to);
  expect(laneEntryInPrivate(e.vault, to)).toBe(true);
  expect(pages(e, "private")).toEqual([`dist-${stem}`]);
  return to;
}

describe("a distillation whose page a private page holds", () => {
  test("a remote distillation that meets the private page at its own stem writes nothing", async () => {
    const e = env("own");
    const stem = `${titleKeySlug(SOURCE)}-${HASH}`;
    const path = await seedPrivate(e, stem);
    const before = records(e);

    const remote = await callJson(server(e), "brain_distill_source", distillArgs("zqprove claim"));

    expect({
      answer: remote,
      shared: pages(e, "shared"),
      private: pages(e, "private"),
      private_kept: laneEntryInPrivate(e.vault, path),
    }).toEqual({
      answer: { error: `brain_distill_source: ${WITHHELD}` },
      shared: [],
      private: [`dist-${stem}`],
      private_kept: true,
    });
    expect(records(e)).toEqual(before);
  });

  test("a remote distillation that meets the private page under an older slug writes nothing", async () => {
    const e = env("legacy");
    expect(slugify(SOURCE)).not.toBe(titleKeySlug(SOURCE));
    const stem = `${slugify(SOURCE)}-${HASH}`;
    const path = await seedPrivate(e, stem);
    const before = records(e);

    const remote = await callJson(server(e), "brain_distill_source", distillArgs("zqprove claim"));

    expect({
      answer: remote,
      shared: pages(e, "shared"),
      private: pages(e, "private"),
      private_kept: laneEntryInPrivate(e.vault, path),
    }).toEqual({
      answer: { error: `brain_distill_source: ${WITHHELD}` },
      shared: [],
      private: [`dist-${stem}`],
      private_kept: true,
    });
    expect(records(e)).toEqual(before);
  });

  test("a local distillation rewrites the private page under the older slug in place", async () => {
    const e = env("local");
    const stem = `${slugify(SOURCE)}-${HASH}`;
    await seedPrivate(e, stem);
    const local = await callJson(
      localServer(e),
      "brain_distill_source",
      distillArgs("zqprove claim"),
    );
    expect(local["error"] ?? null).toBeNull();
    expect({
      created: local["created"],
      shared: pages(e, "shared"),
      private: pages(e, "private"),
    }).toEqual({ created: false, shared: [], private: [`dist-${stem}`] });
  });
});
