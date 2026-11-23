/**
 * Read the store from recorded positions (dream replay design D3, "The
 * read path this needs").
 *
 * A position names one shard and the first byte not yet read in it, with
 * the sha256 of the bytes before that offset. {@link readShardsFrom} reads
 * every shard of the given streams from its position: the verified records
 * after the offset and the new position, through the shard reader. It
 * checks the recorded prefix digest first, so a shard rewritten under its
 * name (a sync tool's older copy, a hand edit) is never read from an
 * offset that means nothing in it. Every shard comes back with one status:
 *
 *  - `read`: the records after the position and the new position. A last
 *    line still arriving (torn, unverified) is held back by the reader and
 *    is not a gap: the new position stops before it.
 *  - `gap`: the reader saw a record it cannot give (a body that is a
 *    pending blob, a bad line in the middle, a newer format, no regular
 *    file). No record is returned and the position stays where it was, so
 *    the next read sees the same bytes again.
 *  - `mismatch`: the bytes before the recorded offset are not the ones
 *    recorded (or the shard is now shorter than the offset). The shard is
 *    read whole, and its new position is its end.
 *  - `replaced`: a `compacted` record read here names the shard in
 *    `replaces`; `into` names the shards that hold its records now. When
 *    the shard is still there, its records after the position are given
 *    as for `read`; the caller rebases (design D3, "Rebase").
 *  - `missing`: a shard with a position that is no longer listed and that
 *    no compaction read here replaced.
 *
 * A shard with no position is read from its start. Nothing is written.
 */

import { createHash } from "node:crypto";
import { lstatSync } from "node:fs";

import { sameDevIno } from "../../fs-identity.ts";

import type { StorePartition } from "../constants.ts";
import type { StoreRecord } from "../envelope.ts";
import { replacedShards, scanShard, shardScanGap, type Compaction } from "../reader.ts";
import { listShards } from "../shard-list.ts";
import { partitionDir, type StreamRef } from "../store-paths.ts";
import { hashRange } from "./stream-read.ts";

/** Where a read of one shard stopped. */
export interface ShardPosition {
  readonly partition: StorePartition;
  /** The stream folder: `events`, `log`, `ledgers/<name>`. */
  readonly stream: string;
  readonly device: string;
  /** The shard's partition-relative path, `/`-separated. */
  readonly shard: string;
  /** First byte not yet read: always the start of a line. */
  readonly offset: number;
  /** sha256 (hex) of bytes `0` to `offset` of the shard. */
  readonly prefix_hash: string;
}

export type ShardFromStatus = "read" | "gap" | "mismatch" | "replaced" | "missing";

/** One shard as {@link readShardsFrom} found it. */
export interface ShardFrom {
  readonly partition: StorePartition;
  readonly stream: string;
  readonly device: string;
  readonly shard: string;
  readonly status: ShardFromStatus;
  /** Verified records with a known body, in file order: after the position, or the whole shard for `mismatch`. */
  readonly records: ReadonlyArray<StoreRecord>;
  /** The position to record. For a `gap` and a `missing` shard, the one given. */
  readonly position: ShardPosition;
  /** Why the read missed records (a `gap`), or null. */
  readonly gap: string | null;
  /** For `replaced`: the shards the compaction wrote instead. */
  readonly into?: ReadonlyArray<string>;
}

export interface ReadShardsFromRequest {
  readonly root: string;
  readonly partitions: Iterable<StorePartition>;
  readonly streams: ReadonlyArray<StreamRef>;
  /** The positions recorded before; a shard not named starts at 0. */
  readonly positions: ReadonlyArray<ShardPosition>;
  /** The records the caller needs; absent, every record. */
  readonly keep?: (record: StoreRecord) => boolean;
}

export interface ShardsFromRead {
  /** Every listed shard of the streams, and every positioned one no longer listed, in path order per partition. */
  readonly shards: ReadonlyArray<ShardFrom>;
}

/** The prefix digest of a shard read from its start: the sha256 of no bytes. */
export const EMPTY_DIGEST = createHash("sha256").digest("hex");

/** The partition-relative folder of a stream: `events`, `ledgers/<name>`. */
function streamFolder(ref: StreamRef): string {
  return ref.ledger !== undefined ? `${ref.stream}/${ref.ledger}` : ref.stream;
}

function positionKey(partition: string, shard: string): string {
  return `${partition}/${shard}`;
}

/** The sha256 (hex) of bytes `0` to `offset` of a shard, or null when it holds fewer or is refused. */
export function shardPrefixDigest(
  path: string,
  partitionRoot: string,
  offset: number,
): string | null {
  return hashRange(path, partitionRoot, createHash("sha256"), 0, offset)?.digest("hex") ?? null;
}

/**
 * The boundary a set of positions draws, for a read with `until`: per
 * partition, the byte limit of each shard. A shard with no position is
 * beyond the boundary.
 */
export function untilOf(
  positions: ReadonlyArray<ShardPosition>,
): ReadonlyMap<StorePartition, ReadonlyMap<string, number>> {
  const out = new Map<StorePartition, Map<string, number>>();
  for (const p of positions) {
    let shards = out.get(p.partition);
    if (shards === undefined) {
      shards = new Map();
      out.set(p.partition, shards);
    }
    shards.set(p.shard, p.offset);
  }
  return out;
}

interface Scanned {
  readonly records: StoreRecord[];
  readonly compactions: ReadonlyArray<Compaction>;
  readonly gap: string | null;
  readonly nextOffset: number;
}

function scanFrom(
  path: string,
  partitionRoot: string,
  offset: number,
  keep: ((record: StoreRecord) => boolean) | undefined,
): Scanned {
  const records: StoreRecord[] = [];
  const scan = scanShard(path, { partitionRoot, ...(offset > 0 ? { offset } : {}) }, (r) => {
    if (r.bodyState === "pending") return;
    if (keep === undefined || keep(r.record)) records.push(r.record);
  });
  return {
    records,
    compactions: scan.compactions,
    gap: shardScanGap(scan),
    nextOffset: scan.nextOffset,
  };
}

/** Every shard of `request.streams` read from its recorded position. */
export function readShardsFrom(request: ReadShardsFromRequest): ShardsFromRead {
  const given = new Map<string, ShardPosition>();
  for (const p of request.positions) given.set(positionKey(p.partition, p.shard), p);
  const out: ShardFrom[] = [];
  for (const partition of request.partitions) {
    const partitionRoot = partitionDir(request.root, partition);
    for (const ref of request.streams) {
      const folder = streamFolder(ref);
      let shards: ReturnType<typeof listShards>;
      try {
        shards = listShards(partitionRoot, ref);
      } catch (err) {
        // A stream that cannot be listed: every positioned shard in it is
        // a gap, so nothing moves until the folder reads again.
        const reason = `the stream folder ${folder} cannot be listed: ${(err as Error).message}`;
        for (const p of given.values()) {
          if (p.partition !== partition || p.stream !== folder) continue;
          out.push({ ...identity(p), status: "gap", records: [], position: p, gap: reason });
        }
        continue;
      }
      const results: ShardFrom[] = [];
      const compactions: Compaction[] = [];
      const listed = new Set<string>();
      for (const shard of shards) {
        listed.add(shard.rel);
        const before =
          given.get(positionKey(partition, shard.rel)) ??
          ({
            partition,
            stream: folder,
            device: shard.device,
            shard: shard.rel,
            offset: 0,
            prefix_hash: EMPTY_DIGEST,
          } satisfies ShardPosition);
        const read = readOne(shard.path, partitionRoot, before, request.keep);
        compactions.push(...read.compactions);
        results.push(read.result);
      }
      const replaced = replacedShards(compactions);
      const intoOf = new Map<string, ReadonlyArray<string>>();
      for (const c of compactions) for (const rel of c.replaces) intoOf.set(rel, c.into);
      for (const result of results) {
        if (!replaced.has(result.shard) || result.status === "gap") {
          out.push(result);
          continue;
        }
        out.push({ ...result, status: "replaced", into: intoOf.get(result.shard) ?? [] });
      }
      // Positioned shards no longer listed: replaced, or missing.
      for (const p of given.values()) {
        if (p.partition !== partition || p.stream !== folder || listed.has(p.shard)) continue;
        const into = intoOf.get(p.shard);
        out.push({
          ...identity(p),
          status: into !== undefined ? "replaced" : "missing",
          records: [],
          position: p,
          gap: null,
          ...(into !== undefined ? { into } : {}),
        });
      }
    }
  }
  return { shards: out };
}

function identity(p: ShardPosition): Pick<ShardFrom, "partition" | "stream" | "device" | "shard"> {
  return { partition: p.partition, stream: p.stream, device: p.device, shard: p.shard };
}

function readOne(
  path: string,
  partitionRoot: string,
  before: ShardPosition,
  keep: ((record: StoreRecord) => boolean) | undefined,
): { readonly result: ShardFrom; readonly compactions: ReadonlyArray<Compaction> } {
  const gapResult = (reason: string): { result: ShardFrom; compactions: [] } => ({
    result: { ...identity(before), status: "gap", records: [], position: before, gap: reason },
    compactions: [],
  });
  let start: ReturnType<typeof lstatSync>;
  try {
    start = lstatSync(path, { bigint: true });
  } catch (err) {
    return gapResult(`the shard cannot be read: ${(err as Error).message}`);
  }
  // The recorded prefix, checked before anything is read from the offset.
  // Only a file shorter than the offset, or a prefix that hashes to
  // another digest, was rewritten; a prefix that could not be read (the
  // open or a read refused) is a gap: rebasing on it would take the
  // shard's late records as seen for good.
  let mismatch = false;
  if (before.offset > 0) {
    const digest = shardPrefixDigest(path, partitionRoot, before.offset);
    if (digest === null && start.size >= BigInt(before.offset)) {
      return gapResult("the shard cannot be read: its recorded prefix could not be read");
    }
    mismatch = digest !== before.prefix_hash;
  }
  const from = mismatch ? 0 : before.offset;
  let scanned: Scanned;
  try {
    scanned = scanFrom(path, partitionRoot, from, keep);
  } catch (err) {
    return gapResult(`the shard cannot be read: ${(err as Error).message}`);
  }
  if (scanned.gap !== null) {
    return {
      result: {
        ...identity(before),
        status: "gap",
        records: [],
        position: before,
        gap: scanned.gap,
      },
      compactions: scanned.compactions,
    };
  }
  // The new digest, and proof that the file read is the file hashed.
  const digest = shardPrefixDigest(path, partitionRoot, scanned.nextOffset);
  let after: ReturnType<typeof lstatSync> | null = null;
  try {
    after = lstatSync(path, { bigint: true });
  } catch {
    after = null;
  }
  if (digest === null || after === null || !sameDevIno(start, after)) {
    return gapResult("the shard changed while it was read");
  }
  return {
    result: {
      ...identity(before),
      status: mismatch ? "mismatch" : "read",
      records: scanned.records,
      position: { ...before, offset: scanned.nextOffset, prefix_hash: digest },
      gap: null,
    },
    compactions: scanned.compactions,
  };
}
