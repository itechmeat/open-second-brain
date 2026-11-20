/**
 * Read the records of one stream of one partition, for the store-backed
 * read facades and the store-only predicate (design D14, task 2.10).
 *
 * A thin layer over the shard listing and the shard reader: every shard of
 * the stream (optionally only one device's), every verified record whose
 * body is known. A record whose body is still a pending blob is left out,
 * as a fold leaves it out (FORMAT.md, "Order and folds"); a shard the
 * reader cannot open is skipped and named to the caller, never thrown,
 * so one unreadable file never hides the rest of the store. A shard this
 * machine read before that is gone now (`seen-shards.ts`) is named the
 * same way, and so is a shard read only in part (`shardReadGap`: a
 * pending blob, a bad line in the middle, a newer format), whose readable
 * records are still returned. The records of a named shard are unknown,
 * not absent, so a caller whose answer decides a protection fails closed
 * on any.
 *
 * Nothing here writes: no store is created, no partition copy refreshed.
 */

import { createHash, type Hash } from "node:crypto";
import { type BigIntStats, closeSync, lstatSync, readSync } from "node:fs";

import { sameDevIno } from "../../fs-identity.ts";

import { BLOB_REF_KEY, type StorePartition } from "../constants.ts";
import type { StoreRecord } from "../envelope.ts";
import {
  replacedShards,
  scanShard,
  shardScanGap,
  type Compaction,
  type ReadRecord,
  type ShardDiagnostic,
  type ShardScan,
} from "../reader.ts";
import { appendedByThisProcess, type AppendStamp } from "../own-appends.ts";
import { gcHintTick } from "../gc-hint.ts";
import { trackSeenShards } from "../seen-shards.ts";
import { openRegularFileForRead } from "../safe-fs.ts";
import { listShards } from "../shard-list.ts";
import { partitionDir, type StreamRef } from "../store-paths.ts";

/** What one stream read found. */
export interface StreamRead {
  /** Verified records with a known body, shard by shard in path order. */
  readonly records: ReadonlyArray<StoreRecord>;
  /**
   * Partition-relative paths of shards that could not be read, that were
   * read only in part (their readable records are in `records`), or that
   * this machine read before and that are gone now.
   */
  readonly unreadable: ReadonlyArray<string>;
  /**
   * Whether a record was left out because its body is still a pending
   * blob. A quarantined pending blob opens no gap, so `unreadable` does
   * not name its shard; and when the blob arrives, neither the shard's
   * bytes nor the quarantine ledger change. A caller that caches a read
   * on those stamps caches it against the availability of `pendingBlobs`
   * instead: the fingerprint moves the moment a blob is delivered, so the
   * read is rebuilt then and stays cached while every one is absent.
   */
  readonly skippedPending: boolean;
  /**
   * Blob names (the sha a blob is stored under, `blobPath`) of the records
   * left out because their body is a pending blob, in shard order without
   * duplicates. The identities a caching caller stats, one per skipped
   * record, instead of rescanning the shards.
   */
  readonly pendingBlobs: ReadonlyArray<string>;
  /**
   * How many kept records were left out because their body is a pending
   * blob, by envelope kind (the kind is read from the line, not the
   * body). A caller that must know whether a record of some kind is
   * missing from `records` reads it from the same scan, so no later
   * arrival of a blob can fall between the two answers.
   */
  readonly pendingKinds: ReadonlyMap<string, number>;
}

export interface StreamReadOptions {
  /** Read only the shards this device wrote. */
  readonly device?: string;
  /** Read only shards whose month (`YYYY-MM`) passes this test. */
  readonly month?: (month: string) => boolean;
  /**
   * What earlier reads of this stream in this process kept of each shard
   * (keyed by the shard's partition-relative path), so only what was
   * appended since is parsed and verified: see {@link ShardTails}. Read and
   * updated in place; absent, every shard is read whole.
   */
  readonly tails?: ShardTails;
  /**
   * The records the caller needs, judged by envelope as each is read: the
   * rest are never held (pending ones are still counted for the gap and
   * named when kept). Absent, every record.
   */
  readonly keep?: (record: StoreRecord) => boolean;
  /**
   * A cooperative deadline (a hook's `Safeguard.checkpoint`), called before
   * each shard and at each record boundary. What it throws stops the read
   * and reaches the caller as it is, never taken for an unreadable shard;
   * a shard it stopped keeps the tail it had.
   */
  readonly checkpoint?: () => void;
}

/** A checkpoint's throw on its way out of a shard scan. */
class StreamReadInterrupted {
  constructor(readonly cause: unknown) {}
}

/**
 * What a read kept of one shard it read whole and clean (no diagnostic, no
 * pending body, no held-back last line), to read only what was appended to
 * it next time: the records its caller keeps (`StreamReadOptions.keep`),
 * never the whole parsed shard.
 */
export interface ShardTail {
  /** Device and inode as `bigint` (`fs-identity.ts`: NTFS ids exceed 2^53). */
  readonly ino: bigint;
  readonly dev: bigint;
  /** Bytes read: every complete line, up to and including the last newline. */
  readonly size: number;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
  /** sha256 state of those bytes, extended by the next read. */
  readonly hash: Hash;
  /** The records the read kept, in file order. */
  readonly records: ReadonlyArray<ReadRecord>;
  readonly compactions: ReadonlyArray<Compaction>;
}

/**
 * The shards of one stream of one partition a caller has read before in
 * this process (`StreamReadOptions.tails`). A shard is append-only, and a
 * writer that appends to it changes its size and mtime, so a reader that
 * re-reads a stream after every write (a pass that writes and reads the
 * same fold many times) would otherwise parse and verify the whole stream
 * once per write. With a tail kept:
 *
 *  - a shard whose inode, device, size, mtime and ctime are all unchanged
 *    is not opened: the kept read answers;
 *  - a shard with the same inode that is no shorter is read from where the
 *    kept read ended when the bytes before are known unchanged: appends of
 *    this process alone took it from the kept stamp to the current one
 *    (`own-appends.ts`), or the sha256 of those bytes still matches the
 *    kept one (the prefix is hashed, not parsed);
 *  - anything else (another inode, a shorter file, a changed prefix, no
 *    usable inode) is read whole, and a read with a problem is not kept.
 *
 * A tail holds only the records its caller keeps, so the bound is what
 * the caller's fold holds anyway, not a parsed copy of the stream.
 */
export type ShardTails = Map<string, ShardTail>;

/** Chunk size the checksum reads in. */
const PREFIX_CHUNK_BYTES = 1 << 20;

/**
 * `hash` extended with bytes `from` to `to` of the file at `path`, or
 * null when the file holds fewer or is refused. Opened through the guarded
 * opener (`safe-fs.ts`): a link or a FIFO swapped in under the name after
 * the caller's lstat is refused, never followed or blocked on.
 */
function hashRange(
  path: string,
  partitionRoot: string,
  hash: Hash,
  from: number,
  to: number,
): Hash | null {
  let fd: number | null;
  try {
    fd = openRegularFileForRead(path, partitionRoot);
  } catch {
    return null;
  }
  if (fd === null) return null;
  try {
    const chunk = Buffer.alloc(Math.min(PREFIX_CHUNK_BYTES, Math.max(to - from, 1)));
    let position = from;
    while (position < to) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, to - position), position);
      if (n === 0) return null;
      hash.update(chunk.subarray(0, n));
      position += n;
    }
  } finally {
    closeSync(fd);
  }
  return hash;
}

function sameStamp(a: BigIntStats, b: BigIntStats): boolean {
  return (
    sameDevIno(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs
  );
}

/** What an append saw of a shard (`own-appends.ts`), from `bigint` stats. */
function appendStampOf(stat: BigIntStats): AppendStamp {
  return { size: Number(stat.size), mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

/** One shard as a stream read sees it: what it kept, and what decides its health. */
interface ShardPass {
  readonly records: ReadonlyArray<ReadRecord>;
  readonly compactions: ReadonlyArray<Compaction>;
  readonly diagnostics: ReadonlyArray<ShardDiagnostic>;
  /** Pending records not quarantined, kept or not: they open a gap. */
  readonly gapPending: number;
  /** Pending records, quarantined or not: a read with one is never kept. */
  readonly anyPending: number;
  readonly nextOffset: number;
  readonly pendingTailBytes: number;
}

/** Scan `path` from `offset`, keeping the records `keep` passes. */
function scanKeeping(
  path: string,
  partitionRoot: string,
  offset: number,
  keep: ((record: StoreRecord) => boolean) | undefined,
  checkpoint?: () => void,
): ShardPass {
  const records: ReadRecord[] = [];
  let anyPending = 0;
  const scan = scanShard(path, { partitionRoot, ...(offset > 0 ? { offset } : {}) }, (r) => {
    if (checkpoint !== undefined) {
      try {
        checkpoint();
      } catch (err) {
        throw new StreamReadInterrupted(err);
      }
    }
    // A record the caller does not keep is garbage at once (`gc-hint.ts`).
    gcHintTick();
    if (r.bodyState === "pending") anyPending += 1;
    if (keep === undefined || keep(r.record)) records.push(r);
  });
  return {
    records,
    compactions: scan.compactions,
    diagnostics: scan.diagnostics,
    gapPending: scan.pending,
    anyPending,
    nextOffset: scan.nextOffset,
    pendingTailBytes: scan.pendingTailBytes,
  };
}

/** The gap a pass opens (`shardScanGap`), or null. */
function gapOf(pass: ShardPass): string | null {
  const scan: Pick<ShardScan, "diagnostics" | "pending"> = {
    diagnostics: pass.diagnostics,
    pending: pass.gapPending,
  };
  return shardScanGap(scan as ShardScan);
}

function isCleanPass(pass: ShardPass): boolean {
  return pass.diagnostics.length === 0 && pass.pendingTailBytes === 0 && pass.anyPending === 0;
}

/** One shard read through the caller's kept tails (see {@link ShardTails}). */
function readShardWithTails(
  path: string,
  rel: string,
  partitionRoot: string,
  tails: ShardTails,
  keep: ((record: StoreRecord) => boolean) | undefined,
  checkpoint?: () => void,
): ShardPass {
  const kept = tails.get(rel);
  let base: ShardTail | null = null;
  // lstat: a link swapped in under the name has an inode of its own. Taken
  // before the read too, so a read is kept only when the file did not
  // change from before the read to after its checksum.
  const now = lstatSync(path, { bigint: true });
  let hash: Hash | null = null;
  if (kept !== undefined) {
    const size = Number(now.size);
    if (sameDevIno(now, kept) && size >= kept.size) {
      if (size === kept.size && now.mtimeNs === kept.mtimeNs && now.ctimeNs === kept.ctimeNs) {
        return {
          records: kept.records,
          compactions: kept.compactions,
          diagnostics: [],
          gapPending: 0,
          anyPending: 0,
          nextOffset: kept.size,
          pendingTailBytes: 0,
        };
      }
      if (
        appendedByThisProcess(
          path,
          { size: kept.size, mtimeNs: kept.mtimeNs, ctimeNs: kept.ctimeNs },
          appendStampOf(now),
        )
      ) {
        base = kept;
      } else {
        const check = hashRange(path, partitionRoot, createHash("sha256"), 0, kept.size);
        if (check !== null && check.copy().digest("hex") === kept.hash.copy().digest("hex")) {
          base = kept;
        }
      }
    }
  }
  const fresh = scanKeeping(path, partitionRoot, base?.size ?? 0, keep, checkpoint);
  tails.delete(rel);
  const after = lstatSync(path, { bigint: true });
  // The suffix is combined with the kept prefix only when it came from the
  // file the prefix was checked against: a shard replaced under its name
  // after the check and before the read would pair another file's lines
  // with the kept records. Then the combination is dropped and the shard
  // is read whole, as with no kept tail.
  if (base !== null && !sameDevIno(after, now)) {
    return scanKeeping(path, partitionRoot, 0, keep, checkpoint);
  }
  const pass: ShardPass =
    base === null
      ? fresh
      : {
          ...fresh,
          records: [...base.records, ...fresh.records],
          compactions: [...base.compactions, ...fresh.compactions],
        };
  if (!isCleanPass(pass)) return pass;
  // Kept only when the file is the same from before the read to after the
  // checksum (inode, device, size, mtime, ctime): a write or a same-size
  // replacement landing anywhere in between leaves it unkept, and the
  // next read reads it whole.
  if (after.ino === 0n || Number(after.size) !== pass.nextOffset || !sameStamp(now, after)) {
    return pass;
  }
  hash =
    base === null
      ? hashRange(path, partitionRoot, createHash("sha256"), 0, pass.nextOffset)
      : hashRange(path, partitionRoot, base.hash.copy(), base.size, pass.nextOffset);
  if (hash === null || !sameStamp(after, lstatSync(path, { bigint: true }))) return pass;
  tails.set(rel, {
    ino: after.ino,
    dev: after.dev,
    size: pass.nextOffset,
    mtimeNs: after.mtimeNs,
    ctimeNs: after.ctimeNs,
    hash,
    records: pass.records,
    compactions: pass.compactions,
  });
  return pass;
}

/** Month of a shard file name, `<YYYY-MM>[.<suffix>].jsonl`. */
function monthOf(rel: string): string {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return name.slice(0, 7);
}

/**
 * The blob name a pending record's body still holds (the sha the blob is
 * stored under). `resolveBody` marks a body pending only for a blob
 * reference, whose key is always a string (`isBlobRef`), so every pending
 * entry has one.
 */
function blobRefSha(body: StoreRecord["body"]): string {
  return body[BLOB_REF_KEY] as string;
}

/** The partition-relative folder of a stream: `events`, `ledgers/<name>`. */
function streamPrefix(ref: StreamRef): string {
  return ref.ledger !== undefined ? `${ref.stream}/${ref.ledger}` : ref.stream;
}

/** Every record of `ref` in `partition` under the store at `root`. */
export function readStreamRecords(
  root: string,
  partition: StorePartition,
  ref: StreamRef,
  options: StreamReadOptions = {},
): StreamRead {
  const partitionRoot = partitionDir(root, partition);
  const records: StoreRecord[] = [];
  const unreadable: string[] = [];
  const pendingBlobs: string[] = [];
  let shards: ReturnType<typeof listShards>;
  try {
    shards = listShards(partitionRoot, ref);
  } catch {
    // A stream that cannot be listed (its folder, or any device folder
    // below it: EACCES, EBUSY) is named whole, as an unreadable shard is,
    // and none of its shards is read; the other streams still read.
    return {
      records,
      unreadable: [streamPrefix(ref)],
      skippedPending: false,
      pendingBlobs: [],
      pendingKinds: new Map(),
    };
  }
  const compactions: Compaction[] = [];
  let skippedPending = false;
  const pendingKinds = new Map<string, number>();
  const seenBlobs = new Set<string>();
  for (const shard of shards) {
    if (options.device !== undefined && shard.device !== options.device) continue;
    if (options.month !== undefined && !options.month(monthOf(shard.rel))) continue;
    options.checkpoint?.();
    let read: ShardPass;
    try {
      read =
        options.tails === undefined
          ? scanKeeping(shard.path, partitionRoot, 0, options.keep, options.checkpoint)
          : readShardWithTails(
              shard.path,
              shard.rel,
              partitionRoot,
              options.tails,
              options.keep,
              options.checkpoint,
            );
    } catch (err) {
      if (err instanceof StreamReadInterrupted) throw err.cause;
      options.tails?.delete(shard.rel);
      unreadable.push(shard.rel);
      continue;
    }
    if (read.diagnostics.some((d) => d.kind === "not-a-file")) {
      unreadable.push(shard.rel);
      continue;
    }
    if (gapOf(read) !== null) unreadable.push(shard.rel);
    compactions.push(...read.compactions);
    for (const entry of read.records) {
      if (entry.bodyState !== "pending") {
        records.push(entry.record);
        continue;
      }
      // The body is still the blob reference (reader.ts): the sha names
      // the blob the caller stats for availability.
      skippedPending = true;
      pendingKinds.set(entry.record.kind, (pendingKinds.get(entry.record.kind) ?? 0) + 1);
      const sha = blobRefSha(entry.record.body);
      if (!seenBlobs.has(sha)) {
        seenBlobs.add(sha);
        pendingBlobs.push(sha);
      }
    }
  }
  // A shard no longer listed (compacted away, removed) keeps nothing.
  if (options.tails !== undefined && options.device === undefined && options.month === undefined) {
    const listed = new Set(shards.map((shard) => shard.rel));
    for (const rel of options.tails.keys()) if (!listed.has(rel)) options.tails.delete(rel);
  }
  const gone = trackSeenShards(
    partitionRoot,
    {
      prefix: `${streamPrefix(ref)}/`,
      ...(options.device !== undefined ? { device: options.device } : {}),
      ...(options.month !== undefined ? { month: options.month } : {}),
    },
    shards.map((shard) => shard.rel),
    replacedShards(compactions),
  );
  return {
    records,
    unreadable: [...unreadable, ...gone],
    skippedPending,
    pendingBlobs,
    pendingKinds,
  };
}
