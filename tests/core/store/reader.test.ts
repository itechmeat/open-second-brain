import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  BLOB_REF_BYTES_KEY,
  BLOB_REF_KEY,
  COMPACTED_KIND,
  STORE_BODY_MAX_DEPTH,
  STORE_FORMAT_VERSION,
  STORE_LINE_CAP_BYTES,
} from "../../../src/core/store/constants.ts";
import { sha256Hex } from "../../../src/core/integrity/digest.ts";
import {
  buildRecord,
  canonicalBodyText,
  EnvelopeError,
  type RecordBody,
  type StoreRecord,
} from "../../../src/core/store/envelope.ts";
import { writeBlob } from "../../../src/core/store/blobs.ts";
import {
  classifyMissingShard,
  readBlobBody,
  readShard,
  replacedShards,
} from "../../../src/core/store/reader.ts";
import { listShards } from "../../../src/core/store/shard-list.ts";

const line = (record: unknown): string => `${JSON.stringify(record)}\n`;

let counter = 0;
/** A fixture record; every call gets its own, increasing clock stamp. */
function makeRecord(body?: RecordBody, kind = "note"): StoreRecord {
  const n = ++counter;
  return buildRecord({
    hlc: { physical: Date.UTC(2026, 10, 1) + n, counter: 0 },
    device: "dev-b",
    agent: "agent-b",
    kind,
    body: body ?? { n },
  });
}

describe("shard reader fixtures", () => {
  let dir: string;
  let partition: string;
  let shard: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "osb-store-read-"));
    partition = join(dir, "shared");
    shard = join(partition, "events", "dev-b", "2026-11.jsonl");
    mkdirSync(dirname(shard), { recursive: true });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  test("a cut last line is held back and read once the rest arrives", () => {
    const a = makeRecord();
    const b = makeRecord();
    const full = line(b);
    writeFileSync(shard, line(a) + full.slice(0, 30));
    const first = readShard(shard);
    expect(first.records.map((r) => r.record.id)).toEqual([a.id]);
    expect(first.diagnostics).toEqual([]);
    expect(first.pendingTailBytes).toBe(30);
    expect(first.nextOffset).toBe(Buffer.byteLength(line(a)));

    appendFileSync(shard, full.slice(30));
    const second = readShard(shard, { offset: first.nextOffset });
    expect(second.records.map((r) => r.record.id)).toEqual([b.id]);
    expect(second.pendingTailBytes).toBe(0);
    expect(second.nextOffset).toBe(second.size);
  });

  test("a complete last line that fails its checksum is retried, not reported", () => {
    const a = makeRecord();
    const bad = { ...makeRecord(), sum: "0".repeat(64) };
    writeFileSync(shard, line(a) + line(bad));
    const read = readShard(shard);
    expect(read.records.map((r) => r.record.id)).toEqual([a.id]);
    expect(read.diagnostics).toEqual([]);
    expect(read.pendingTailBytes).toBe(Buffer.byteLength(line(bad)));
  });

  test("a corrupt middle line is reported and skipped; the lines around it are read", () => {
    const a = makeRecord();
    const c = makeRecord();
    const tampered = { ...makeRecord(), body: { n: "tampered" } };
    writeFileSync(shard, line(a) + line(tampered) + "{not json\n" + line(c));
    const read = readShard(shard);
    expect(read.records.map((r) => r.record.id)).toEqual([a.id, c.id]);
    expect(read.diagnostics.map((d) => [d.kind, d.offset])).toEqual([
      ["corrupt-line", Buffer.byteLength(line(a))],
      ["corrupt-line", Buffer.byteLength(line(a) + line(tampered))],
    ]);
    expect(read.diagnostics[0]!.reason).toContain("checksum");
    expect(read.nextOffset).toBe(read.size);
  });

  test("a record of a future format version is skipped and reported", () => {
    const a = makeRecord();
    const future = { ...makeRecord(), v: STORE_FORMAT_VERSION + 1, shiny: true };
    const c = makeRecord();
    writeFileSync(shard, line(a) + line(future) + line(c));
    const read = readShard(shard);
    expect(read.records.map((r) => r.record.id)).toEqual([a.id, c.id]);
    expect(read.diagnostics).toEqual([
      {
        kind: "unknown-version",
        offset: Buffer.byteLength(line(a)),
        reason: `unknown format version ${STORE_FORMAT_VERSION + 1}`,
      },
    ]);
  });

  test("a future-version last line is consumed like any other, not retried forever", () => {
    const future = { ...makeRecord(), v: STORE_FORMAT_VERSION + 1 };
    writeFileSync(shard, line(future));
    const read = readShard(shard);
    expect(read.diagnostics.map((d) => d.kind)).toEqual(["unknown-version"]);
    expect(read.nextOffset).toBe(read.size);
  });

  test("a compacted shard is reported as replaced, not missing", () => {
    const old = "events/dev-b/2026-10.jsonl";
    const into = "events/dev-b/2026-10.c1.jsonl";
    writeFileSync(join(partition, ...into.split("/")), line(makeRecord()));
    const marker = makeRecord({ replaces: [old], into: [into] }, COMPACTED_KIND);
    writeFileSync(shard, line(marker));
    const read = readShard(shard);
    expect(read.compactions).toEqual([{ id: marker.id, replaces: [old], into: [into] }]);
    const replaced = replacedShards(read.compactions);
    expect(classifyMissingShard(old, replaced)).toBe("replaced");
    expect(classifyMissingShard("events/dev-b/2026-09.jsonl", replaced)).toBe("missing");
    // The compaction output is a shard; a sync conflict copy is not.
    writeFileSync(
      join(partition, "events", "dev-b", "2026-11.sync-conflict-20261106.jsonl"),
      "x\n",
    );
    expect(listShards(partition, { stream: "events" }).map((s) => s.rel)).toEqual([
      into,
      "events/dev-b/2026-11.jsonl",
    ]);
  });

  test("a blob that arrives late: pending first, filled in on a later read", () => {
    const body = { report: "long text" };
    const full = makeRecord(body);
    const text = canonicalBodyText(full.body);
    const onLine = {
      ...full,
      body: { [BLOB_REF_KEY]: full.sum, [BLOB_REF_BYTES_KEY]: Buffer.byteLength(text) },
    };
    writeFileSync(shard, line(onLine));

    const before = readShard(shard, { partitionRoot: partition });
    expect(before.diagnostics).toEqual([]);
    expect(before.records[0]!.bodyState).toBe("pending");
    expect(before.records[0]!.record.id).toBe(full.id);

    // A partially delivered blob is still pending.
    const blobFile = join(partition, "blobs", full.sum.slice(0, 2), full.sum);
    mkdirSync(dirname(blobFile), { recursive: true });
    writeFileSync(blobFile, text.slice(0, 5));
    expect(readShard(shard, { partitionRoot: partition }).records[0]!.bodyState).toBe("pending");
    rmSync(blobFile);

    expect(writeBlob(partition, text).sha).toBe(full.sum);
    const after = readShard(shard, { partitionRoot: partition });
    expect(after.records[0]!.bodyState).toBe("blob");
    expect(after.records[0]!.record.body).toEqual(body);
  });

  /**
   * A line whose blob reference passes the envelope check (its hash is the
   * record's sum) and a blob that hashes to its name, holding `content`.
   */
  function craftedBlobLine(content: string, bytes = Buffer.byteLength(content)): string {
    const sum = sha256Hex(content);
    const record = {
      ...makeRecord(),
      sum,
      body: { [BLOB_REF_KEY]: sum, [BLOB_REF_BYTES_KEY]: bytes },
    };
    const blobFile = join(partition, "blobs", sum.slice(0, 2), sum);
    mkdirSync(dirname(blobFile), { recursive: true });
    writeFileSync(blobFile, content);
    return line(record);
  }

  test("a hash-valid blob that is not a record body is reported and skipped, never thrown", () => {
    for (const content of ["null", "[1,2]", "42", "not json at all", '{"$blob":"x","b":1}']) {
      const before = makeRecord();
      const after = makeRecord();
      writeFileSync(shard, line(before) + craftedBlobLine(content) + line(after));
      const read = readShard(shard, { partitionRoot: partition });
      expect(read.records.map((r) => r.record.id)).toEqual([before.id, after.id]);
      expect(read.diagnostics.map((d) => d.kind)).toEqual(["corrupt-line"]);
      expect(read.nextOffset).toBe(read.size);
      expect(readBlobBody(partition, sha256Hex(content)).status).toBe("invalid");
    }
  });

  test("a hash-valid blob nested past the depth bound is a corrupt record, the pass goes on", () => {
    // Deep enough to overflow a recursive canonicalization.
    const depth = 100_000;
    const content = `{"a":${"[".repeat(depth)}${"]".repeat(depth)}}`;
    const before = makeRecord();
    const after = makeRecord();
    writeFileSync(shard, line(before) + craftedBlobLine(content) + line(after));
    const read = readShard(shard, { partitionRoot: partition });
    expect(read.records.map((r) => r.record.id)).toEqual([before.id, after.id]);
    expect(read.diagnostics.map((d) => d.kind)).toEqual(["corrupt-line"]);
    expect(read.nextOffset).toBe(read.size);
    expect(readBlobBody(partition, sha256Hex(content)).status).toBe("invalid");
  });

  test("an inline body nested past the depth bound is a corrupt line and is never written", () => {
    let deep: unknown = 1;
    for (let i = 0; i < STORE_BODY_MAX_DEPTH; i++) deep = [deep];
    // The body object is one level, so this body is one level too deep.
    expect(() => makeRecord({ deep } as RecordBody)).toThrow(EnvelopeError);
    const atBound = makeRecord({ deep: (deep as unknown[])[0] } as RecordBody);
    const sum = sha256Hex(JSON.stringify({ deep }));
    const tooDeep = { ...makeRecord(), sum, body: { deep } };
    writeFileSync(shard, line(atBound) + line(tooDeep) + line(makeRecord()));
    const read = readShard(shard, { partitionRoot: partition });
    expect(read.records.length).toBe(2);
    expect(read.records[0]!.record.id).toBe(atBound.id);
    expect(read.diagnostics.map((d) => d.kind)).toEqual(["corrupt-line"]);
  });

  test("a blob that holds a non-canonical form of an object is not a record body", () => {
    const content = '{ "b": 1, "a": 2 }';
    writeFileSync(shard, craftedBlobLine(content) + line(makeRecord()));
    const read = readShard(shard, { partitionRoot: partition });
    expect(read.diagnostics.map((d) => d.kind)).toEqual(["corrupt-line"]);
  });

  test("a blob whose size is not the size its reference promises stays pending", () => {
    const full = makeRecord({ report: "long text" });
    const text = canonicalBodyText(full.body);
    writeBlob(partition, text);
    const onLine = {
      ...full,
      body: { [BLOB_REF_KEY]: full.sum, [BLOB_REF_BYTES_KEY]: Buffer.byteLength(text) + 1 },
    };
    writeFileSync(shard, line(onLine));
    const read = readShard(shard, { partitionRoot: partition });
    expect(read.records[0]!.bodyState).toBe("pending");
    expect(readBlobBody(partition, full.sum, Buffer.byteLength(text)).status).toBe("ok");
  });

  test("a run longer than the line cap is a corrupt line, not a pending tail", () => {
    const a = makeRecord();
    const b = makeRecord();
    const run = "x".repeat(STORE_LINE_CAP_BYTES + 10);
    writeFileSync(shard, line(a) + run + "\n" + line(b));
    const middle = readShard(shard);
    expect(middle.records.map((r) => r.record.id)).toEqual([a.id, b.id]);
    expect(middle.diagnostics.map((d) => d.kind)).toEqual(["corrupt-line"]);

    // At the end of the shard, with no newline at all, it is consumed too.
    writeFileSync(shard, line(a) + run);
    const tail = readShard(shard);
    expect(tail.records.map((r) => r.record.id)).toEqual([a.id]);
    expect(tail.diagnostics.map((d) => d.kind)).toEqual(["corrupt-line"]);
    expect(tail.pendingTailBytes).toBe(0);
    expect(tail.nextOffset).toBe(tail.size);
  });

  test("a shard larger than one read chunk is read whole, lines across chunk edges included", () => {
    // About 3 MB, so lines cross the edges of the 1 MiB read chunks.
    const records = Array.from({ length: 300 }, () => makeRecord({ pad: "p".repeat(10_000) }));
    writeFileSync(shard, records.map(line).join(""));
    const read = readShard(shard);
    expect(read.diagnostics).toEqual([]);
    expect(read.records.map((r) => r.record.id)).toEqual(records.map((r) => r.id));
    expect(read.nextOffset).toBe(read.size);
    const offsets = read.records.map((r) => r.offset);
    expect(offsets[1]).toBe(read.records[0]!.length);
  });

  test("a record whose device is not its shard directory's device is reported and skipped", () => {
    const own = makeRecord();
    const forged = buildRecord({
      hlc: { physical: Date.UTC(2026, 10, 2), counter: 0 },
      device: "dev-victim",
      agent: "agent-x",
      kind: "note",
      body: { n: 1 },
    });
    writeFileSync(shard, line(forged) + line(own));
    const read = readShard(shard);
    expect(read.records.map((r) => r.record.id)).toEqual([own.id]);
    expect(read.diagnostics.map((d) => [d.kind, d.offset])).toEqual([["corrupt-line", 0]]);
  });

  test("reading from an offset returns only later lines; an offset past the end is reported", () => {
    const a = makeRecord();
    const b = makeRecord();
    writeFileSync(shard, line(a) + line(b));
    const offset = Buffer.byteLength(line(a));
    const read = readShard(shard, { offset });
    expect(read.records.map((r) => [r.record.id, r.offset])).toEqual([[b.id, offset]]);
    const past = readShard(shard, { offset: 10_000 });
    expect(past.diagnostics.map((d) => d.kind)).toEqual(["offset-past-end"]);
    expect(past.records).toEqual([]);
  });
});
