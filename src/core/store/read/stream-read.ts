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

import { BLOB_REF_KEY, type StorePartition } from "../constants.ts";
import type { StoreRecord } from "../envelope.ts";
import { isBlobRef } from "../envelope.ts";
import { readShard, replacedShards, shardReadGap, type Compaction } from "../reader.ts";
import { trackSeenShards } from "../seen-shards.ts";
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
   * Whether a skipped pending record named no blob (`pendingBlobs` cannot
   * cover it), so a caching caller has no stamp for its arrival and must
   * not cache the read.
   */
  readonly pendingUnkeyed: boolean;
}

export interface StreamReadOptions {
  /** Read only the shards this device wrote. */
  readonly device?: string;
  /** Read only shards whose month (`YYYY-MM`) passes this test. */
  readonly month?: (month: string) => boolean;
}

/** Month of a shard file name, `<YYYY-MM>[.<suffix>].jsonl`. */
function monthOf(rel: string): string {
  const name = rel.slice(rel.lastIndexOf("/") + 1);
  return name.slice(0, 7);
}

/**
 * The blob name a pending record's body still holds (the sha the blob is
 * stored under), or `null` when the pending body is no blob reference
 * (a partition root the read could not resolve bodies against).
 */
function blobRefSha(body: StoreRecord["body"]): string | null {
  if (!isBlobRef(body)) return null;
  const sha = body[BLOB_REF_KEY];
  return typeof sha === "string" ? sha : null;
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
      pendingUnkeyed: false,
    };
  }
  const compactions: Compaction[] = [];
  let skippedPending = false;
  let pendingUnkeyed = false;
  for (const shard of shards) {
    if (options.device !== undefined && shard.device !== options.device) continue;
    if (options.month !== undefined && !options.month(monthOf(shard.rel))) continue;
    let read: ReturnType<typeof readShard>;
    try {
      read = readShard(shard.path, { partitionRoot });
    } catch {
      unreadable.push(shard.rel);
      continue;
    }
    if (read.diagnostics.some((d) => d.kind === "not-a-file")) {
      unreadable.push(shard.rel);
      continue;
    }
    if (shardReadGap(read) !== null) unreadable.push(shard.rel);
    compactions.push(...read.compactions);
    for (const entry of read.records) {
      if (entry.bodyState !== "pending") {
        records.push(entry.record);
        continue;
      }
      // The body is still the blob reference (reader.ts): the sha names
      // the blob the caller stats for availability.
      skippedPending = true;
      const sha = blobRefSha(entry.record.body);
      if (sha === null) pendingUnkeyed = true;
      else if (!pendingBlobs.includes(sha)) pendingBlobs.push(sha);
    }
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
    pendingUnkeyed,
  };
}
