/**
 * A stream read through kept tails (`stream-read.ts` `ShardTails`) parses
 * only what was appended since the last read: an unchanged shard is not
 * read at all, an appended one from where the last read ended, and a shard
 * the stamp and the checksum of what was read cannot prove unchanged (a
 * rewritten prefix, a shorter file, another inode) is read whole.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, renameSync, truncateSync, writeFileSync } from "node:fs";

import { appendRecords } from "../../../src/core/store/appender.ts";
import * as reader from "../../../src/core/store/reader.ts";
import { readStreamRecords, type ShardTails } from "../../../src/core/store/read/stream-read.ts";
import { openStore, type StoreHandle } from "../../../src/core/store/store-open.ts";
import { makeTestStore, type TestStore } from "../../helpers/test-store.ts";

const NOW = Date.UTC(2026, 10, 20);
let scratch: TestStore | null = null;
afterEach(() => {
  scratch?.cleanup();
  scratch = null;
});

function store(): StoreHandle {
  scratch = makeTestStore("osb-stream-tails-");
  return openStore({ root: scratch.root, device: "dev-a" });
}

function append(s: StoreHandle, from: number, count: number): string {
  const results = appendRecords(
    s,
    Array.from({ length: count }, (_, i) => ({
      partition: "shared" as const,
      stream: "events" as const,
      kind: "note",
      agent: "t",
      body: { n: from + i },
    })),
    { now: () => NOW },
  );
  return results[0]!.path;
}

/** Read the stream through `tails`, noting the offset of every shard read. */
function readCounting(s: StoreHandle, tails: ShardTails): { ns: number[]; offsets: number[] } {
  const offsets: number[] = [];
  const real = reader.readShard;
  const spy = spyOn(reader, "readShard").mockImplementation((path, options) => {
    offsets.push(options?.offset ?? 0);
    return real(path, options);
  });
  try {
    const read = readStreamRecords(s.root, "shared", { stream: "events" }, { tails });
    expect(read.unreadable).toEqual([]);
    return { ns: read.records.map((r) => r.body["n"] as number), offsets };
  } finally {
    spy.mockRestore();
  }
}

describe("stream reads through kept tails", () => {
  test("an unchanged shard is not read again", () => {
    const s = store();
    append(s, 0, 3);
    const tails: ShardTails = new Map();
    expect(readCounting(s, tails)).toEqual({ ns: [0, 1, 2], offsets: [0] });
    expect(readCounting(s, tails)).toEqual({ ns: [0, 1, 2], offsets: [] });
  });

  test("an appended shard is read from where the last read ended", () => {
    const s = store();
    const path = append(s, 0, 3);
    const tails: ShardTails = new Map();
    readCounting(s, tails);
    const before = readFileSync(path).length;
    append(s, 3, 2);
    expect(readCounting(s, tails)).toEqual({ ns: [0, 1, 2, 3, 4], offsets: [before] });
  });

  test("a shard whose read bytes changed, or that is shorter or another file, is read whole", () => {
    const s = store();
    const path = append(s, 0, 3);
    const tails: ShardTails = new Map();
    readCounting(s, tails);

    // The same inode, longer, with its first line changed: the checksum of
    // what was read no longer matches, so the whole shard is read.
    const lines = readFileSync(path, "utf8").split("\n");
    writeFileSync(path, [lines[1], lines[0], lines[2], ""].join("\n"));
    append(s, 3, 1);
    expect(readCounting(s, tails).offsets).toEqual([0]);

    // Shorter.
    const kept = readFileSync(path, "utf8");
    truncateSync(path, kept.indexOf("\n") + 1);
    expect(readCounting(s, tails).offsets).toEqual([0]);

    // Another file under the name (a sync tool's rename).
    writeFileSync(`${path}.new`, kept);
    renameSync(`${path}.new`, path);
    expect(readCounting(s, tails)).toEqual({ ns: [1, 0, 2, 3], offsets: [0] });
  });

  test("a shard replaced after the prefix check and before the read is read whole, not combined", () => {
    const s = store();
    const path = append(s, 0, 3);
    const tails: ShardTails = new Map();
    readCounting(s, tails);
    append(s, 3, 1);
    // The replacement: other records, longer than what was kept, written
    // beside the shard while the read takes the kept prefix.
    const original = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l !== "");
    const replacement = [original[3], original[2], original[1], original[0], ""].join("\n");
    const offsets: number[] = [];
    const real = reader.readShard;
    const spy = spyOn(reader, "readShard").mockImplementation((p, options) => {
      offsets.push(options?.offset ?? 0);
      if ((options?.offset ?? 0) > 0) {
        writeFileSync(`${path}.new`, replacement);
        renameSync(`${path}.new`, path);
      }
      return real(p, options);
    });
    let ns: number[];
    try {
      const read = readStreamRecords(s.root, "shared", { stream: "events" }, { tails });
      ns = read.records.map((r) => r.body["n"] as number);
    } finally {
      spy.mockRestore();
    }
    // The suffix read happened, and its result was dropped for a whole read
    // of the replacement (before: old kept records plus the replacement's tail).
    expect(offsets[0]).toBeGreaterThan(0);
    expect(offsets.at(-1)).toBe(0);
    expect(ns).toEqual([3, 2, 1, 0]);
  });

  test("without kept tails every read is whole, as before", () => {
    const s = store();
    append(s, 0, 2);
    const offsets: number[] = [];
    const real = reader.readShard;
    const spy = spyOn(reader, "readShard").mockImplementation((path, options) => {
      offsets.push(options?.offset ?? 0);
      return real(path, options);
    });
    try {
      readStreamRecords(s.root, "shared", { stream: "events" });
      readStreamRecords(s.root, "shared", { stream: "events" });
    } finally {
      spy.mockRestore();
    }
    expect(offsets).toEqual([0, 0]);
  });
});
