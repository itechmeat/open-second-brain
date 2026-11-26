/**
 * A write decision taken from the narrowed view (identity-entity): an
 * entity intake whose name a private entity already answers to.
 *
 * The registry decides "this name is already an entity" from the caller's
 * fold, which below local reach hides the `private` partition. Each test
 * seeds the private entry with the registry's own writer, records every
 * lane record of the store, makes the remote call, and compares. The same
 * call through a local server on a twin store is the control. A private
 * entity under the id the write would allocate is the control's other
 * side: the write lands on the key the private entry holds.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { wholeLaneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import { laneEntryInPrivate } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  callJson,
  localServer,
  server,
  AGENT,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";

const WITHHELD = "this entry cannot be written at this reach";
const NOW = new Date("2026-11-20T10:00:00Z");
const SOURCE = "Notes/zqidentity-source.md";
const SOURCE_TEXT = "# Source\n\nWe will ship the report.\n";
const NAME = "Zqidentity Person";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function env(): LaneEnv {
  const lane = makeLaneEnv("store", "osb-lane-identity-entity-");
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

/** The live entity entries in `partition`, as `category/id`, from the fold of every partition. */
function entities(e: LaneEnv, partition: "shared" | "private"): string[] {
  const fold = wholeLaneStoreFold();
  return [...fold.entries]
    .filter(
      ([key, value]) =>
        value.lane === "entities" && fold.privateKeys.has(key) === (partition === "private"),
    )
    .map(([, value]) => `${String(value.fields["category"])}/${String(value.fields["entity_id"])}`)
    .toSorted();
}

/** A private `people` entity called `name`, with `aliases`, through the registry's writer. */
function seedPrivate(e: LaneEnv, name: string, aliases: string[]): string {
  const { entity } = upsertEntity(e.vault, {
    category: "people",
    name,
    aliases,
    agent: AGENT,
    now: NOW,
    body: `zqidentity notes ${REGION}\n`,
  });
  expect(laneEntryInPrivate(e.vault, entity.path)).toBe(true);
  return entity.id;
}

const INTAKE = { source: `[[${SOURCE}]]`, entities: [{ category: "people", name: NAME }] };
const INGEST = {
  source_path: SOURCE,
  summary: "zqidentity summary of the source.",
  entities: [{ category: "people", name: NAME }],
};

describe("an entity intake that meets a private entity", () => {
  test("a remote intake of a name a private entity's alias answers to changes nothing", async () => {
    const e = env();
    const privateId = seedPrivate(e, "Zqidentity Real Name", [NAME]);
    const before = records(e);
    const remote = await callJson(server(e), "brain_intake_entities", INTAKE);
    expect({
      answer: remote,
      shared: entities(e, "shared"),
      private: entities(e, "private"),
    }).toEqual({
      answer: { error: `brain_intake_entities: ${WITHHELD}` },
      shared: [],
      private: [`people/${privateId}`],
    });
    expect(records(e)).toEqual(before);
  });

  test("a local intake of that name updates the private entity in place", async () => {
    const e = env();
    const privateId = seedPrivate(e, "Zqidentity Real Name", [NAME]);
    const local = await callJson(localServer(e), "brain_intake_entities", INTAKE);
    expect({
      created: local["entities_created"],
      updated: local["entities_updated"],
      shared: entities(e, "shared"),
    }).toEqual({ created: [], updated: [privateId], shared: [] });
  });

  test("a remote source ingest whose entity intake meets a private entity's alias changes nothing", async () => {
    const e = env();
    const privateId = seedPrivate(e, "Zqidentity Real Name", [NAME]);
    const before = records(e);
    const remote = await callJson(server(e), "brain_ingest_source", { agent: AGENT, ...INGEST });
    expect({
      answer: remote,
      shared: entities(e, "shared"),
      private: entities(e, "private"),
    }).toEqual({
      answer: { error: `brain_ingest_source: ${WITHHELD}` },
      shared: [],
      private: [`people/${privateId}`],
    });
    expect(records(e)).toEqual(before);
  });

  test("a remote intake of a private entity's own name changes nothing", async () => {
    const e = env();
    const privateId = seedPrivate(e, NAME, []);
    const before = records(e);
    const remote = await callJson(server(e), "brain_intake_entities", INTAKE);
    expect({
      fixed: String(remote["error"] ?? "").includes(WITHHELD),
      error: String(remote["error"] ?? ""),
      shared: entities(e, "shared"),
      private: entities(e, "private"),
    }).toEqual({
      fixed: true,
      error: `brain_intake_entities: ${WITHHELD}`,
      shared: [],
      private: [`people/${privateId}`],
    });
    expect(records(e)).toEqual(before);
  });
});
