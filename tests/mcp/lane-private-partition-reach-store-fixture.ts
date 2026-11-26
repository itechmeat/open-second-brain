/**
 * Store states for the private-partition reach tests: a fold of every
 * partition that may miss a record, and a raise of a lane entry whose
 * `shared` tombstone this machine has not read (the private record alone,
 * as a raise from another device arrives when its `private` shard comes
 * first). Every helper works on the test's own temporary store.
 */

import { rmSync } from "node:fs";
import { join } from "node:path";

import { expect } from "bun:test";

import { appendRecord } from "../../src/core/store/appender.ts";
import { foldIncomplete } from "../../src/core/store/lane-entry-store.ts";
import { laneStoreFold } from "../../src/core/store/lane-fold-cache.ts";
import { LANE_ENTRY_KIND } from "../../src/core/store/lane-records.ts";
import { listShards } from "../../src/core/store/shard-list.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import type { LaneEnv } from "../core/lanes/fixtures/lane-env.ts";

/**
 * Make the fold of every partition incomplete: after a fold has read
 * them, the `private` partition's `events` shards are gone.
 */
export function dropPrivateEvents(e: LaneEnv): void {
  laneStoreFold();
  for (const shard of listShards(join(e.env.storeRoot, "private"), { stream: "events" })) {
    rmSync(shard.path, { force: true });
  }
  expect(foldIncomplete()).toBe(true);
}

/**
 * The newest `shared` lane-entry record of `lane` whose entry's file name,
 * without its extension, is `name`, as the store holds it.
 */
export function sharedLaneRecord(e: LaneEnv, lane: string, name: string): Record<string, unknown> {
  const named = (entry: unknown) =>
    String(entry)
      .replace(/^.*\//, "")
      .replace(/\.[a-z]+$/, "") === name;
  const found = e
    .laneRecords("shared")
    .filter((r) => r.kind === LANE_ENTRY_KIND && r.body["lane"] === lane && named(r.body["entry"]))
    .at(-1);
  expect(found).toBeDefined();
  return found!.body;
}

/**
 * Append a `private` lane-entry record of the entry `body` names, with the
 * same authority and with `text` (when given) as its text, and no `shared`
 * tombstone: the entry is raised, and this machine has not read the
 * tombstone of its `shared` value yet.
 */
export function raiseWithoutTombstone(
  e: LaneEnv,
  body: Readonly<Record<string, unknown>>,
  text?: string,
): void {
  appendRecord(openStore({ root: e.env.storeRoot, device: "dev-a" }), {
    partition: "private",
    stream: "events",
    kind: LANE_ENTRY_KIND,
    agent: "o2b",
    body: { ...body, ...(text !== undefined ? { text } : {}) },
  });
}
