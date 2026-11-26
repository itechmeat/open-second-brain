/**
 * A write decision taken from the narrowed view (prove-labels): a
 * `brain_labels assign` below local reach whose label name a private
 * label entity already answers to, by its name or by an alias (claim 3).
 *
 * Each test seeds the private label entity with the registry's own
 * writer, records every lane record of the store and the note's bytes,
 * makes the remote call, and compares: the refusal carries the tool's
 * name. The same call through a local server on a twin store is the
 * control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { LABEL_ENTITY_CATEGORY, readLabels } from "../../src/core/brain/labels.ts";
import {
  loadSchemaPack,
  readStoreSchemaPack,
  renderSchemaBlock,
} from "../../src/core/brain/schema-pack.ts";
import { writeSchemaPackToStore } from "../../src/core/brain/schema-pack-store.ts";
import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { wholeLaneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import { laneEntryInPrivate } from "../../src/core/store/lane-pages.ts";
import { parseFrontmatter } from "../../src/core/vault.ts";
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
const NOTE = "Notes/zqprove-note.md";
const NOTE_TEXT = "---\ntitle: Zqprove note\n---\n\nzqprove note body\n";
const LABEL = "status/draft";
const ASSIGN = { operation: "assign", path: NOTE, dimension: "status", value: "draft" };

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function env(): LaneEnv {
  const lane = makeLaneEnv("store", "osb-lane-prove-labels-");
  lanes.push(lane);
  mkdirSync(join(lane.vault, "Notes"), { recursive: true });
  writeFileSync(join(lane.vault, NOTE), NOTE_TEXT, "utf8");
  const current = readStoreSchemaPack(lane.env.configPath);
  writeSchemaPackToStore(
    { vault: lane.vault, authority: "human", agent: AGENT, configPath: lane.env.configPath },
    ["schema:", "  labels:", "    - status=draft", "    - status=final", "  {}"].join("\n") + "\n",
    renderSchemaBlock(current.source.pack),
    current,
  );
  expect(Object.keys(loadSchemaPack(lane.vault).labels)).toEqual(["status"]);
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

/** The live label entities in `partition`, as `label/id`, from the fold of every partition. */
function labels(e: LaneEnv, partition: "shared" | "private"): string[] {
  const fold = wholeLaneStoreFold();
  return [...fold.entries]
    .filter(
      ([key, value]) =>
        value.lane === "entities" && fold.privateKeys.has(key) === (partition === "private"),
    )
    .map(([, value]) => `${String(value.fields["category"])}/${String(value.fields["entity_id"])}`)
    .toSorted();
}

/** A private label entity called `name`, with `aliases`, through the registry's writer. */
function seedPrivate(e: LaneEnv, name: string, aliases: string[]): string {
  const { entity } = upsertEntity(e.vault, {
    category: LABEL_ENTITY_CATEGORY,
    name,
    aliases,
    agent: AGENT,
    now: NOW,
    body: `zqprove notes ${REGION}\n`,
  });
  expect(laneEntryInPrivate(e.vault, entity.path)).toBe(true);
  return entity.id;
}

describe("an assign that meets a private label entity", () => {
  test("a remote assign that meets a private label entity for the token writes nothing", async () => {
    const e = env();
    const privateId = seedPrivate(e, LABEL, []);
    const before = records(e);

    const remote = await callJson(server(e), "brain_labels", ASSIGN);

    expect({
      answer: remote,
      shared: labels(e, "shared"),
      private: labels(e, "private"),
      note: readFileSync(join(e.vault, NOTE), "utf8"),
      same: records(e).length === before.length,
    }).toEqual({
      answer: { error: WITHHELD },
      shared: [],
      private: [`label/${privateId}`],
      note: NOTE_TEXT,
      same: true,
    });
    expect(records(e)).toEqual(before);
  });

  test("a remote assign that meets a private label entity through an alias writes nothing", async () => {
    const e = env();
    const privateId = seedPrivate(e, "Zqprove Held Label", [LABEL]);
    const before = records(e);

    const remote = await callJson(server(e), "brain_labels", ASSIGN);

    expect({
      answer: remote,
      shared: labels(e, "shared"),
      private: labels(e, "private"),
      note: readFileSync(join(e.vault, NOTE), "utf8"),
    }).toEqual({
      answer: { error: WITHHELD },
      shared: [],
      private: [`label/${privateId}`],
      note: NOTE_TEXT,
    });
    expect(records(e)).toEqual(before);
  });

  test("a local assign updates the private label entity and labels the note", async () => {
    const e = env();
    const privateId = seedPrivate(e, LABEL, []);
    const local = await callJson(localServer(e), "brain_labels", ASSIGN);
    expect(local["error"]).toBeUndefined();
    expect({
      shared: labels(e, "shared"),
      private: labels(e, "private"),
      note_labels: readLabels(parseFrontmatter(join(e.vault, NOTE))[0]),
    }).toEqual({
      shared: [],
      private: [`label/${privateId}`],
      note_labels: ["status/draft"],
    });
  });
});
