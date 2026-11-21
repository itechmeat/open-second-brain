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
import { gcHintTick } from "./gc-hint.ts";
import { appendRecord, type AppendResult } from "./appender.ts";
import { observeClock, type WallClock } from "./clock-store.ts";
import {
  DAY_MS,
  LEDGER_STREAM,
  PINNED_CLEAR_KIND,
  PINNED_SET_KIND,
  PREFERENCE_EVIDENCE_KIND,
  PREFERENCE_REMOVE_KIND,
  PREFERENCE_SET_KIND,
  SETTING_ENTRY_KIND,
  SETTING_SET_KIND,
  SETTING_UNSET_KIND,
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
import { foldTopics, topicsFingerprint } from "../topics/fold.ts";
import { isTopicRecordKind } from "../topics/records.ts";
import { parseHlc } from "./hlc.ts";
import {
  replacedShards,
  scanShard,
  shardScanGap,
  type Compaction,
  type ShardScan,
} from "./reader.ts";
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
  /**
   * {@link forEachPartitionShard} only: true for a shard the caller already
   * holds what it needs of (it compares the file's stamp): the shard is not
   * read and not handed on. Such a read names no shard as missing.
   */
  readonly reuse?: (shard: { readonly rel: string; readonly path: string }) => boolean;
}

export interface CutEntry {
  readonly shard: string;
  readonly count: number;
  readonly last: string;
  readonly pending: number;
}

/** Fold name to sha256. */
export type FoldHashes = { readonly [F in StateDigestFold]: string };

/** The fold hashes a parsed digest carries: `topics` is absent in an older release's digest. */
export type ParsedFoldHashes = Omit<FoldHashes, "topics"> & { readonly topics?: string };

/** The body of a `state-digest` record. */
export interface DigestBody {
  readonly partition: StorePartition;
  readonly cut: ReadonlyArray<CutEntry>;
  readonly cut_hash: string;
  readonly folds: ParsedFoldHashes;
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

/** Every stream of a partition, one ref per ledger for `ledgers`, in stream order. */
export function streamRefs(partitionRoot: string): Array<StreamRef & { stream: StoreStream }> {
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
  forEachPartitionShard(partitionRoot, options, (shard) => out.push(shard));
  return out;
}

/** A throw of a record visitor, told apart from a failure to read the shard. */
class VisitorFailure {
  constructor(readonly cause: unknown) {}
}

/** Where one shard of a partition sits, before its records are read. */
export interface PartitionShardHead {
  /** Partition-relative path, `/`-separated. */
  readonly rel: string;
  readonly device: string;
  readonly stream: StoreStream;
}

/** What a streamed read of one shard saw, without its records. */
export interface PartitionShardTotals extends PartitionShardHead {
  /** Verified records, pending ones included. */
  readonly count: number;
  /** Records whose body is a blob that has not arrived yet. */
  readonly pending: number;
  /** The id of the last verified record, in file order; null for none. */
  readonly last: string | null;
  /** Bytes after the last verified line that the reader held back. */
  readonly heldTailBytes: number;
}

/** What {@link forEachPartitionRecord} hands on. */
export interface PartitionRecordVisitor {
  /** Each verified record, in file order; `pending` when its body is a blob not arrived. */
  readonly record?: (shard: PartitionShardHead, record: StoreRecord, pending: boolean) => void;
  /** Each shard read to its end, after its records (and after an `incomplete` report). */
  readonly shard?: (totals: PartitionShardTotals) => void;
}

/**
 * {@link readPartition} one shard at a time, in the same order (sorted by
 * relative path): `onShard` gets each shard as it is read and the read
 * keeps none of them, so a caller that needs only some of each shard's
 * records (their ids and checksums, the marked ones) never holds the
 * whole partition at once.
 */
export function forEachPartitionShard(
  partitionRoot: string,
  options: ReadPartitionOptions,
  onShard: (shard: PartitionShard) => void,
): void {
  let all: StoreRecord[] = [];
  let records: StoreRecord[] = [];
  let pending: StoreRecord[] = [];
  let at: string | null = null;
  forEachPartitionRecord(partitionRoot, options, {
    record: (head, record, isPending) => {
      // A shard whose read failed part way is never handed on: its
      // records so far are dropped with the next shard's first record.
      if (at !== head.rel) {
        all = [];
        records = [];
        pending = [];
        at = head.rel;
      }
      all.push(record);
      (isPending ? pending : records).push(record);
    },
    shard: (totals) => {
      const mine = at === totals.rel;
      onShard({
        rel: totals.rel,
        device: totals.device,
        stream: totals.stream,
        all: mine ? all : [],
        records: mine ? records : [],
        pending: mine ? pending : [],
        heldTailBytes: totals.heldTailBytes,
      });
      all = [];
      records = [];
      pending = [];
      at = null;
    },
  });
}

/**
 * The partition read one RECORD at a time, in {@link readPartition}'s
 * order: the read keeps no record, not even one shard's. A store's busiest
 * shard (this device's `log` shard of the month it migrated) can hold
 * every record a migration imported, so a caller that needs only part of
 * each record (an id and checksum, a mark, a device's newest clock) reads
 * the store in memory that does not grow with it.
 *
 * The shards the read cannot see in full are reported as
 * {@link forEachPartitionShard} reports them. A shard whose read fails
 * part way (an I/O error) has handed on the records before the failure
 * and is then named unreadable; its `shard` call never comes. A throw of
 * the visitor itself is no unreadable shard: it ends the walk and reaches
 * the caller as it was thrown.
 */
export function forEachPartitionRecord(
  partitionRoot: string,
  options: ReadPartitionOptions,
  visit: PartitionRecordVisitor,
): void {
  const listed: string[] = [];
  const compactions: Compaction[] = [];
  const listing: Array<{
    readonly ref: StreamRef & { stream: StoreStream };
    readonly shard: ReturnType<typeof listShards>[number];
  }> = [];
  for (const ref of streamRefs(partitionRoot)) {
    for (const shard of listShards(partitionRoot, ref)) listing.push({ ref, shard });
  }
  listing.sort((a, b) => compareCodeUnits(a.shard.rel, b.shard.rel));
  for (const { ref, shard } of listing) {
    listed.push(shard.rel);
    if (options.reuse?.(shard) === true) continue;
    const head: PartitionShardHead = { rel: shard.rel, device: shard.device, stream: ref.stream };
    let count = 0;
    let pending = 0;
    let last: string | null = null;
    let read: ShardScan;
    try {
      read = scanShard(shard.path, { partitionRoot }, (r) => {
        count += 1;
        if (r.bodyState === "pending") pending += 1;
        last = r.record.id;
        // Each record parsed is garbage at once (`gc-hint.ts`).
        gcHintTick();
        try {
          visit.record?.(head, r.record, r.bodyState === "pending");
        } catch (error) {
          throw new VisitorFailure(error);
        }
      });
    } catch (error) {
      // The caller's own failure (a scratch write that could not be made)
      // is never a shard this machine cannot read: it ends the walk.
      if (error instanceof VisitorFailure) throw error.cause;
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
    const gap = shardScanGap(read);
    if (gap !== null) {
      options.onUnreadable?.({
        rel: shard.rel,
        path: shard.path,
        error: new Error(`the shard was read only in part: ${gap}`),
        incomplete: true,
      });
    }
    compactions.push(...read.compactions);
    visit.shard?.({ ...head, count, pending, last, heldTailBytes: read.pendingTailBytes });
  }
  // Shards the caller reused were not read, so their compactions are not
  // known: a reusing read names nothing as missing.
  if (options.reuse !== undefined) return;
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
}

/**
 * The cut of a partition ({@link computeCut} of {@link readPartition}),
 * read one record at a time: only each shard's count, last id and pending
 * count are kept.
 */
export function readPartitionCut(
  partitionRoot: string,
  options: ReadPartitionOptions = {},
): CutEntry[] {
  const cut: CutEntry[] = [];
  forEachPartitionRecord(partitionRoot, options, {
    shard: (totals) => {
      if (totals.stream === DIGEST_STREAM || totals.count === 0 || totals.last === null) return;
      cut.push({
        shard: totals.rel,
        count: totals.count,
        last: totals.last,
        pending: totals.pending,
      });
    },
  });
  return cut.toSorted((a, b) => compareCodeUnits(a.shard, b.shard));
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
    topics: hash(topicsFingerprint(foldTopics(records))),
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

/** Whether a digested fold (`foldHashes`) reads `record` at all. */
function isDigestFoldInput(record: StoreRecord): boolean {
  return DIGEST_FOLD_KINDS.has(record.kind) || isTopicRecordKind(record.kind);
}

const DIGEST_FOLD_KINDS: ReadonlySet<string> = new Set([
  PREFERENCE_SET_KIND,
  PREFERENCE_REMOVE_KIND,
  PREFERENCE_EVIDENCE_KIND,
  PINNED_SET_KIND,
  PINNED_CLEAR_KIND,
  SETTING_SET_KIND,
  SETTING_UNSET_KIND,
  SETTING_ENTRY_KIND,
]);

/**
 * What a digest of the partition at `partitionRoot` is made of, read
 * record by record ({@link forEachPartitionRecord}): the cut
 * ({@link computeCut}), the records the digested folds read of the shards
 * the cut covers (the same folds as {@link buildDigestBody}, which keeps
 * every record), `device`'s latest digest, and the newest record read.
 */
function readDigestInputs(
  partitionRoot: string,
  device: string,
): {
  cut: CutEntry[];
  covered: StoreRecord[];
  latestOwn: StoreRecord | null;
  newest: StoreRecord | undefined;
} {
  const cut: CutEntry[] = [];
  const covered: StoreRecord[] = [];
  let latestOwn: StoreRecord | null = null;
  let newest: StoreRecord | undefined;
  let kept: StoreRecord[] = [];
  let at: string | null = null;
  forEachPartitionRecord(
    partitionRoot,
    {},
    {
      record: (head, record, pending) => {
        if (at !== head.rel) {
          kept = [];
          at = head.rel;
        }
        if (newest === undefined || compareRecords(record, newest) > 0) newest = record;
        if (head.stream === DIGEST_STREAM) {
          const own = head.device === device && !pending && record.kind === STATE_DIGEST_KIND;
          if (own && (latestOwn === null || compareRecords(record, latestOwn) > 0)) {
            latestOwn = record;
          }
          return;
        }
        if (!pending && isDigestFoldInput(record)) kept.push(record);
      },
      shard: (totals) => {
        const mine = at === totals.rel;
        if (totals.stream !== DIGEST_STREAM && totals.count > 0 && totals.last !== null) {
          cut.push({
            shard: totals.rel,
            count: totals.count,
            last: totals.last,
            pending: totals.pending,
          });
          if (mine) covered.push(...kept);
        }
        kept = [];
        at = null;
      },
    },
  );
  cut.sort((a, b) => compareCodeUnits(a.shard, b.shard));
  return { cut, covered, latestOwn, newest };
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
  const read = readDigestInputs(partitionDir(store.root, options.partition), store.device);
  const body: DigestBody = {
    partition: options.partition,
    cut: read.cut,
    cut_hash: cutHash(read.cut),
    folds: foldHashes(read.covered),
  };
  const latest = read.latestOwn;
  if (latest !== null) {
    const age = now() - parseHlc(latest.hlc)!.physical;
    const same =
      latest.body["cut_hash"] === body.cut_hash &&
      canonicalJson(latest.body["folds"]) === canonicalJson(body.folds);
    if (same && age < (options.minIntervalMs ?? DAY_MS)) {
      return { published: false, body, reason: "unchanged" };
    }
  }
  const newest = read.newest;
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
