/**
 * A create the caller addresses below local reach (prove-ingest): a
 * `brain_ingest_source` whose summary page of this source a private page
 * holds, under its own suffixed stem or under an older Latin-only slug
 * (claim 7).
 *
 * Each test seeds the private page through the local server (its summary
 * carries a private region), records every lane record of the store and
 * the manifest's bytes, makes the remote call, and compares: nothing is
 * written before the entity intake. The same call through a local server
 * on a twin store is the control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sourceIdentityHash } from "../../src/core/brain/provenance/provenance.ts";
import { manifestPath } from "../../src/core/brain/ingest/content-manifest.ts";
import { sourcePagePath } from "../../src/core/brain/paths.ts";
import { normalizeSourceIdentity } from "../../src/core/brain/intake/source-trust.ts";
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
const HASH = sourceIdentityHash([normalizeSourceIdentity(SOURCE)]).slice(0, 12);

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function env(prefix: string): LaneEnv {
  const lane = makeLaneEnv("store", `osb-lane-prove-ingest-${prefix}-`);
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

/** The source summary pages `partition` holds, from the fold of every partition. */
function pages(e: LaneEnv, partition: "shared" | "private"): string[] {
  const fold = wholeLaneStoreFold();
  return [...fold.entries]
    .filter(
      ([key, value]) =>
        value.lane === "sources" && fold.privateKeys.has(key) === (partition === "private"),
    )
    .map(([, value]) => value.entry.replace(/\.md$/, ""))
    .toSorted();
}

const INGEST = {
  agent: AGENT,
  source_path: SOURCE,
  summary: "zqprove summary of the source.",
  entities: [{ category: "concept", name: "Zqprove Concept" }],
};

/** The manifest's bytes, or null when the store holds no manifest file. */
function manifestBytes(e: LaneEnv): string | null {
  const path = manifestPath(e.vault);
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

/** The entity pages `partition` holds, as `category/id`, from the fold of every partition. */
function entities(e: LaneEnv, partition: "shared" | "private"): string[] {
  const fold = wholeLaneStoreFold();
  return [...fold.entries]
    .filter(
      ([key, value]) =>
        value.lane === "entities" && fold.privateKeys.has(key) === (partition === "private"),
    )
    .map(([, value]) => value.entry.replace(/\.md$/, ""))
    .toSorted();
}

/** A private summary of the source at `stem`, re-filed there from the page the local server wrote. */
async function seedPrivate(e: LaneEnv, stem: string): Promise<string> {
  const local = await callJson(localServer(e), "brain_ingest_source", {
    ...INGEST,
    summary: `zqprove held summary ${REGION}`,
  });
  expect(local["error"]).toBeUndefined();
  const written = pages(e, "private");
  expect(written).toHaveLength(1);
  expect(pages(e, "shared")).toEqual([]);
  const from = sourcePagePath(e.vault, written[0]!.replace(/^src-/, ""));
  const to = sourcePagePath(e.vault, stem);
  if (from !== to) moveLanePage(e.vault, from, to);
  expect(laneEntryInPrivate(e.vault, to)).toBe(true);
  expect(pages(e, "private")).toEqual([`src-${stem}`]);
  return to;
}

describe("a source ingest whose summary page a private page holds", () => {
  test("a remote ingest that meets the private summary at its own stem writes nothing", async () => {
    const e = env("own");
    const stem = `${titleKeySlug(SOURCE)}-${HASH}`;
    const path = await seedPrivate(e, stem);
    const before = records(e);
    const entitiesBefore = entities(e, "shared");
    expect(entitiesBefore).toHaveLength(1);
    const manifestBefore = manifestBytes(e);
    expect(manifestBefore).toContain(SOURCE);

    const remote = await callJson(server(e), "brain_ingest_source", INGEST);

    expect({
      answer: remote,
      shared: pages(e, "shared"),
      private: pages(e, "private"),
      private_kept: laneEntryInPrivate(e.vault, path),
      manifest_same: manifestBytes(e) === manifestBefore,
    }).toEqual({
      answer: { error: `brain_ingest_source: ${WITHHELD}` },
      shared: [],
      private: [`src-${stem}`],
      private_kept: true,
      manifest_same: true,
    });
    expect(records(e)).toEqual(before);
    expect(entities(e, "shared")).toEqual(entitiesBefore);
  });

  test("a remote ingest that meets the private summary under an older slug writes nothing before the entity intake", async () => {
    const e = env("legacy");
    expect(slugify(SOURCE)).not.toBe(titleKeySlug(SOURCE));
    const stem = `${slugify(SOURCE)}-${HASH}`;
    const path = await seedPrivate(e, stem);
    const before = records(e);
    const entitiesBefore = entities(e, "shared");
    expect(entitiesBefore).toHaveLength(1);
    const manifestBefore = manifestBytes(e);
    expect(manifestBefore).toContain(SOURCE);

    const remote = await callJson(server(e), "brain_ingest_source", INGEST);

    expect({
      answer: remote,
      shared: pages(e, "shared"),
      private: pages(e, "private"),
      private_kept: laneEntryInPrivate(e.vault, path),
      manifest_same: manifestBytes(e) === manifestBefore,
    }).toEqual({
      answer: { error: `brain_ingest_source: ${WITHHELD}` },
      shared: [],
      private: [`src-${stem}`],
      private_kept: true,
      manifest_same: true,
    });
    expect(records(e)).toEqual(before);
    expect(entities(e, "shared")).toEqual(entitiesBefore);
  });

  test("a local ingest rewrites the private summary under the older slug in place", async () => {
    const e = env("local");
    const stem = `${slugify(SOURCE)}-${HASH}`;
    await seedPrivate(e, stem);
    const local = await callJson(localServer(e), "brain_ingest_source", INGEST);
    expect(local["error"] ?? null).toBeNull();
    expect({
      created: local["created"],
      shared: pages(e, "shared"),
      private: pages(e, "private"),
      shared_entities: entities(e, "shared").length,
    }).toEqual({ created: false, shared: [], private: [`src-${stem}`], shared_entities: 1 });
  });
});
