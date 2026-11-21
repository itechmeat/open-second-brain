/**
 * A stream read through kept tails (`stream-read.ts` `ShardTails`) parses
 * only what was appended since the last read: an unchanged shard is not
 * read at all, an appended one from where the last read ended, and a shard
 * the stamp and the checksum of what was read cannot prove unchanged (a
 * rewritten prefix, a shorter file, another inode) is read whole. On a
 * volume whose clock and file ids do not move, every change the format
 * allows (an append, a newer copy delivered under the name, a shorter or
 * another copy) still reads right.
 */
import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { readFileSync, renameSync, truncateSync, utimesSync, writeFileSync } from "node:fs";

import { RACY_WINDOW_MS } from "../../../src/core/fs-stamp.ts";
import { appendRecords } from "../../../src/core/store/appender.ts";
import * as reader from "../../../src/core/store/reader.ts";
import { readStreamRecords, type ShardTails } from "../../../src/core/store/read/stream-read.ts";
import { openStore, type StoreHandle } from "../../../src/core/store/store-open.ts";
import { makeTestStore, type TestStore } from "../../helpers/test-store.ts";

const NOW = Date.UTC(2026, 10, 20);
let scratch: TestStore | null = null;
afterEach(() => {
  setSystemTime();
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
  const real = reader.scanShard;
  const spy = spyOn(reader, "scanShard").mockImplementation((path, options, onRecord) => {
    offsets.push(options?.offset ?? 0);
    return real(path, options, onRecord);
  });
  try {
    const read = readStreamRecords(s.root, "shared", { stream: "events" }, { tails });
    expect(read.unreadable).toEqual([]);
    return { ns: read.records.map((r) => r.body["n"] as number), offsets };
  } finally {
    spy.mockRestore();
  }
}

/** `bigint` stats of a regular file with one inode, and one mtime and ctime: `atNs`. */
function frozen(stat: unknown, atNs: bigint): unknown {
  const s = stat as fs.BigIntStats | undefined;
  if (s === undefined || typeof s.ino !== "bigint" || !s.isFile()) return stat;
  Object.assign(s, { ino: 7n, mtimeNs: atNs, ctimeNs: atNs });
  return s;
}

/**
 * Run `body` as on a volume where every write lands in one tick of the
 * file system's clock and every regular file reports one file id: `bigint`
 * stats of a regular file keep their size but report one mtime, one ctime
 * and one inode. That is a fast write on a coarse clock (Windows updates
 * file times per timer tick, FAT keeps the mtime to 2 s) on a volume whose
 * file ids are synthetic and reused after a replace (FAT and exFAT derive
 * them from the directory entry, ReFS does not promise unique 64-bit ids).
 */
function onFrozenVolume<T>(body: () => T): T {
  // The tick every write lands in: the moment the volume is entered.
  const atNs = BigInt(Date.now()) * 1_000_000n;
  const realL = fs.lstatSync;
  const realF = fs.fstatSync;
  const l = spyOn(fs, "lstatSync").mockImplementation(((p: fs.PathLike, o?: fs.StatOptions) =>
    frozen(realL(p, o), atNs)) as typeof fs.lstatSync);
  const f = spyOn(fs, "fstatSync").mockImplementation(((fd: number, o?: fs.StatOptions) =>
    frozen(realF(fd, o), atNs)) as typeof fs.fstatSync);
  try {
    return body();
  } finally {
    l.mockRestore();
    f.mockRestore();
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
    // what was read no longer matches, so the whole shard is read. The
    // format never rewrites a shard in place; the step stands for a rewrite
    // the volume's clock records, so its mtime is set apart from the kept
    // one. A fast volume can otherwise land the rewrite in the tick of the
    // last append, where no stamp sees it (the frozen-volume test below).
    const lines = readFileSync(path, "utf8").split("\n");
    writeFileSync(path, [lines[1], lines[0], lines[2], ""].join("\n"));
    const later = new Date(Date.now() + 60_000);
    utimesSync(path, later, later);
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
    const real = reader.scanShard;
    const spy = spyOn(reader, "scanShard").mockImplementation((p, options, onRecord) => {
      offsets.push(options?.offset ?? 0);
      if ((options?.offset ?? 0) > 0) {
        writeFileSync(`${path}.new`, replacement);
        renameSync(`${path}.new`, path);
      }
      return real(p, options, onRecord);
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

  test("on a volume whose clock and file ids do not move, every change the format allows reads right", () => {
    const s = store();
    const path = append(s, 0, 3);
    // Another copy of the same shard, written by a device with the same id
    // elsewhere: other records, so other bytes from the first line on.
    const other = makeTestStore("osb-stream-tails-other-");
    let foreign: string;
    try {
      const o = openStore({ root: other.root, device: "dev-a" });
      foreign = readFileSync(append(o, 10, 5), "utf8");
    } finally {
      other.cleanup();
    }
    const tails: ShardTails = new Map();
    onFrozenVolume(() => {
      expect(readCounting(s, tails).ns).toEqual([0, 1, 2]);

      // An append of this process.
      append(s, 3, 1);
      expect(readCounting(s, tails).ns).toEqual([0, 1, 2, 3]);

      // A newer copy delivered under the name (a sync tool's rename): the
      // kept bytes are its prefix, so the kept records stand.
      const kept = readFileSync(path, "utf8");
      append(s, 4, 2);
      const newer = readFileSync(path, "utf8");
      writeFileSync(path, kept);
      writeFileSync(`${path}.new`, newer);
      renameSync(`${path}.new`, path);
      expect(readCounting(s, tails).ns).toEqual([0, 1, 2, 3, 4, 5]);

      // A shorter copy.
      writeFileSync(`${path}.new`, kept);
      renameSync(`${path}.new`, path);
      expect(readCounting(s, tails)).toEqual({ ns: [0, 1, 2, 3], offsets: [0] });

      // Another, longer copy: the checksum of the kept bytes fails.
      writeFileSync(`${path}.new`, foreign);
      renameSync(`${path}.new`, path);
      expect(readCounting(s, tails)).toEqual({ ns: [10, 11, 12, 13, 14], offsets: [0] });
    });
  });

  test("on a volume whose clock and file ids do not move, a same-size replacement reads right", () => {
    // A whole replacement that keeps size, file id and both times (a
    // reused id on FAT or exFAT, inside one tick of the clock): the stamp
    // the tail was kept with had not settled, so the kept bytes are
    // checksummed before the kept read may answer, and they differ.
    const s = store();
    const path = append(s, 0, 3);
    const tails: ShardTails = new Map();
    onFrozenVolume(() => {
      expect(readCounting(s, tails).ns).toEqual([0, 1, 2]);
      const lines = readFileSync(path, "utf8").split("\n");
      const swapped = [lines[1], lines[0], ...lines.slice(2)].join("\n");
      writeFileSync(`${path}.new`, swapped);
      renameSync(`${path}.new`, path);
      expect(readCounting(s, tails)).toEqual({ ns: [1, 0, 2], offsets: [0] });
    });
  });

  test("a kept stamp that had settled answers an unchanged shard without opening it", () => {
    const s = store();
    const path = append(s, 0, 3);
    // The read that keeps the tail looks once the shard's times are older
    // than the racy window (ctime cannot be set back, so the clock moves).
    setSystemTime(new Date(Date.now() + RACY_WINDOW_MS + 1_000));
    const tails: ShardTails = new Map();
    expect(readCounting(s, tails)).toEqual({ ns: [0, 1, 2], offsets: [0] });
    const opened: string[] = [];
    const realOpen = fs.openSync;
    const open = spyOn(fs, "openSync").mockImplementation(((p: fs.PathLike, ...rest: unknown[]) => {
      opened.push(String(p));
      return (realOpen as (...a: unknown[]) => number)(p, ...rest);
    }) as typeof fs.openSync);
    try {
      expect(readCounting(s, tails)).toEqual({ ns: [0, 1, 2], offsets: [] });
    } finally {
      open.mockRestore();
    }
    expect(opened).not.toContain(path);
  });

  test("without kept tails every read is whole, as before", () => {
    const s = store();
    append(s, 0, 2);
    const offsets: number[] = [];
    const real = reader.scanShard;
    const spy = spyOn(reader, "scanShard").mockImplementation((path, options, onRecord) => {
      offsets.push(options?.offset ?? 0);
      return real(path, options, onRecord);
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
