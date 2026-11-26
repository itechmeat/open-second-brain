/**
 * A write decision taken from the narrowed view (identity-staging): a
 * staged first publish whose publish target a private open entry already
 * holds, dated another day.
 *
 * The review queue decides "an open entry already holds this target" from
 * the caller's fold, which below local reach hides the `private`
 * partition. Each test seeds the private open entry through the local
 * server (then files it under another day's id, as a queue written on an
 * earlier day holds it), records every lane record of the store, makes the
 * remote call, and compares. The same call through a local server on a
 * twin store is the control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { pendingLaneDir } from "../../src/core/brain/pending/pending-lanes.ts";
import { wholeLaneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import { laneEntryInPrivate, moveLanePage } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  callJson,
  localServer,
  server,
  AGENT,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";

const WITHHELD = "this entry cannot be written at this reach";
const OTHER_DAY = "2026-11-01";
const SOURCE = "Notes/zqidentity-source.md";
const SOURCE_TEXT = "# Source\n\nWe will ship the report.\n";
const NOTE_PATH = "Notes/zqidentity-staged.md";
const ENV_KEYS = [
  "OPEN_SECOND_BRAIN_WRITE_APPROVAL_NOTES_ENABLED",
  "OPEN_SECOND_BRAIN_WRITE_APPROVAL_INGEST_ENABLED",
] as const;

const lanes: LaneEnv[] = [];
const savedEnv = new Map<string, string | undefined>();
afterEach(() => {
  for (const lane of lanes.splice(0)) lane.cleanup();
  for (const key of ENV_KEYS) {
    const value = savedEnv.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function env(): LaneEnv {
  for (const key of ENV_KEYS) {
    if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
    process.env[key] = "true";
  }
  const lane = makeLaneEnv("store", "osb-lane-identity-staging-");
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

/** The live pending entries of `lane` in `partition`, by file name, from the fold of every partition. */
function pendingEntries(
  lane: LaneEnv,
  pendingLane: "notes" | "ingest",
  partition: "shared" | "private",
) {
  const dir = `pending/${pendingLane}/`;
  const fold = wholeLaneStoreFold();
  return [...fold.entries]
    .filter(
      ([key, value]) =>
        (key.includes(dir) || value.entry.includes(dir)) &&
        fold.privateKeys.has(key) === (partition === "private"),
    )
    .map(([, value]) => value.entry.replace(/^.*\//, ""))
    .toSorted();
}

/** The one private pending entry of `lane`, re-filed under another day's id; its id. */
function refileOtherDay(e: LaneEnv, pendingLane: "notes" | "ingest", prefix: string): string {
  // The fold names an entry without its extension.
  const [name] = pendingEntries(e, pendingLane, "private");
  expect(name).toBeDefined();
  const today = new Date().toISOString().slice(0, 10);
  expect(name).toContain(today);
  const other = String(name).replace(today, OTHER_DAY);
  expect(String(name).startsWith(prefix)).toBe(true);
  const dir = pendingLaneDir(e.vault, pendingLane);
  moveLanePage(e.vault, join(dir, `${name}.md`), join(dir, `${other}.md`));
  expect(laneEntryInPrivate(e.vault, join(dir, `${other}.md`))).toBe(true);
  expect(pendingEntries(e, pendingLane, "shared")).toEqual([]);
  return other;
}

describe("a staged first publish whose target a private open entry holds", () => {
  test("a remote note create that meets a private open entry for its target changes nothing", async () => {
    const e = env();
    const staged = await callJson(localServer(e), "brain_create_note", {
      path: NOTE_PATH,
      content: `zqidentity note body ${REGION}`,
    });
    expect(staged["staged"]).toBe(true);
    refileOtherDay(e, "notes", "note-");
    const before = records(e);
    const remote = await callJson(server(e), "brain_create_note", {
      path: NOTE_PATH,
      content: "zqidentity note body",
    });
    expect({ answer: remote, shared: pendingEntries(e, "notes", "shared") }).toEqual({
      answer: { error: WITHHELD },
      shared: [],
    });
    expect(records(e)).toEqual(before);
  });

  test("a local note create for the same target is refused as a staged-target conflict", async () => {
    const e = env();
    await callJson(localServer(e), "brain_create_note", {
      path: NOTE_PATH,
      content: `zqidentity note body ${REGION}`,
    });
    const existing = refileOtherDay(e, "notes", "note-");
    const before = records(e);
    const local = await callJson(localServer(e), "brain_create_note", {
      path: NOTE_PATH,
      content: "zqidentity note body",
    });
    const error = String(local["error"] ?? "");
    expect({
      conflict: /already staged|staged-target|pending/iu.test(error),
      names_existing: JSON.stringify(local).includes(existing),
      shared: pendingEntries(e, "notes", "shared"),
    }).toEqual({ conflict: true, names_existing: true, shared: [] });
    expect(records(e)).toEqual(before);
  });

  test("a remote source ingest that meets a private open entry for its summary changes nothing", async () => {
    const e = env();
    const args = {
      agent: AGENT,
      source_path: SOURCE,
      summary: "zqidentity summary of the source.",
      entities: [{ category: "concept", name: "Zqidentity Concept" }],
    };
    const staged = await callJson(localServer(e), "brain_ingest_source", {
      ...args,
      summary: `zqidentity summary of the source. ${REGION}`,
    });
    expect(staged["staged"]).toBe(true);
    refileOtherDay(e, "ingest", "ing-");
    const before = records(e);
    const remote = await callJson(server(e), "brain_ingest_source", args);
    expect({ answer: remote, shared: pendingEntries(e, "ingest", "shared") }).toEqual({
      answer: { error: `brain_ingest_source: ${WITHHELD}` },
      shared: [],
    });
    expect(records(e)).toEqual(before);
  });

  test("a local source ingest for the same summary reuses the open entry", async () => {
    const e = env();
    const args = {
      agent: AGENT,
      source_path: SOURCE,
      summary: "zqidentity summary of the source.",
      entities: [{ category: "concept", name: "Zqidentity Concept" }],
    };
    await callJson(localServer(e), "brain_ingest_source", {
      ...args,
      summary: `zqidentity summary of the source. ${REGION}`,
    });
    const existing = refileOtherDay(e, "ingest", "ing-");
    const local = await callJson(localServer(e), "brain_ingest_source", args);
    expect({
      staged: local["staged"],
      pending_id: local["pending_id"],
      shared: pendingEntries(e, "ingest", "shared"),
      private: pendingEntries(e, "ingest", "private").length,
    }).toEqual({ staged: true, pending_id: existing, shared: [], private: 1 });
  });
});
