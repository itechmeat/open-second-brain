/**
 * Reading the store from recorded positions (dream replay design D3, "The
 * read path this needs"): `readShardsFrom` gives only what lies after a
 * position and the new position, holds back a last line still arriving
 * without calling it a gap, keeps the position of a shard with a gap,
 * checks the recorded prefix digest, and reports a shard a compaction
 * replaced or that disappeared.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import { COMPACTED_KIND } from "../../../src/core/store/constants.ts";
import {
  readShardsFrom,
  shardPrefixDigest,
  type ShardFrom,
  type ShardPosition,
} from "../../../src/core/store/read/shards-from.ts";
import * as streamRead from "../../../src/core/store/read/stream-read.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { partitionDir } from "../../../src/core/store/store-paths.ts";
import { makeStoreEnv, type StoreEnv } from "./fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const NOV = Date.UTC(2026, 10, 6, 9);
const SHARD = "events/dev-b/2026-11.jsonl";

function note(e: StoreEnv, body: Record<string, unknown>, device = "dev-b"): string {
  return appendRecord(
    openStore({ root: e.storeRoot, device }),
    { partition: "shared", stream: "events", kind: "note", agent: "t", body },
    { now: () => NOV },
  ).path;
}

function read(e: StoreEnv, positions: ReadonlyArray<ShardPosition> = []): ShardFrom[] {
  return [
    ...readShardsFrom({
      root: e.storeRoot,
      partitions: ["shared"],
      streams: [{ stream: "events" }],
      positions,
    }).shards,
  ];
}

function only(shards: ShardFrom[], shard = SHARD): ShardFrom {
  const found = shards.filter((s) => s.shard === shard);
  expect(found).toHaveLength(1);
  return found[0]!;
}

const original = streamRead.hashRange;
const ns = (s: ShardFrom) => s.records.map((r) => r.body["n"]);
const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

describe("readShardsFrom", () => {
  test("returns only the records after a position, and the new position", () => {
    env = makeStoreEnv("osb-from-after-", { legacyTree: false });
    note(env, { n: 1 });
    const path = note(env, { n: 2 });
    const first = only(read(env));
    expect(first.status).toBe("read");
    expect(ns(first)).toEqual([1, 2]);
    const bytes = readFileSync(path);
    expect(first.position).toEqual({
      partition: "shared",
      stream: "events",
      device: "dev-b",
      shard: SHARD,
      offset: bytes.length,
      prefix_hash: sha(bytes),
    });
    expect(shardPrefixDigest(path, partitionDir(env.storeRoot, "shared"), bytes.length)).toBe(
      sha(bytes),
    );
    note(env, { n: 3 });
    const second = only(read(env, [first.position]));
    expect(second.status).toBe("read");
    expect(ns(second)).toEqual([3]);
    expect(second.position.offset).toBe(readFileSync(path).length);
    // Nothing new: nothing returned, the position stays.
    const third = only(read(env, [second.position]));
    expect(ns(third)).toEqual([]);
    expect(third.position).toEqual(second.position);
  });

  test("a last line still arriving is held back and is not a gap", () => {
    env = makeStoreEnv("osb-from-tail-", { legacyTree: false });
    const path = note(env, { n: 1 });
    const whole = readFileSync(path).length;
    appendFileSync(path, '{"v":1,"id":"01J');
    const shard = only(read(env));
    expect(shard.status).toBe("read");
    expect(shard.gap).toBeNull();
    expect(ns(shard)).toEqual([1]);
    expect(shard.position.offset).toBe(whole);
  });

  test("a corrupt line in the middle is a gap and keeps the position", () => {
    env = makeStoreEnv("osb-from-corrupt-", { legacyTree: false });
    const path = note(env, { n: 1 });
    const start = only(read(env)).position;
    note(env, { n: 2 });
    note(env, { n: 3 });
    const lines = readFileSync(path, "utf8").split("\n");
    lines[1] = lines[1]!.replace('"n":2', '"n":20');
    writeFileSync(path, lines.join("\n"));
    const shard = only(read(env, [start]));
    expect(shard.status).toBe("gap");
    expect(shard.gap).toContain("corrupt-line");
    expect(shard.records).toEqual([]);
    expect(shard.position).toEqual(start);
  });

  test("a record whose body blob has not arrived is a gap and keeps the position", () => {
    env = makeStoreEnv("osb-from-pending-", { legacyTree: false });
    note(env, { n: 1 });
    const start = only(read(env)).position;
    note(env, { n: 2, text: "x".repeat(20_000) });
    const blobs = join(partitionDir(env.storeRoot, "shared"), "blobs");
    const aside = join(env.parent, "blobs-aside");
    renameSync(blobs, aside);
    const shard = only(read(env, [start]));
    expect(shard.status).toBe("gap");
    expect(shard.gap).toContain("has not arrived");
    expect(shard.position).toEqual(start);
    renameSync(aside, blobs);
    const after = only(read(env, [start]));
    expect(after.status).toBe("read");
    expect(ns(after)).toEqual([2]);
  });

  test("a stored prefix digest that matches passes, one that does not is reported", () => {
    env = makeStoreEnv("osb-from-prefix-", { legacyTree: false });
    const path = note(env, { n: 1 });
    note(env, { n: 2 });
    const start = only(read(env)).position;
    note(env, { n: 3 });
    expect(only(read(env, [start])).status).toBe("read");
    // A wrong digest: the shard is read whole and its position is its end.
    const forged = { ...start, prefix_hash: sha("something else") };
    const mismatch = only(read(env, [forged]));
    expect(mismatch.status).toBe("mismatch");
    expect(ns(mismatch)).toEqual([1, 2, 3]);
    expect(mismatch.position.offset).toBe(readFileSync(path).length);
    expect(mismatch.position.prefix_hash).toBe(sha(readFileSync(path)));
    // A shard now shorter than the recorded offset.
    const past = { ...start, offset: readFileSync(path).length + 10 };
    expect(only(read(env, [past])).status).toBe("mismatch");
  });

  test("a prefix whose read is refused once is a gap that keeps the position, not a rewrite", () => {
    env = makeStoreEnv("osb-from-refused-", { legacyTree: false });
    note(env, { n: 1 });
    note(env, { n: 2 });
    const start = only(read(env)).position;
    note(env, { n: 3 });
    // A refusal the next open does not meet (a sharing lock, a file limit):
    // the first hash of the prefix reads nothing, the scan after it reads.
    let calls = 0;
    const spy = spyOn(streamRead, "hashRange").mockImplementation((...args) => {
      calls += 1;
      const result = original(...args);
      return calls === 1 ? null : result;
    });
    let refused: ShardFrom;
    try {
      refused = only(read(env, [start]));
    } finally {
      spy.mockRestore();
    }
    expect(refused.status).toBe("gap");
    expect(refused.records).toEqual([]);
    expect(refused.position).toEqual(start);
    // Read again, the shard is admitted from its position.
    expect(ns(only(read(env, [start])))).toEqual([3]);
  });

  test("a shard named in a compacted record is reported as replaced", () => {
    env = makeStoreEnv("osb-from-replaced-", { legacyTree: false });
    note(env, { n: 1 });
    const start = only(read(env)).position;
    const into = "events/dev-c/2026-11.c1.jsonl";
    appendRecord(
      openStore({ root: env.storeRoot, device: "dev-c" }),
      {
        partition: "shared",
        stream: "events",
        kind: COMPACTED_KIND,
        agent: "t",
        body: { replaces: [SHARD], into: [into] },
      },
      { now: () => NOV },
    );
    const still = only(read(env, [start]));
    expect(still.status).toBe("replaced");
    expect(still.into).toEqual([into]);
    // Gone from the listing, the compaction still names it.
    rmSync(join(partitionDir(env.storeRoot, "shared"), ...SHARD.split("/")));
    const gone = only(read(env, [start]));
    expect(gone.status).toBe("replaced");
    expect(gone.position).toEqual(start);
  });

  test("a positioned shard that disappeared with no compaction is missing", () => {
    env = makeStoreEnv("osb-from-missing-", { legacyTree: false });
    const path = note(env, { n: 1 });
    const start = only(read(env)).position;
    rmSync(path);
    const shard = only(read(env, [start]));
    expect(shard.status).toBe("missing");
    expect(shard.position).toEqual(start);
  });
});
