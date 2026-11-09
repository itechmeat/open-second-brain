/**
 * A shard read only in part (design D14 fail closed): a record whose body
 * blob has not arrived, or a bad line in the middle, is named by the
 * stream reader and the partition reader as unseen, with the shard's
 * readable records still returned. A line torn by a crash and closed by
 * the next append, and a last line still arriving, are not gaps.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import { readStreamRecords } from "../../../src/core/store/read/stream-read.ts";
import { readShard, shardReadGap } from "../../../src/core/store/reader.ts";
import { readPartition, type UnreadableShard } from "../../../src/core/store/state-digest.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { partitionDir } from "../../../src/core/store/store-paths.ts";
import { isTornObjectPrefix } from "../../../src/core/store/torn-line.ts";
import { makeStoreEnv, type StoreEnv } from "./fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const NOV = Date.UTC(2026, 10, 6, 9);

function note(e: StoreEnv, body: Record<string, unknown>): string {
  return appendRecord(
    openStore({ root: e.storeRoot, device: "dev-b" }),
    { partition: "shared", stream: "events", kind: "note", agent: "t", body },
    { now: () => NOV },
  ).path;
}

const events = (e: StoreEnv) => readStreamRecords(e.storeRoot, "shared", { stream: "events" });

function partitionCalls(e: StoreEnv): { calls: UnreadableShard[]; shards: string[] } {
  const calls: UnreadableShard[] = [];
  const shards = readPartition(partitionDir(e.storeRoot, "shared"), {
    onUnreadable: (s) => calls.push(s),
  }).map((s) => s.rel);
  return { calls, shards };
}

/** Three notes in one shard, the middle one rewritten by `edit`. */
function shardWithMiddle(e: StoreEnv, edit: (line: string) => string): string {
  note(e, { n: 1 });
  note(e, { n: 2 });
  const path = note(e, { n: 3 });
  const lines = readFileSync(path, "utf8").split("\n");
  lines[1] = edit(lines[1]!);
  writeFileSync(path, lines.join("\n"));
  return path;
}

describe("a shard read only in part", () => {
  test("a bad line in the middle: both readers name the shard and keep its other records", () => {
    env = makeStoreEnv("osb-gap-corrupt-", { legacyTree: false });
    shardWithMiddle(env, (line) => line.replace('"n":2', '"n":20'));
    const read = events(env);
    expect(read.unreadable).toEqual(["events/dev-b/2026-11.jsonl"]);
    expect(read.records.map((r) => r.body["n"])).toEqual([1, 3]);
    const { calls, shards } = partitionCalls(env);
    expect(calls.map((c) => [c.rel, c.incomplete])).toEqual([["events/dev-b/2026-11.jsonl", true]]);
    expect(String(calls[0]!.error)).toContain("corrupt-line");
    expect(shards).toContain("events/dev-b/2026-11.jsonl");
  });

  test("a record whose body blob has not arrived: named until the blob is there", () => {
    env = makeStoreEnv("osb-gap-pending-", { legacyTree: false });
    note(env, { n: 1 });
    note(env, { n: 2, text: "x".repeat(20_000) });
    const blobs = join(partitionDir(env.storeRoot, "shared"), "blobs");
    const kept = join(env.storeRoot, "..", "blobs-aside");
    // The blob directory moves away and back: the shard itself never changes.
    rmSync(kept, { recursive: true, force: true });
    renameSync(blobs, kept);
    const read = events(env);
    expect(read.unreadable).toEqual(["events/dev-b/2026-11.jsonl"]);
    expect(read.records.map((r) => r.body["n"])).toEqual([1]);
    expect(String(partitionCalls(env).calls[0]?.error)).toContain("has not arrived");
    renameSync(kept, blobs);
    expect(events(env).unreadable).toEqual([]);
    expect(partitionCalls(env).calls).toEqual([]);
  });

  test("a line torn by a crash and closed by the next append is no gap", () => {
    env = makeStoreEnv("osb-gap-torn-", { legacyTree: false });
    shardWithMiddle(env, (line) => line.slice(0, Math.floor(line.length / 2)));
    const read = events(env);
    expect(read.unreadable).toEqual([]);
    expect(read.records.map((r) => r.body["n"])).toEqual([1, 3]);
    expect(partitionCalls(env).calls).toEqual([]);
  });

  test("a last line still arriving is held back, not a gap", () => {
    env = makeStoreEnv("osb-gap-tail-", { legacyTree: false });
    const path = note(env, { n: 1 });
    writeFileSync(path, `${readFileSync(path, "utf8")}{"v":1,"id":"01J`, { flag: "w" });
    const read = readShard(path, { partitionRoot: partitionDir(env.storeRoot, "shared") });
    expect(read.pendingTailBytes).toBeGreaterThan(0);
    expect(shardReadGap(read)).toBeNull();
    expect(events(env).unreadable).toEqual([]);
  });
});

describe("isTornObjectPrefix", () => {
  test("an object cut short anywhere is torn", () => {
    const line = JSON.stringify({ v: 1, id: "a", n: -1.5e3, ok: true, x: null, l: [1, "é\\"] });
    for (let cut = 1; cut < line.length; cut += 1) {
      expect(isTornObjectPrefix(line.slice(0, cut))).toBe(true);
    }
  });

  test("complete JSON, a broken grammar or no object is not", () => {
    for (const text of [
      '{"a":1}',
      '{"a";1',
      '{"a":1}}',
      '{"a":tru,',
      '{"a":01x',
      '["a"',
      "not json",
      "",
      '{"a":"\u0001',
    ]) {
      expect(isTornObjectPrefix(text)).toBe(false);
    }
  });
});
