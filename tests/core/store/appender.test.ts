import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { appendRecord, PartitionUnavailableError } from "../../../src/core/store/appender.ts";
import { BLOB_REF_KEY, STORE_LINE_CAP_BYTES } from "../../../src/core/store/constants.ts";
import { compareRecords } from "../../../src/core/store/envelope.ts";
import { clockFilePath, observeClock } from "../../../src/core/store/clock-store.ts";
import { parseHlc } from "../../../src/core/store/hlc.ts";
import { readShard } from "../../../src/core/store/reader.ts";
import { listShards } from "../../../src/core/store/shard-list.ts";
import {
  blobPath,
  isPathInside,
  partitionDir,
  shardLockTarget,
} from "../../../src/core/store/store-paths.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { ensureStore, makeTempStore, type TempStore } from "./fixtures/temp-store.ts";
import { neverHeld } from "../../helpers/held-partitions.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const NOV_2026 = Date.UTC(2026, 10, 6, 12, 0, 0);

describe("shard appender", () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = makeTempStore("osb-store-append-");
  });
  afterEach(() => tmp.cleanup());

  test("writes one verified line per record into the device's monthly shard", () => {
    const store = tmp.open("dev-a");
    const result = appendRecord(
      store,
      {
        partition: "shared",
        stream: "events",
        kind: "feedback",
        agent: "a1",
        scope: "writing",
        body: { n: 1 },
      },
      { now: () => NOV_2026 },
    );
    expect(result.rel).toBe("events/dev-a/2026-11.jsonl");
    expect(result.path).toBe(join(tmp.root, "shared", "events", "dev-a", "2026-11.jsonl"));
    const text = readFileSync(result.path, "utf8");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.split("\n")).toHaveLength(2);
    const read = readShard(result.path);
    expect(read.records.map((r) => r.record)).toEqual([result.record]);
    expect(read.diagnostics).toEqual([]);
  });

  test("ledgers go one directory deeper, under their name", () => {
    const store = tmp.open("dev-a");
    const result = appendRecord(
      store,
      {
        partition: "private",
        stream: "ledgers",
        ledger: "receipts",
        kind: "receipt",
        agent: "a1",
        body: {},
      },
      { now: () => NOV_2026 },
    );
    expect(result.rel).toBe("ledgers/receipts/dev-a/2026-11.jsonl");
  });

  test("no lock or clock file is ever written inside the store", () => {
    const store = tmp.open("dev-a");
    for (let i = 0; i < 3; i++) {
      appendRecord(store, {
        partition: "shared",
        stream: "log",
        kind: "note",
        agent: "a1",
        body: { i },
      });
    }
    // Directories too: a lock is a `<target>.lock` directory while held,
    // and its parent directory stays behind after release.
    const walk = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? [join(dir, e.name), ...walk(join(dir, e.name))] : [join(dir, e.name)],
      );
    const names = walk(tmp.root);
    expect(names.filter((n) => n.includes(".lock") || n.includes("clock"))).toEqual([]);
    const lockTarget = shardLockTarget(store.deviceStateDir, "shared", "log/dev-a/2026-11.jsonl");
    for (const path of [lockTarget, clockFilePath(store.deviceStateDir, "dev-a")]) {
      expect(isPathInside(path, store.deviceStateDir, process.platform)).toBe(true);
      expect(isPathInside(path, tmp.root, process.platform)).toBe(false);
    }
    expect(existsSync(store.deviceStateDir)).toBe(true);
  });

  test("a write to a partition this machine does not hold is refused with a clear message", () => {
    tmp.open("dev-a");
    // This machine syncs only the shared partition.
    neverHeld(tmp.root);
    const sharedOnly = tmp.open("dev-a");
    const write = () =>
      appendRecord(sharedOnly, {
        partition: "private",
        stream: "events",
        kind: "x",
        agent: "a",
        body: {},
      });
    expect(write).toThrow(PartitionUnavailableError);
    expect(write).toThrow(/does not hold the private partition/);
    expect(existsSync(join(tmp.root, "private"))).toBe(false);
  });

  test("a body over the line cap spills into an immutable blob named by the record's sum", () => {
    const store = tmp.open("dev-a");
    const body = { report: "r".repeat(STORE_LINE_CAP_BYTES * 2) };
    const result = appendRecord(store, {
      partition: "shared",
      stream: "events",
      kind: "report",
      agent: "a",
      body,
    });
    expect(result.spilled).toBe(true);
    const line = readFileSync(result.path, "utf8");
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(STORE_LINE_CAP_BYTES);
    expect(JSON.parse(line).body[BLOB_REF_KEY]).toBe(result.record.sum);
    expect(existsSync(blobPath(partitionDir(tmp.root, "shared"), result.record.sum))).toBe(true);
    const read = readShard(result.path, { partitionRoot: partitionDir(tmp.root, "shared") });
    expect(read.records[0]!.bodyState).toBe("blob");
    expect(read.records[0]!.record.body).toEqual(body);
  });

  test("a torn last line left by a crash stays one reported bad line and the next record is whole", () => {
    const store = tmp.open("dev-a");
    const first = appendRecord(store, {
      partition: "shared",
      stream: "events",
      kind: "x",
      agent: "a",
      body: { n: 1 },
    });
    appendFileSync(first.path, '{"v":1,"id":"01J');
    const third = appendRecord(store, {
      partition: "shared",
      stream: "events",
      kind: "x",
      agent: "a",
      body: { n: 3 },
    });
    const read = readShard(first.path);
    expect(read.records.map((r) => r.record.id)).toEqual([first.record.id, third.record.id]);
    expect(read.diagnostics.map((d) => d.kind)).toEqual(["corrupt-line"]);
  });

  test("records of one device are strictly increasing in clock order, even when the wall clock steps back", () => {
    const store = tmp.open("dev-a");
    const walls = [NOV_2026, NOV_2026 - 60_000, NOV_2026 - 120_000, NOV_2026];
    const records = walls.map(
      (wall) =>
        appendRecord(
          store,
          { partition: "shared", stream: "events", kind: "x", agent: "a", body: {} },
          { now: () => wall },
        ).record,
    );
    for (let i = 1; i < records.length; i++)
      expect(compareRecords(records[i]!, records[i - 1]!)).toBeGreaterThan(0);
  });

  test("a reply written after observing a faster machine's record folds after it", () => {
    ensureStore(tmp.root);
    const fast = openStore({ root: tmp.root, device: "fast-a", dirs: tmp.dirs("a") });
    const slow = openStore({ root: tmp.root, device: "slow-b", dirs: tmp.dirs("b") });
    const decision = appendRecord(
      fast,
      {
        partition: "shared",
        stream: "events",
        kind: "decision",
        agent: "a",
        body: { d: "use monthly shards" },
      },
      { now: () => NOV_2026 + 120_000 },
    ).record;
    // Machine B catches up on A's shard and observes every clock it ingests.
    for (const shard of listShards(partitionDir(tmp.root, "shared"), { stream: "events" })) {
      for (const { record } of readShard(shard.path).records) {
        observeClock(slow.deviceStateDir, slow.device, parseHlc(record.hlc)!, () => NOV_2026);
      }
    }
    const correction = appendRecord(
      slow,
      {
        partition: "shared",
        stream: "events",
        kind: "correction",
        agent: "b",
        body: { of: decision.id },
      },
      { now: () => NOV_2026 + 1 },
    ).record;
    expect(compareRecords(correction, decision)).toBeGreaterThan(0);
  });
});

describe("concurrent appends on one device", () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = makeTempStore("osb-store-concurrent-");
  });
  afterEach(() => tmp.cleanup());

  test("child processes produce N complete, verifiable lines and one shared blob", async () => {
    const WORKERS = 6;
    const EACH = 100;
    // Every worker reports ready, then all start on one go file.
    const readyDir = join(tmp.parent, "ready");
    const goFile = join(tmp.parent, "go");
    mkdirSync(readyDir, { recursive: true });
    const stateHome = join(tmp.parent, "state", "one-device");
    ensureStore(tmp.root);
    const store = openStore({
      root: tmp.root,
      device: "dev-a",
      dirs: {
        platform: process.platform,
        home: stateHome,
        env: { XDG_STATE_HOME: stateHome, LOCALAPPDATA: stateHome },
      },
    });
    const worker = join(import.meta.dir, "fixtures", "append-worker.ts");
    const children = Array.from({ length: WORKERS }, (_, i) =>
      Bun.spawn(
        [
          process.execPath,
          worker,
          tmp.root,
          "dev-a",
          stateHome,
          String(i),
          String(EACH),
          readyDir,
          goFile,
        ],
        { stdout: "ignore", stderr: "pipe" },
      ),
    );
    const readyBy = Date.now() + 30_000;
    while (readdirSync(readyDir).length < WORKERS && Date.now() < readyBy) await Bun.sleep(5);
    writeFileSync(goFile, "go\n");
    // stderr is drained while waiting, so a noisy worker cannot block on a full pipe.
    const [codes, errors] = await Promise.all([
      Promise.all(children.map((child) => child.exited)),
      Promise.all(children.map((child) => new Response(child.stderr).text())),
    ]);
    expect(errors.filter((e) => e.trim() !== "")).toEqual([]);
    expect(codes).toEqual(Array.from({ length: WORKERS }, () => 0));

    const shards = listShards(partitionDir(tmp.root, "shared"), { stream: "events" });
    expect(shards.map((s) => s.device)).toEqual(["dev-a"]);
    const records = shards.flatMap(
      (s) => readShard(s.path, { partitionRoot: partitionDir(tmp.root, "shared") }).records,
    );
    const diagnostics = shards.flatMap((s) => readShard(s.path).diagnostics);
    expect(diagnostics).toEqual([]);
    expect(records).toHaveLength(WORKERS * EACH);
    expect(new Set(records.map((r) => r.record.id)).size).toBe(WORKERS * EACH);
    expect(new Set(records.map((r) => r.record.hlc)).size).toBe(WORKERS * EACH);
    expect(records.every((r) => r.bodyState !== "pending")).toBe(true);
    const blobDirs = readdirSync(join(tmp.root, "shared", "blobs"));
    const blobs = blobDirs.flatMap((d) => readdirSync(join(tmp.root, "shared", "blobs", d)));
    // Every worker spilled the same large body, so they raced for one blob name.
    expect(blobs).toHaveLength(1);
    expect(records.filter((r) => r.bodyState === "blob")).toHaveLength(
      WORKERS * Math.ceil(EACH / 3),
    );
    // The workers really contended: their lines interleave in the shard
    // rather than forming one block per worker.
    const switches = records.filter(
      (r, i) => i > 0 && r.record.agent !== records[i - 1]!.record.agent,
    ).length;
    expect(switches).toBeGreaterThan(WORKERS - 1);
    expect(store.storeId).toMatch(/^[0-9A-Z]{26}$/);
  }, 60_000);
});

describe("a record read before a write", () => {
  let tmp: TempStore;
  beforeEach(() => {
    tmp = makeTempStore("osb-store-append-read-");
  });
  afterEach(() => tmp.cleanup());

  const INPUT = {
    partition: "shared",
    stream: "events",
    kind: "feedback",
    agent: "a1",
    body: { n: 1 },
  } as const;

  test("a peer's record stamped ahead of this clock: the next local record folds after it", () => {
    const peer = appendRecord(tmp.open("dev-b"), INPUT, { now: () => NOV_2026 + 5 * 60_000 });
    const local = tmp.open("dev-a");
    // Read, as a fold does, before the write.
    readShard(peer.path, { partitionRoot: partitionDir(tmp.root, "shared") });
    const mine = appendRecord(local, INPUT, { now: () => NOV_2026 });
    expect(compareRecords(mine.record, peer.record)).toBeGreaterThan(0);
  });

  test("a record more than a day ahead is not adopted", () => {
    const far = NOV_2026 + 2 * 24 * 60 * 60_000;
    const peer = appendRecord(tmp.open("dev-b"), INPUT, { now: () => far });
    readShard(peer.path, { partitionRoot: partitionDir(tmp.root, "shared") });
    const mine = appendRecord(tmp.open("dev-a"), INPUT, { now: () => NOV_2026 });
    expect(parseHlc(mine.record.hlc)!.physical).toBe(NOV_2026);
  });
});
