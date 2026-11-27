/**
 * A cleanup by source with a private member is refused whole (change
 * `lane-reach-residuals`, package 11, design R9): below local reach a
 * `brain_delete_by_source` whose derived set holds a lane entry held in
 * `private`, a derived memory record (a signal or a preference) held in
 * `private`, or a lane entry raised to `private` between the first check
 * and the write, gets the fixed answer before the first removal, and the
 * dry run of the same cleanup gives the same answer. The memory records
 * are store records, judged by the partition that holds them.
 *
 * The raise is injected as in `lane-reach-residuals-builder-race.test.ts`:
 * the first fold read made inside a store write appends the raised record
 * (the entry's own text, now held in `private`) first. Every refused call compares the raw records of both partitions
 * before and after; each case has a local control on its own store.
 */

import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { storeMemoryPageAt } from "../../src/core/brain/memory-pages.ts";
import * as foldCache from "../../src/core/store/lane-fold-cache.ts";
import { laneEntryInPrivate } from "../../src/core/store/lane-pages.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  raiseWithoutTombstone,
  sharedLaneRecord,
} from "./lane-private-partition-reach-store-fixture.ts";
import {
  AGENT,
  REGION,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

const WITHHELD = "this entry cannot be written at this reach";
const SOURCE = "Notes/zqclean-source.md";
const ENTITY = "Brain/entities/concept/ent-concept-zqclean-concept.md";

const lanes: LaneEnv[] = [];
let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  for (const lane of lanes.splice(0)) lane.cleanup();
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

type Seed = "private-summary" | "private-signal" | "private-preference" | "shared";

/** A store whose source has a summary, an entity and the memory records `seed` asks for. */
async function seeded(seed: Seed): Promise<LaneEnv> {
  const e = makeLaneEnv("store", `osb-lane-cleanup-members-${seed}-`);
  lanes.push(e);
  mkdirSync(join(e.vault, "Notes"), { recursive: true });
  writeFileSync(join(e.vault, SOURCE), "# Source\n\nWe will ship the report.\n", "utf8");
  const local = localServer(e);
  const ingest = await callJson(local, "brain_ingest_source", {
    agent: AGENT,
    source_path: SOURCE,
    summary: seed === "private-summary" ? `zqclean summary ${REGION}` : "zqclean summary",
    entities: [{ category: "concept", name: "Zqclean Concept" }],
  });
  expect(ingest["error"]).toBeUndefined();
  if (seed === "private-signal" || seed === "private-preference") {
    const feedback = await callJson(local, "brain_feedback", {
      agent: AGENT,
      topic: `zqclean-${seed}`,
      signal: "positive",
      principle: "Prefer the zqclean way",
      raw: `zqclean quote ${REGION}`,
      source: [`[[${SOURCE}]]`],
      ...(seed === "private-preference" ? { force_confirmed: true } : {}),
    });
    expect(feedback["error"]).toBeUndefined();
  }
  return e;
}

/** The derived paths of a local dry run, and which of them the store holds in `private`. */
async function derivedOf(e: LaneEnv): Promise<{ all: string[]; held: string[] }> {
  const dry = await callJson(localServer(e), "brain_delete_by_source", { source_file: SOURCE });
  expect(dry["error"]).toBeUndefined();
  const all = (dry["derived"] as ReadonlyArray<{ path: string }>).map((entry) => entry.path);
  const held = all.filter(
    (path) =>
      storeMemoryPageAt(e.vault, path)?.private === true ||
      laneEntryInPrivate(e.vault, join(e.vault, path)),
  );
  return { all, held };
}

const PRIVATE_MEMBERS: ReadonlyArray<{ readonly seed: Seed; readonly heldKind: RegExp }> = [
  { seed: "private-summary", heldKind: /^Brain\/sources\// },
  { seed: "private-signal", heldKind: /^Brain\/inbox\// },
  { seed: "private-preference", heldKind: /^Brain\/preferences\// },
];

describe("a cleanup by source with a member held in private", () => {
  for (const { seed, heldKind } of PRIVATE_MEMBERS) {
    test(`${seed}: a remote confirmed cleanup is refused and removes nothing`, async () => {
      const e = await seeded(seed);
      const { held } = await derivedOf(e);
      expect(held.some((path) => heldKind.test(path))).toBe(true);
      const before = rawRecords(e);

      const remote = await callJson(server(e), "brain_delete_by_source", {
        source_file: SOURCE,
        confirm: true,
      });

      expect(remote).toEqual({ error: WITHHELD });
      expect(rawRecords(e)).toEqual(before);
    });

    test(`${seed}: a remote dry run gives the same answer`, async () => {
      const e = await seeded(seed);
      const before = rawRecords(e);
      const remote = await callJson(server(e), "brain_delete_by_source", { source_file: SOURCE });
      expect(remote).toEqual({ error: WITHHELD });
      expect(rawRecords(e)).toEqual(before);
    });

    test(`${seed}: a local dry run and a local confirmed cleanup cover every member`, async () => {
      const e = await seeded(seed);
      const { all } = await derivedOf(e);
      const local = await callJson(localServer(e), "brain_delete_by_source", {
        source_file: SOURCE,
        confirm: true,
      });
      expect({ error: local["error"] ?? null, deleted: local["deleted"] }).toEqual({
        error: null,
        deleted: all,
      });
    });
  }
});

/**
 * Install the race: the first fold read made inside a store write raises
 * the entity of the source to `private` first. Returns the state of the
 * race: whether it fired, and the raw records right after the raise.
 */
function raceOnEntity(e: LaneEnv): { fired: boolean; afterRaise: string } {
  const body = sharedLaneRecord(e, "entities", "ent-concept-zqclean-concept");
  const state = { fired: false, afterRaise: "" };
  const original = foldCache.wholeLaneStoreFold;
  const spy = spyOn(foldCache, "wholeLaneStoreFold").mockImplementation((...args) => {
    if (!state.fired && (new Error().stack ?? "").includes("storeWrite")) {
      state.fired = true;
      raiseWithoutTombstone(e, body);
      state.afterRaise = rawRecords(e);
    }
    return original(...args);
  });
  restore = () => spy.mockRestore();
  return state;
}

describe("a cleanup by source whose member is raised to private before the write", () => {
  test("a remote confirmed cleanup is refused before the first removal", async () => {
    const e = await seeded("shared");
    const { all, held } = await derivedOf(e);
    expect({ entity: all.includes(ENTITY), held }).toEqual({ entity: true, held: [] });
    const race = raceOnEntity(e);

    const remote = await callJson(server(e), "brain_delete_by_source", {
      source_file: SOURCE,
      confirm: true,
    });
    restore?.();
    restore = null;

    expect(race.fired).toBe(true);
    expect(remote).toEqual({ error: WITHHELD });
    expect(rawRecords(e)).toEqual(race.afterRaise);
    expect(laneEntryInPrivate(e.vault, join(e.vault, ENTITY))).toBe(true);
  });

  test("a remote dry run on the raised member gives the same answer", async () => {
    const e = await seeded("shared");
    raiseWithoutTombstone(e, sharedLaneRecord(e, "entities", "ent-concept-zqclean-concept"));
    expect(laneEntryInPrivate(e.vault, join(e.vault, ENTITY))).toBe(true);
    const before = rawRecords(e);
    const remote = await callJson(server(e), "brain_delete_by_source", { source_file: SOURCE });
    expect(remote).toEqual({ error: WITHHELD });
    expect(rawRecords(e)).toEqual(before);
  });

  test("a local confirmed cleanup with the same raise removes every member", async () => {
    const e = await seeded("shared");
    const { all } = await derivedOf(e);
    const race = raceOnEntity(e);
    const local = await callJson(localServer(e), "brain_delete_by_source", {
      source_file: SOURCE,
      confirm: true,
    });
    restore?.();
    restore = null;
    expect(race.fired).toBe(true);
    expect({ error: local["error"] ?? null, deleted: local["deleted"] }).toEqual({
      error: null,
      deleted: all,
    });
  });
});
