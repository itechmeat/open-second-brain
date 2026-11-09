/**
 * Per-partition state digests over explicit cuts (design D6, task 1.7):
 * the cut, the fold hashes, and publishing a digest record.
 *
 * A cut says exactly which records a digest covers: one entry per shard
 * this machine holds in the partition, excluding the `digests` stream, so
 * publishing a digest never changes the cut it is compared on:
 *
 * ```
 * { "shard": "<partition-relative path>", "count": <verified records>,
 *   "last": "<id of the last record>", "pending": <records whose blob has not arrived> }
 * ```
 *
 * `pending` is part of the cut because a record whose body is still a
 * missing blob cannot be folded yet: two machines with the same records
 * but a blob present on only one of them have different cuts and are not
 * compared, rather than reported as divergent. Shards with no verified
 * record yet (only a torn first line) are left out.
 *
 * The digest hashes each fold (`STATE_DIGEST_FOLDS`) computed from exactly
 * the records in the cut: sha256 of the canonical JSON of the fold's
 * fingerprint. Two machines with identical cuts must have identical fold
 * hashes; `state-digest-compare.ts` reports when they do not.
 */

import { readdirSync } from "node:fs";
import { join } from "node:path";

import { canonicalJson, sha256Hex } from "../integrity/digest.ts";
import { compareCodeUnits } from "./compare.ts";
import { appendRecord, type AppendResult } from "./appender.ts";
import { observeClock, type WallClock } from "./clock-store.ts";
import {
  DAY_MS,
  LEDGER_STREAM,
  STATE_DIGEST_KIND,
  STORE_STREAMS,
  type StateDigestFold,
  type StorePartition,
  type StoreStream,
} from "./constants.ts";
import { compareRecords, type StoreRecord } from "./envelope.ts";
import { foldPinned, pinnedFingerprint } from "./fold-pinned.ts";
import { foldPreferences, preferencesFingerprint } from "./fold-preferences.ts";
import { foldSettings, settingsFingerprint } from "./fold-settings.ts";
import { parseHlc } from "./hlc.ts";
import { readShard, replacedShards, shardReadGap, type Compaction } from "./reader.ts";
import { SEEN_SHARD_MISSING_REASON, trackSeenShards } from "./seen-shards.ts";
import { listShards } from "./shard-list.ts";
import type { StoreHandle } from "./store-open.ts";
import { LEDGER_NAME_RE, partitionDir, type StreamRef } from "./store-paths.ts";

/** The stream digests are published in, and which every cut leaves out. */
export const DIGEST_STREAM: StoreStream = "digests";

/** One shard as this machine has read it. */
export interface PartitionShard {
  /** Partition-relative path, `/`-separated. */
  readonly rel: string;
  readonly device: string;
  readonly stream: StoreStream;
  /** Records with a known body, in file order. */
  readonly records: ReadonlyArray<StoreRecord>;
  /** Records whose body is a blob that has not arrived yet, in file order. */
  readonly pending: ReadonlyArray<StoreRecord>;
  /** Every verified record, in file order (`records` and `pending` interleaved). */
  readonly all: ReadonlyArray<StoreRecord>;
  /** Bytes after the last verified line that the reader held back (a torn or unverified tail). */
  readonly heldTailBytes: number;
}

/** A shard {@link readPartition} could not read. */
export interface UnreadableShard {
  /** Partition-relative path, `/`-separated. */
  readonly rel: string;
  readonly path: string;
  readonly error: unknown;
  /**
   * The shard was read, but only in part (`shardReadGap`: a pending blob,
   * a bad line in the middle, a newer format): it is still in the read,
   * with the records that could be read. Absent when nothing of it was.
   */
  readonly incomplete?: true;
}

export interface ReadPartitionOptions {
  /**
   * Called for a shard that cannot be read (a sync client's lock, a
   * permission), and for a shard this machine read before that is gone
   * now (`seen-shards.ts`). The shard is then left out and the others are
   * still read. Without it the first read error is thrown, and a shard
   * gone since it was seen is left out unnamed.
   *
   * Also called, with `incomplete`, for a shard read only in part; that
   * shard stays in the read. A caller that decides a protection treats it
   * as unread; a caller that only needs the cut may skip it.
   */
  readonly onUnreadable?: (shard: UnreadableShard) => void;
}

export interface CutEntry {
  readonly shard: string;
  readonly count: number;
  readonly last: string;
  readonly pending: number;
}

/** Fold name to sha256. */
export type FoldHashes = { readonly [F in StateDigestFold]: string };

/** The body of a `state-digest` record. */
export interface DigestBody {
  readonly partition: StorePartition;
  readonly cut: ReadonlyArray<CutEntry>;
  readonly cut_hash: string;
  readonly folds: FoldHashes;
}

function ledgerNames(partitionRoot: string): string[] {
  try {
    return readdirSync(join(partitionRoot, LEDGER_STREAM), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && LEDGER_NAME_RE.test(entry.name))
      .map((entry) => entry.name)
      .toSorted();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

function streamRefs(partitionRoot: string): Array<StreamRef & { stream: StoreStream }> {
  const refs: Array<StreamRef & { stream: StoreStream }> = [];
  for (const stream of STORE_STREAMS) {
    if (stream === LEDGER_STREAM) {
      for (const ledger of ledgerNames(partitionRoot)) refs.push({ stream, ledger });
    } else {
      refs.push({ stream });
    }
  }
  return refs;
}

/**
 * Read every shard of every stream in a partition (digests included),
 * sorted by relative path. Torn or unverified tails are held back by the
 * reader and are not part of this read; each shard says how many bytes it
 * held back.
 */
export function readPartition(
  partitionRoot: string,
  options: ReadPartitionOptions = {},
): PartitionShard[] {
  const out: PartitionShard[] = [];
  const listed: string[] = [];
  const compactions: Compaction[] = [];
  for (const ref of streamRefs(partitionRoot)) {
    for (const shard of listShards(partitionRoot, ref)) {
      listed.push(shard.rel);
      let read: ReturnType<typeof readShard>;
      try {
        read = readShard(shard.path, { partitionRoot });
      } catch (error) {
        if (options.onUnreadable === undefined) throw error;
        options.onUnreadable({ rel: shard.rel, path: shard.path, error });
        continue;
      }
      // A link or special file under a shard name holds no record here; the
      // caller that asks hears of it rather than seeing an empty shard.
      const notAFile = read.diagnostics.find((d) => d.kind === "not-a-file");
      if (notAFile !== undefined && options.onUnreadable !== undefined) {
        options.onUnreadable({
          rel: shard.rel,
          path: shard.path,
          error: new Error(notAFile.reason),
        });
        continue;
      }
      const gap = shardReadGap(read);
      if (gap !== null) {
        options.onUnreadable?.({
          rel: shard.rel,
          path: shard.path,
          error: new Error(`the shard was read only in part: ${gap}`),
          incomplete: true,
        });
      }
      compactions.push(...read.compactions);
      const all = read.records.map((r) => r.record);
      out.push({
        rel: shard.rel,
        device: shard.device,
        stream: ref.stream,
        all,
        records: read.records.filter((r) => r.bodyState !== "pending").map((r) => r.record),
        pending: read.records.filter((r) => r.bodyState === "pending").map((r) => r.record),
        heldTailBytes: read.pendingTailBytes,
      });
    }
  }
  for (const rel of trackSeenShards(
    partitionRoot,
    { prefix: "" },
    listed,
    replacedShards(compactions),
  )) {
    options.onUnreadable?.({
      rel,
      path: join(partitionRoot, ...rel.split("/")),
      error: new Error(SEEN_SHARD_MISSING_REASON),
    });
  }
  return out.toSorted((a, b) => compareCodeUnits(a.rel, b.rel));
}

/** The shards a cut covers: every stream but the digests. */
export function cutShards(shards: ReadonlyArray<PartitionShard>): PartitionShard[] {
  return shards.filter((shard) => shard.stream !== DIGEST_STREAM && shard.all.length > 0);
}

/** The cut of the given shards, sorted by shard path. */
export function computeCut(shards: ReadonlyArray<PartitionShard>): CutEntry[] {
  return cutShards(shards)
    .map((shard) => ({
      shard: shard.rel,
      count: shard.all.length,
      last: shard.all[shard.all.length - 1]!.id,
      pending: shard.pending.length,
    }))
    .toSorted((a, b) => compareCodeUnits(a.shard, b.shard));
}

/** sha256 of the canonical JSON of a cut: equal cuts, equal hashes. */
export function cutHash(cut: ReadonlyArray<CutEntry>): string {
  return sha256Hex(canonicalJson(cut));
}

const hash = (value: unknown): string => sha256Hex(canonicalJson(value));

/** The hash of each digested fold, computed from exactly `records`. */
export function foldHashes(records: ReadonlyArray<StoreRecord>): FoldHashes {
  return {
    preferences: hash(preferencesFingerprint(foldPreferences(records))),
    pinned: hash(pinnedFingerprint(foldPinned(records))),
    settings: hash(settingsFingerprint(foldSettings(records))),
  };
}

/** The digest body of a partition as read in `shards`. */
export function buildDigestBody(
  partition: StorePartition,
  shards: ReadonlyArray<PartitionShard>,
): DigestBody {
  const cut = computeCut(shards);
  const covered = cutShards(shards).flatMap((shard) => shard.records);
  return { partition, cut, cut_hash: cutHash(cut), folds: foldHashes(covered) };
}

export interface PublishDigestOptions {
  readonly partition: StorePartition;
  /** Agent identity written on the digest record. */
  readonly agent: string;
  readonly now?: WallClock;
  /**
   * Skip publishing when this device's latest digest in the partition has
   * the same cut and fold hashes and is younger than this (default one
   * day), so frequent catch-ups do not grow the digests stream while an
   * idle device still publishes often enough not to look silent.
   */
  readonly minIntervalMs?: number;
}

export type PublishDigestResult =
  | { readonly published: true; readonly body: DigestBody; readonly append: AppendResult }
  | { readonly published: false; readonly body: DigestBody; readonly reason: "unchanged" };

function latestOwnDigest(
  shards: ReadonlyArray<PartitionShard>,
  device: string,
): StoreRecord | null {
  const own = shards
    .filter((shard) => shard.stream === DIGEST_STREAM && shard.device === device)
    .flatMap((shard) => shard.records)
    .filter((record) => record.kind === STATE_DIGEST_KIND)
    .toSorted(compareRecords);
  return own.at(-1) ?? null;
}

/**
 * Catch up on a partition this machine holds and publish its digest as a
 * `state-digest` record in the partition's `digests` stream. The local
 * clock first observes every record read (receive rule), so the digest
 * orders after everything it covers.
 */
export function publishStateDigest(
  store: StoreHandle,
  options: PublishDigestOptions,
): PublishDigestResult {
  const now = options.now ?? (() => Date.now());
  const shards = readPartition(partitionDir(store.root, options.partition));
  const body = buildDigestBody(options.partition, shards);
  const latest = latestOwnDigest(shards, store.device);
  if (latest !== null) {
    const age = now() - parseHlc(latest.hlc)!.physical;
    const same =
      latest.body["cut_hash"] === body.cut_hash &&
      canonicalJson(latest.body["folds"]) === canonicalJson(body.folds);
    if (same && age < (options.minIntervalMs ?? DAY_MS)) {
      return { published: false, body, reason: "unchanged" };
    }
  }
  // The newest record by fold order: one linear scan, no sort.
  let newest: StoreRecord | undefined;
  for (const shard of shards) {
    for (const record of shard.all) {
      if (newest === undefined || compareRecords(record, newest) > 0) newest = record;
    }
  }
  if (newest !== undefined) {
    observeClock(store.deviceStateDir, store.device, parseHlc(newest.hlc)!, now);
  }
  const append = appendRecord(
    store,
    {
      partition: options.partition,
      stream: DIGEST_STREAM,
      kind: STATE_DIGEST_KIND,
      agent: options.agent,
      body: { ...body },
    },
    { now },
  );
  return { published: true, body, append };
}
