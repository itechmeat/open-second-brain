/**
 * A refusal below local reach comes before the call's first durable step,
 * for a source ingest (change `lane-reach-residuals`, package 6, design
 * R7): the disposition row a permissions document owes, the trusted source
 * archive and the entity pages of the extraction are all written after
 * every reach check of the ingest has passed.
 *
 * The two scenarios of the spec (a staged review entry held in `private`
 * for the ingest's target, and an extracted entity whose identity an
 * entity held in `private` claims) run through the MCP tool under a
 * permissions document that decides the ingest lane. The two further
 * orderings recorded with the package (a fold that may miss a record,
 * where the source archive was written before the summary write refused;
 * an extraction whose later entity or relation is refused after earlier
 * entities were written) run beside them. Every refused call compares the
 * raw records of both partitions before and after; each case has a local
 * control on the same kind of store.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { upsertEntity } from "../../src/core/brain/entities/registry.ts";
import { ingestSource } from "../../src/core/brain/ingest/ingest.ts";
import { queryDecisionLedger } from "../../src/core/brain/permissions/ledger.ts";
import { PERMISSIONS_DOCUMENT_SETTING } from "../../src/core/brain/permissions/document.ts";
import { setBrainSetting } from "../../src/core/brain/policy/settings-write.ts";
import { withPrivateWithheld } from "../../src/core/store/caller-reach.ts";
import { wholeLaneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import { laneEntryInPrivate, writeLanePage } from "../../src/core/store/lane-pages.ts";
import { readPartition } from "../../src/core/store/state-digest.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import { dropPrivateEvents } from "./lane-private-partition-reach-store-fixture.ts";
import {
  AGENT,
  REGION,
  callJson,
  localServer,
  server,
} from "./lane-private-partition-reach-writes-fixture.ts";

const WITHHELD = "this entry cannot be written at this reach";
const SOURCE = "Notes/zqledger-source.md";
const SOURCE_TEXT = "# Source\n\nWe will ship the report.\n";
const ASK_ALL = "version: 1\ndefault_action: ask\n";
const PRIVATE_DECISION = "Brain/decisions/zqledger-held.md";

const lanes: LaneEnv[] = [];
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
});

function env(prefix: string): LaneEnv {
  const lane = makeLaneEnv("store", `osb-lane-ingest-ledger-${prefix}-`);
  lanes.push(lane);
  mkdirSync(join(lane.vault, "Notes"), { recursive: true });
  writeFileSync(join(lane.vault, SOURCE), SOURCE_TEXT, "utf8");
  return lane;
}

/** A permissions document that stages every ingest, set by the operator. */
function askForEveryIngest(e: LaneEnv): void {
  setBrainSetting(
    { vault: e.vault, authority: "human", agent: "operator" },
    PERMISSIONS_DOCUMENT_SETTING,
    ASK_ALL,
  );
}

/** Every record of both partitions, by id, as the store holds them. */
function rawRecords(e: LaneEnv): string {
  const ids = (partition: "shared" | "private") =>
    readPartition(join(e.env.storeRoot, partition))
      .flatMap((shard) => shard.all)
      .map((r) => r.id)
      .toSorted();
  return JSON.stringify({ shared: ids("shared"), private: ids("private") });
}

/** The rows of the decision ledger, read at local reach. */
function ledgerRows(e: LaneEnv): number {
  return queryDecisionLedger(e.vault).length;
}

/** The live lane entries of `lane`, by file name, from the fold of every partition. */
function laneEntries(lane: string): string[] {
  return [...wholeLaneStoreFold().entries.values()]
    .filter((value) => value.lane === lane)
    .map((value) => value.entry.replace(/^.*\//, ""))
    .toSorted();
}

/** The live lane entry whose name (no extension) is `name`, from the fold of every partition. */
function entryOf(name: string) {
  return [...wholeLaneStoreFold().entries.values()].find((value) =>
    value.entry.endsWith(`/${name}`),
  );
}

/** An entity held in `private`: its page carries a private region. */
function seedPrivateEntity(e: LaneEnv, category: string, name: string): string {
  const res = upsertEntity(e.vault, {
    category,
    name,
    agent: AGENT,
    now: new Date(),
    body: `# ${name}\n\n${REGION}`,
  });
  expect(laneEntryInPrivate(e.vault, res.entity.path)).toBe(true);
  return res.entity.id;
}

/** A shared entity, written by another agent, so the ingest's update changes its page. */
function seedSharedEntity(e: LaneEnv, category: string, name: string): string {
  const res = upsertEntity(e.vault, {
    category,
    name,
    agent: "zqledger-seeder",
    now: new Date(),
  });
  expect(laneEntryInPrivate(e.vault, res.entity.path)).toBe(false);
  return res.entity.id;
}

/** A decision page held in `private`. */
function seedPrivateDecision(e: LaneEnv): void {
  const path = join(e.vault, PRIVATE_DECISION);
  writeLanePage(
    e.vault,
    path,
    { kind: "decision", title: "Zqledger held decision" },
    `# Zqledger held decision\n\n${REGION}`,
  );
  expect(laneEntryInPrivate(e.vault, path)).toBe(true);
}

const INGEST = {
  agent: AGENT,
  source_path: SOURCE,
  summary: "zqledger summary of the source.",
};

describe("a refused ingest leaves no disposition row", () => {
  test("a remote ingest whose staged target a private open entry holds leaves no row", async () => {
    const e = env("staged");
    askForEveryIngest(e);
    const staged = await callJson(localServer(e), "brain_ingest_source", {
      ...INGEST,
      summary: `zqledger held summary ${REGION}`,
      entities: [{ category: "concept", name: "Zqledger Staged Concept" }],
    });
    expect(staged["staged"]).toBe(true);
    const rows = ledgerRows(e);
    const before = rawRecords(e);

    const remote = await callJson(server(e), "brain_ingest_source", {
      ...INGEST,
      entities: [{ category: "concept", name: "Zqledger Staged Concept" }],
    });

    expect({ answer: remote, rows: ledgerRows(e) - rows }).toEqual({
      answer: { error: `brain_ingest_source: ${WITHHELD}` },
      rows: 0,
    });
    expect(rawRecords(e)).toEqual(before);
  });

  test("a local ingest of the same target reuses the open entry and records its row", async () => {
    const e = env("staged-local");
    askForEveryIngest(e);
    const first = await callJson(localServer(e), "brain_ingest_source", {
      ...INGEST,
      summary: `zqledger held summary ${REGION}`,
      entities: [{ category: "concept", name: "Zqledger Staged Concept" }],
    });
    const rows = ledgerRows(e);

    const local = await callJson(localServer(e), "brain_ingest_source", {
      ...INGEST,
      entities: [{ category: "concept", name: "Zqledger Staged Concept" }],
    });

    expect({
      staged: local["staged"],
      pending_id: local["pending_id"],
      rows: ledgerRows(e) - rows,
    }).toEqual({ staged: true, pending_id: first["pending_id"], rows: 1 });
  });
});

describe("an ingest whose intake meets a private entity leaves no disposition row", () => {
  test("a remote ingest writes no row, no summary and no entity page", async () => {
    const e = env("intake");
    askForEveryIngest(e);
    seedPrivateEntity(e, "people", "Zqledger Held Person");
    const rows = ledgerRows(e);
    const entitiesBefore = laneEntries("entities");
    const before = rawRecords(e);

    const remote = await callJson(server(e), "brain_ingest_source", {
      ...INGEST,
      entities: [
        { category: "concept", name: "Zqledger First Concept" },
        { category: "people", name: "Zqledger Held Person" },
      ],
    });

    expect({
      answer: remote,
      rows: ledgerRows(e) - rows,
      summaries: laneEntries("sources"),
      pending: laneEntries("pending"),
      entities: laneEntries("entities"),
    }).toEqual({
      answer: { error: `brain_ingest_source: ${WITHHELD}` },
      rows: 0,
      summaries: [],
      pending: [],
      entities: entitiesBefore,
    });
    expect(rawRecords(e)).toEqual(before);
  });

  test("a local ingest stages and records its row", async () => {
    const e = env("intake-local");
    askForEveryIngest(e);
    const held = seedPrivateEntity(e, "people", "Zqledger Held Person");
    const rows = ledgerRows(e);

    const local = await callJson(localServer(e), "brain_ingest_source", {
      ...INGEST,
      entities: [
        { category: "concept", name: "Zqledger First Concept" },
        { category: "people", name: "Zqledger Held Person" },
      ],
    });

    expect({
      error: local["error"] ?? null,
      staged: local["staged"],
      updated: local["entities_updated"],
      rows: ledgerRows(e) - rows,
    }).toEqual({ error: null, staged: true, updated: [held], rows: 1 });
  });
});

describe("an ingest on a fold that may miss a record writes no source archive", () => {
  const extraction = {
    sourcePath: SOURCE,
    summary: "zqledger summary.",
    extraction: { entities: [] },
  };

  test("a remote ingest of a new source is refused before the archive", () => {
    const e = env("incomplete");
    seedPrivateDecision(e);
    dropPrivateEvents(e);
    const before = rawRecords(e);

    let answer = "none";
    try {
      withPrivateWithheld(true, () =>
        ingestSource(e.vault, extraction, { agent: AGENT, now: new Date() }),
      );
    } catch (err) {
      answer = `${(err as Error).name}: ${(err as Error).message}`;
    }

    expect(answer).toBe(`LaneEntryWithheldError: ${WITHHELD}`);
    expect(rawRecords(e)).toEqual(before);
  });

  test("a local ingest of the same source writes the archive and the summary", () => {
    const e = env("incomplete-local");
    seedPrivateDecision(e);
    dropPrivateEvents(e);
    const res = ingestSource(e.vault, extraction, { agent: AGENT, now: new Date() });
    expect({
      created: res.created,
      archived: typeof res.sourceArchiveHash === "string",
    }).toEqual({ created: true, archived: true });
  });
});

describe("an extraction refused at a later entity or relation writes no earlier entity", () => {
  test("a remote ingest whose new entity page would name a private page writes nothing", async () => {
    const e = env("unshareable");
    seedSharedEntity(e, "concept", "Zqledger First Concept");
    seedPrivateDecision(e);
    const before = rawRecords(e);

    const remote = await callJson(server(e), "brain_ingest_source", {
      ...INGEST,
      entities: [
        { category: "concept", name: "Zqledger First Concept" },
        {
          category: "concept",
          name: "Zqledger Second Concept",
          aliases: [`[[${PRIVATE_DECISION}]]`],
        },
      ],
    });

    expect(remote).toEqual({ error: `brain_ingest_source: ${WITHHELD}` });
    expect(rawRecords(e)).toEqual(before);
  });

  test("a local ingest of the same extraction writes both entities", async () => {
    const e = env("unshareable-local");
    const first = seedSharedEntity(e, "concept", "Zqledger First Concept");
    seedPrivateDecision(e);

    const local = await callJson(localServer(e), "brain_ingest_source", {
      ...INGEST,
      entities: [
        { category: "concept", name: "Zqledger First Concept" },
        {
          category: "concept",
          name: "Zqledger Second Concept",
          aliases: [`[[${PRIVATE_DECISION}]]`],
        },
      ],
    });

    expect({
      error: local["error"] ?? null,
      updated: local["entities_updated"],
      created: local["entities_created"],
    }).toEqual({
      error: null,
      updated: [first],
      created: ["ent-concept-zqledger-second-concept"],
    });
  });

  test("a remote ingest whose relation targets a private entity outside the intake writes nothing", async () => {
    const e = env("relation");
    seedPrivateEntity(e, "people", "Zqledger Beta");
    const before = rawRecords(e);

    const remote = await callJson(server(e), "brain_ingest_source", {
      ...INGEST,
      entities: [
        { category: "concept", name: "Zqledger Alpha" },
        { category: "concept", name: "Zqledger Beta" },
      ],
      relations: [
        { from: "Zqledger Alpha", relation: "related", to: "Zqledger Beta", to_category: "people" },
      ],
    });

    expect(remote).toEqual({ error: `brain_ingest_source: ${WITHHELD}` });
    expect(rawRecords(e)).toEqual(before);
  });

  test("a local ingest of the same extraction links the private entity", async () => {
    const e = env("relation-local");
    const held = seedPrivateEntity(e, "people", "Zqledger Beta");

    const local = await callJson(localServer(e), "brain_ingest_source", {
      ...INGEST,
      entities: [
        { category: "concept", name: "Zqledger Alpha" },
        { category: "concept", name: "Zqledger Beta" },
      ],
      relations: [
        { from: "Zqledger Alpha", relation: "related", to: "Zqledger Beta", to_category: "people" },
      ],
    });

    expect({
      error: local["error"] ?? null,
      created: local["entities_created"],
      linked: JSON.stringify(entryOf("ent-concept-zqledger-alpha")?.fields ?? null).includes(held),
    }).toEqual({
      error: null,
      created: ["ent-concept-zqledger-alpha", "ent-concept-zqledger-beta"],
      linked: true,
    });
  });
});
