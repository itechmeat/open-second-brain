/**
 * A write decision taken from the narrowed view (prove-staging): a
 * `create_note` item of `brain_write_batch`, and the apply of a
 * `brain_scaffold_stub` write, below local reach whose target a private
 * open entry already holds, dated another day (claim 5).
 *
 * Each test seeds the private open entry through the local server (then
 * files it under another day's id, as a queue written on an earlier day
 * holds it), records every lane record of the store, makes the remote
 * call, and compares. The same call through a local server on a twin
 * store is the control.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { pendingLaneDir } from "../../src/core/brain/pending/pending-lanes.ts";
import { wholeLaneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import { laneEntryInPrivate, moveLanePage } from "../../src/core/store/lane-pages.ts";
import { makeLaneEnv, type LaneEnv } from "../core/lanes/fixtures/lane-env.ts";
import {
  callJson,
  localServer,
  server,
  REGION,
} from "./lane-private-partition-reach-writes-fixture.ts";

const WITHHELD = "this entry cannot be written at this reach";
const OTHER_DAY = "2026-11-01";
const NOTE_PATH = "Notes/zqprove-staged.md";
const NOTE_CONTENT = "zqprove note body";
const TARGET = "zqprove-staged";
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
  const lane = makeLaneEnv("store", "osb-lane-prove-staging-");
  lanes.push(lane);
  mkdirSync(join(lane.vault, "Notes"), { recursive: true });
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

/** The live pending note entries in `partition`, by file name, from the fold of every partition. */
function pendingNotes(e: LaneEnv, partition: "shared" | "private"): string[] {
  const dir = "pending/notes/";
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

/** A private open entry for `NOTE_PATH` dated another day; its id. */
async function seedOtherDay(e: LaneEnv): Promise<string> {
  const staged = await callJson(localServer(e), "brain_create_note", {
    path: NOTE_PATH,
    content: `${NOTE_CONTENT} ${REGION}`,
  });
  expect(staged["staged"]).toBe(true);
  const [name] = pendingNotes(e, "private");
  expect(name).toBeDefined();
  const today = new Date().toISOString().slice(0, 10);
  expect(String(name).startsWith(`note-${today}-`)).toBe(true);
  const other = String(name).replace(today, OTHER_DAY);
  const dir = pendingLaneDir(e.vault, "notes");
  moveLanePage(e.vault, join(dir, `${name}.md`), join(dir, `${other}.md`));
  expect(laneEntryInPrivate(e.vault, join(dir, `${other}.md`))).toBe(true);
  expect(pendingNotes(e, "shared")).toEqual([]);
  return other;
}

describe("a batch create and a stub apply that meet a private open entry", () => {
  test("a remote write batch with a create_note item that meets a private open entry writes nothing", async () => {
    const e = env();
    const existing = await seedOtherDay(e);
    const before = records(e);

    const remote = await callJson(server(e), "brain_write_batch", {
      operations: [{ op: "create_note", path: NOTE_PATH, content: NOTE_CONTENT }],
    });

    expect({
      error: remote["error"] ?? null,
      names_existing: JSON.stringify(remote).includes(existing),
      shared: pendingNotes(e, "shared"),
      private: pendingNotes(e, "private"),
      note_on_disk: existsSync(join(e.vault, NOTE_PATH)),
    }).toEqual({
      error: expect.stringContaining(WITHHELD) as unknown as string,
      names_existing: false,
      shared: [],
      private: [existing],
      note_on_disk: false,
    });
    expect(records(e)).toEqual(before);
  });

  test("a remote scaffold stub apply that meets a private open entry writes nothing", async () => {
    const e = env();
    const existing = await seedOtherDay(e);
    const before = records(e);

    const remote = await callJson(server(e), "brain_scaffold_stub", {
      action: "write",
      target: TARGET,
      path: NOTE_PATH,
      apply: true,
    });

    expect({
      error: remote["error"] ?? null,
      names_existing: JSON.stringify(remote).includes(existing),
      shared: pendingNotes(e, "shared"),
      private: pendingNotes(e, "private"),
    }).toEqual({
      error: expect.stringContaining(WITHHELD) as unknown as string,
      names_existing: false,
      shared: [],
      private: [existing],
    });
    expect(records(e)).toEqual(before);
  });

  test("a local write batch with the same create_note item is refused as a staged-target conflict", async () => {
    const e = env();
    const existing = await seedOtherDay(e);
    const before = records(e);
    const local = await callJson(localServer(e), "brain_write_batch", {
      operations: [{ op: "create_note", path: NOTE_PATH, content: NOTE_CONTENT }],
    });
    const error = String(local["error"] ?? "");
    expect({
      error,
      shared: pendingNotes(e, "shared"),
    }).toEqual({
      error: expect.stringContaining(existing) as unknown as string,
      shared: [],
    });
    expect(records(e)).toEqual(before);
  });
});
