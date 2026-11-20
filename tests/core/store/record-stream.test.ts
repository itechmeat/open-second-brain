/**
 * The store read one record at a time (change migration-memory-peak): the
 * record walk of a partition (`forEachPartitionRecord`) and of a shard
 * (`scanShard`) hand on exactly what the collecting reads return, in the
 * same order, with the same reports of what could not be read, and the
 * cut read from it is the cut of the collected read. A shard with a bad
 * middle line, a record whose blob has not arrived and a torn tail is in
 * the partition, beside clean shards of other streams.
 */
import { afterEach, expect, test } from "bun:test";
import { appendFileSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import { observedClockFloor } from "../../../src/core/store/clock-floor.ts";
import { formatHlc } from "../../../src/core/store/hlc.ts";
import { readShard, scanShard, type ReadRecord } from "../../../src/core/store/reader.ts";
import { addQuarantine } from "../../../src/core/store/shard-quarantine-write.ts";
import { lineSha256At } from "../../../src/core/store/shard-quarantine.ts";
import {
  computeCut,
  forEachPartitionRecord,
  readPartition,
  readPartitionCut,
  type PartitionShardTotals,
  type UnreadableShard,
} from "../../../src/core/store/state-digest.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { partitionDir } from "../../../src/core/store/store-paths.ts";
import { makeStoreEnv, type StoreEnv } from "./fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const NOV = Date.UTC(2026, 10, 6, 9);

function write(
  e: StoreEnv,
  stream: "events" | "log" | "settings",
  body: Record<string, unknown>,
): string {
  return appendRecord(
    openStore({ root: e.storeRoot, device: "dev-b" }),
    { partition: "shared", stream, kind: "note", agent: "t", body },
    { now: () => NOV },
  ).path;
}

const call = (c: UnreadableShard) => [c.rel, c.incomplete ?? false, String(c.error)];

/** A partition with a shard of every kind of gap, and clean shards beside it. */
function mixedPartition(e: StoreEnv): string {
  for (let n = 0; n < 5; n++) write(e, "log", { n });
  write(e, "settings", { n: "s" });
  write(e, "events", { n: 1 });
  write(e, "events", { n: 2, text: "x".repeat(20_000) });
  const path = write(e, "events", { n: 3 });
  // A bad middle line: the first record edited after it was written.
  const lines = readFileSync(path, "utf8").split("\n");
  lines[0] = lines[0]!.replace('"n":1', '"n":10');
  writeFileSync(path, lines.join("\n"));
  // A torn tail still arriving.
  appendFileSync(path, '{"v":1,"id":"01');
  // The blob of the second record has not arrived.
  const blobs = join(partitionDir(e.storeRoot, "shared"), "blobs");
  renameSync(blobs, join(e.storeRoot, "..", "blobs-aside"));
  return path;
}

test("the record walk of a partition hands on what the collected read holds", () => {
  env = makeStoreEnv("osb-record-stream-", { legacyTree: false });
  mixedPartition(env);
  const root = partitionDir(env.storeRoot, "shared");
  const collectedCalls: UnreadableShard[] = [];
  const shards = readPartition(root, { onUnreadable: (s) => collectedCalls.push(s) });

  const walkedCalls: UnreadableShard[] = [];
  const walked: Array<{ rel: string; id: string; pending: boolean }> = [];
  const totals: PartitionShardTotals[] = [];
  forEachPartitionRecord(
    root,
    { onUnreadable: (s) => walkedCalls.push(s) },
    {
      record: (shard, record, pending) => walked.push({ rel: shard.rel, id: record.id, pending }),
      shard: (t) => totals.push(t),
    },
  );

  const pendingIds = new Set(shards.flatMap((s) => s.pending.map((r) => r.id)));
  expect(pendingIds.size).toBe(1);
  expect(walked).toEqual(
    shards.flatMap((s) =>
      s.all.map((r) => ({ rel: s.rel, id: r.id, pending: pendingIds.has(r.id) })),
    ),
  );
  expect(totals).toEqual(
    shards.map((s) => ({
      rel: s.rel,
      device: s.device,
      stream: s.stream,
      count: s.all.length,
      pending: s.pending.length,
      last: s.all.at(-1)?.id ?? null,
      heldTailBytes: s.heldTailBytes,
    })),
  );
  expect(walkedCalls.map(call)).toEqual(collectedCalls.map(call));
  expect(walkedCalls.map((c) => c.rel)).toEqual(["events/dev-b/2026-11.jsonl"]);
  expect(totals.some((t) => t.heldTailBytes > 0)).toBe(true);
  expect(readPartitionCut(root)).toEqual(computeCut(shards));
});

test("a shard scanned record by record reads as the collected read of it", () => {
  env = makeStoreEnv("osb-record-scan-", { legacyTree: false });
  const path = mixedPartition(env);
  const partitionRoot = partitionDir(env.storeRoot, "shared");
  const read = readShard(path, { partitionRoot });
  const seen: ReadRecord[] = [];
  const scan = scanShard(path, { partitionRoot }, (r) => seen.push(r));
  expect(seen).toEqual([...read.records]);
  expect(scan.records).toBe(read.records.length);
  expect(scan.pending).toBe(read.records.filter((r) => r.bodyState === "pending").length);
  expect(scan.diagnostics).toEqual(read.diagnostics);
  expect(scan.nextOffset).toBe(read.nextOffset);
  expect(scan.pendingTailBytes).toBe(read.pendingTailBytes);
  expect(scan.size).toBe(read.size);
  expect(scan.diagnostics.map((d) => d.kind)).toEqual(["corrupt-line"]);
});

test("a record's stamp raises the clock floor before the record is handed on", () => {
  env = makeStoreEnv("osb-record-clock-", { legacyTree: false });
  const path = write(env, "events", { n: 1 });
  write(env, "events", { n: 2 });
  const partitionRoot = partitionDir(env.storeRoot, "shared");
  const floors: Array<string | null> = [];
  const stamps: string[] = [];
  scanShard(path, { partitionRoot }, (r) => {
    stamps.push(r.record.hlc);
    const floor = observedClockFloor(env!.storeRoot);
    floors.push(floor === null ? null : formatHlc(floor));
  });
  expect(floors).toEqual(stamps);
});

test("a quarantined pending record counts in the walk's totals and cut as in the collected read", () => {
  env = makeStoreEnv("osb-record-quarantine-", { legacyTree: false });
  write(env, "events", { n: 1 });
  const path = write(env, "events", { n: 2, text: "x".repeat(20_000) });
  write(env, "events", { n: 3 });
  const root = partitionDir(env.storeRoot, "shared");
  renameSync(join(root, "blobs"), join(env.storeRoot, "..", "blobs-aside"));
  const lines = readFileSync(path, "utf8").split("\n");
  const offset = Buffer.byteLength(lines[0]!) + 1;
  expect(
    addQuarantine(env.storeRoot, {
      partition: "shared",
      shard: "events/dev-b/2026-11.jsonl",
      offset,
      sha256: lineSha256At(path, offset, root)!,
      kind: "blob-pending",
      reason: "test",
    }),
  ).toBe("quarantined");
  const shards = readPartition(root, { onUnreadable: () => {} });
  const events = shards.find((s) => s.rel === "events/dev-b/2026-11.jsonl")!;
  // The collected read hands the quarantined record on as pending, and its
  // cut counts it, as the whole-shard read always did.
  expect(events.pending).toHaveLength(1);
  const totals: PartitionShardTotals[] = [];
  forEachPartitionRecord(root, { onUnreadable: () => {} }, { shard: (t) => totals.push(t) });
  const walked = totals.find((t) => t.rel === "events/dev-b/2026-11.jsonl")!;
  expect([walked.count, walked.pending]).toEqual([events.all.length, events.pending.length]);
  expect(readPartitionCut(root)).toEqual(computeCut(shards));
  expect(readPartitionCut(root).find((c) => c.shard === events.rel)?.pending).toBe(1);
});
