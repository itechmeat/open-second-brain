/**
 * The shard appender of the brain store (design D2, task 1.4).
 *
 * One record is one JSON line, written to
 * `<partition>/<stream>[/<ledger>]/<device>/<YYYY-MM>.jsonl` with a single
 * append call, under a device-local advisory lock on that shard. The lock
 * lives in the device-local state directory, never in the synced store,
 * and is held only for the write. Only this device ever writes a shard
 * named with its device id, so the lock orders concurrent processes on one
 * machine and nothing else.
 *
 * Steps for one record:
 *  1. Refuse a partition this machine does not hold.
 *  2. Take the next clock stamp (send rule, persisted per device), after
 *     the newest stamp this process read from the store (receive rule,
 *     `clock-floor.ts`), so a record that replaces or removes one it read
 *     folds after it.
 *  3. Build the envelope. When the line would exceed the line-size cap,
 *     the body becomes a blob and the line carries a blob reference.
 *  4. Under the shard lock, once the root the batch writes to is checked
 *     to still take it, write the blobs (complete before any line names
 *     them; a temp file goes to the device-local state directory when
 *     that is on the store's filesystem, see `blobs.ts`), then append the
 *     line and fsync it. A blob is never written to a root the check then
 *     turns away (the recovery copy a relocation left). When the shard
 *     does not end in a newline (a write torn by a crash), a newline goes
 *     first, so the torn fragment stays one bad line that readers report
 *     and the new record stays whole.
 *
 * On Windows `O_APPEND` opens the file with `FILE_APPEND_DATA`, so every
 * write lands at the end; the local lock makes that hold for any line size.
 * Directories are created `0700` and shards `0600`, in both partitions.
 */

import { closeSync, fstatSync, fsyncSync, openSync, readSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

import { noteOwnAppend } from "./own-appends.ts";

import { observedClockFloor } from "./clock-floor.ts";
import { tickClockMany, type WallClock } from "./clock-store.ts";
import { compareHlc, maxHlc, type Hlc } from "./hlc.ts";
import {
  BLOB_REF_BYTES_KEY,
  BLOB_REF_KEY,
  STORE_LINE_CAP_BYTES,
  STORE_TMP_DIR,
  type StorePartition,
} from "./constants.ts";
import { buildRecord, canonicalBodyText, type RecordBody, type StoreRecord } from "./envelope.ts";
import { writeBlob } from "./blobs.ts";
import { withLocalLock } from "./local-lock.ts";
import { followRelocation, relocationRunning, waitForRelocation } from "./relocation-marker.ts";
import { ensureStoreDir, openShardForAppend } from "./safe-fs.ts";
import { RelocatedStoreUnavailableError, type StoreHandle } from "./store-open.ts";
import {
  partitionDir,
  shardLockTarget,
  shardMonth,
  shardPath,
  shardRelPath,
  type StreamRef,
} from "./store-paths.ts";

/** What a writer appends. */
export interface AppendInput extends StreamRef {
  readonly partition: StorePartition;
  readonly kind: string;
  readonly agent: string;
  readonly scope?: string | null;
  readonly topic?: string | null;
  readonly body: RecordBody;
}

export interface AppendOptions {
  /** Wall clock for the send rule (default: `Date.now`). */
  readonly now?: WallClock;
  /**
   * Called after each shard's lines of a batch are written and its lock
   * released: a fault-injection point for the crash tests; writers never
   * set it.
   */
  readonly afterShard?: () => void;
}

export interface AppendResult {
  /** The record with its full body. */
  readonly record: StoreRecord;
  /** The shard the line went to. */
  readonly path: string;
  /** The shard path relative to its partition, with `/` separators. */
  readonly rel: string;
  /** Whether the body was spilled into a blob. */
  readonly spilled: boolean;
}

/** A write to a partition this machine does not hold. */
export class PartitionUnavailableError extends Error {
  readonly partition: StorePartition;

  constructor(partition: StorePartition, root: string) {
    super(
      `this machine does not hold the ${partition} partition of the brain store at ${root}; ` +
        "the record was not written",
    );
    this.name = "PartitionUnavailableError";
    this.partition = partition;
  }
}

/** A record that does not fit a line even with its body spilled. */
export class RecordTooLargeError extends Error {
  constructor(bytes: number) {
    super(
      `a store record line is ${bytes} bytes even with its body in a blob, above the ${STORE_LINE_CAP_BYTES}-byte cap; shorten its agent, scope or kind`,
    );
    this.name = "RecordTooLargeError";
  }
}

const NEWLINE = 0x0a;

function lineBytes(record: StoreRecord): Buffer {
  return Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
}

function fsyncDirBestEffort(dir: string): void {
  try {
    const fd = openSync(dir, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    // Directory fsync is a best-effort durability step; some platforms refuse it.
  }
}

/**
 * Append `bytes` to `path`, first closing a torn last line with a newline.
 * The line is fsynced before this returns (and a new shard's directory
 * entry too, best-effort), so a reported append survives a power loss.
 * No symlink under the partition folder is followed (`safe-fs.ts`).
 */
function appendLine(partitionRoot: string, path: string, bytes: Buffer): void {
  ensureStoreDir(partitionRoot, dirname(path));
  const fd = openShardForAppend(path);
  let created = false;
  try {
    const pre = fstatSync(fd, { bigint: true });
    const size = Number(pre.size);
    created = size === 0;
    let payload = bytes;
    if (size > 0) {
      const last = Buffer.alloc(1);
      readSync(fd, last, 0, 1, size - 1);
      if (last[0] !== NEWLINE) payload = Buffer.concat([Buffer.from([NEWLINE]), bytes]);
    }
    let written = 0;
    while (written < payload.length) {
      written += writeSync(fd, payload, written, payload.length - written);
    }
    fsyncSync(fd);
    const post = fstatSync(fd, { bigint: true });
    noteOwnAppend(
      path,
      { size, mtimeNs: pre.mtimeNs, ctimeNs: pre.ctimeNs },
      { size: Number(post.size), mtimeNs: post.mtimeNs, ctimeNs: post.ctimeNs },
    );
  } finally {
    closeSync(fd);
  }
  if (created) fsyncDirBestEffort(dirname(path));
}

/** Append one record to this device's shard of the given stream. */
export function appendRecord(
  store: StoreHandle,
  input: AppendInput,
  options: AppendOptions = {},
): AppendResult {
  return appendRecords(store, [input], options)[0]!;
}

interface PreparedLine {
  readonly result: AppendResult;
  readonly bytes: Buffer;
  readonly partition: StorePartition;
  /** The body text the line's blob reference names, written under the shard lock; null inline. */
  readonly blob: string | null;
}

/** Steps 3 of the module docblock for one record stamped `hlc`. */
function prepareLine(store: StoreHandle, input: AppendInput, hlc: Hlc): PreparedLine {
  const ref: StreamRef =
    input.ledger === undefined
      ? { stream: input.stream }
      : { stream: input.stream, ledger: input.ledger };
  const month = shardMonth(hlc.physical);
  // Validates the stream, ledger and device before anything is written.
  const rel = shardRelPath(ref, store.device, month);
  const record = buildRecord({
    hlc,
    device: store.device,
    agent: input.agent,
    kind: input.kind,
    scope: input.scope ?? null,
    topic: input.topic ?? null,
    body: input.body,
  });

  let bytes = lineBytes(record);
  let blob: string | null = null;
  if (bytes.length > STORE_LINE_CAP_BYTES) {
    const text = canonicalBodyText(record.body);
    const reference = {
      [BLOB_REF_KEY]: record.sum,
      [BLOB_REF_BYTES_KEY]: Buffer.byteLength(text, "utf8"),
    };
    bytes = lineBytes({ ...record, body: reference });
    // Checked before anything is written, so a refused record leaves no
    // orphan blob in the synced partition.
    if (bytes.length > STORE_LINE_CAP_BYTES) throw new RecordTooLargeError(bytes.length);
    blob = text;
  }
  const path = shardPath(store.root, input.partition, ref, store.device, month);
  return {
    result: { record, path, rel, spilled: blob !== null },
    bytes,
    partition: input.partition,
    blob,
  };
}

/**
 * Append several records, in order, as one batch: the clock is ticked
 * once for all of them (`tickClockMany`), every blob is complete before
 * any line names it, and each shard the batch touches gets its lines in
 * one write and one fsync under its lock, in the order of `inputs`. A
 * batch refused for a partition this machine does not hold writes
 * nothing. A crash mid-batch leaves each shard with a prefix of its lines
 * (and at most one torn last line, which readers report), as a crash
 * between single appends would. Returns the results in input order.
 *
 * The root the lines go to is settled before the clock is ticked: the
 * handle's, or the root its store was relocated to (`store-relocation.ts`),
 * so a process that opened the store before a relocation never writes the
 * old root after it, stamps its records after what it read from either
 * root, and is refused a partition the new root does not hold.
 *
 * A batch that throws after some of its shards were written (a write that
 * fails, a lock that fails to release, a relocation that began between two
 * shards and outlasts the lock budget) throws the error as it is;
 * {@link appendedBeforeFailure} of that error names the records already
 * written, so the caller can report or undo them instead of writing them
 * again.
 */
export function appendRecords(
  store: StoreHandle,
  inputs: ReadonlyArray<AppendInput>,
  options: AppendOptions = {},
): AppendResult[] {
  if (inputs.length === 0) return [];
  let target = writeTarget(store);
  for (const input of inputs) {
    if (!target.partitions.has(input.partition)) {
      throw new PartitionUnavailableError(input.partition, target.root);
    }
  }
  let stamps = tickClockMany(
    store.deviceStateDir,
    store.device,
    inputs.length,
    options.now,
    clockFloor(store, target),
  );
  let lines = inputs.map((input, i) => prepareLine(target, input, stamps[i]!));
  const results: Array<AppendResult | undefined> = lines.map(() => undefined);
  let done = 0;
  try {
    while (done < lines.length) {
      const byShard = groupByShard(lines.filter((_, i) => results[i] === undefined));
      let moved = false;
      for (const group of byShard) {
        const first = group[0]!;
        const wrote = withLocalLock(
          shardLockTarget(store.deviceStateDir, first.partition, first.result.rel),
          () => {
            // Checked under the shard lock: a relocation that began after
            // this append prepared its lines waits for this lock before it
            // copies, and an append that sees it here goes to the new root;
            // a redirected append writes only while the new root still
            // holds this partition of this store.
            if (!targetStands(store, target, first.partition)) return false;
            // The blobs go where the lines go, only once that root stands.
            for (const line of group) {
              if (line.blob === null) continue;
              writeBlob(partitionDir(target.root, line.partition), line.blob, {
                tempDir: join(store.deviceStateDir, STORE_TMP_DIR),
              });
            }
            appendLine(
              partitionDir(target.root, first.partition),
              first.result.path,
              Buffer.concat(group.map((line) => line.bytes)),
            );
            // Recorded before the lock is released: a release that fails
            // after the line is durable still leaves these records named.
            for (const line of group) results[lines.indexOf(line)] = line.result;
            done += group.length;
            return true;
          },
        );
        if (!wrote) {
          moved = true;
          break;
        }
        options.afterShard?.();
      }
      if (moved) {
        // Lines not written yet are prepared again for the new root (their
        // blobs are written there, under its shard lock). They keep their stamps unless the new
        // root's floor reaches them; then they are stamped again after it.
        target = writeTarget(store);
        const left = lines.filter((_, i) => results[i] === undefined);
        for (const line of left) {
          const input = inputs[lines.indexOf(line)]!;
          if (!target.partitions.has(input.partition)) {
            throw new PartitionUnavailableError(input.partition, target.root);
          }
        }
        const floor = clockFloor(store, target);
        if (floor !== null && left.some((l) => compareHlc(stamps[lines.indexOf(l)]!, floor) <= 0)) {
          const again = tickClockMany(
            store.deviceStateDir,
            store.device,
            left.length,
            options.now,
            floor,
          );
          stamps = stamps.map((stamp, i) => {
            const at = left.indexOf(lines[i]!);
            return at < 0 ? stamp : again[at]!;
          });
        }
        const fresh = left.map((line) =>
          prepareLine(target, inputs[lines.indexOf(line)]!, stamps[lines.indexOf(line)]!),
        );
        lines = lines.map((line) => {
          const at = left.indexOf(line);
          return at < 0 ? line : fresh[at]!;
        });
      }
    }
  } catch (err) {
    if (done > 0 && typeof err === "object" && err !== null) {
      writtenBeforeFailure.set(err, [...results]);
    }
    throw err;
  }
  return results as AppendResult[];
}

/**
 * The newest stamp this process read from the store, at the handle's root
 * or at the root its writes go to (a reader that opened the store after a
 * relocation noted its reads under the new root).
 */
function clockFloor(store: StoreHandle, target: StoreHandle): Hlc | null {
  const own = observedClockFloor(store.root);
  if (target.root === store.root) return own;
  const there = observedClockFloor(target.root);
  if (own === null) return there;
  return there === null ? own : maxHlc(own, there);
}

/** The records each failed batch wrote before it threw (see {@link appendedBeforeFailure}). */
const writtenBeforeFailure = new WeakMap<object, ReadonlyArray<AppendResult | undefined>>();

/**
 * The results of the records an {@link appendRecords} call wrote before it
 * threw `err`, by input index (undefined for a record it did not write), or
 * null when it wrote none.
 */
export function appendedBeforeFailure(
  err: unknown,
): ReadonlyArray<AppendResult | undefined> | null {
  if (typeof err !== "object" || err === null) return null;
  return writtenBeforeFailure.get(err) ?? null;
}

/** The prepared lines grouped by shard, in order of first appearance. */
function groupByShard(lines: ReadonlyArray<PreparedLine>): PreparedLine[][] {
  const byShard = new Map<string, PreparedLine[]>();
  for (const line of lines) {
    const at = `${line.partition}\u0000${line.result.rel}`;
    const group = byShard.get(at);
    if (group === undefined) byShard.set(at, [line]);
    else group.push(line);
  }
  return [...byShard.values()];
}

/**
 * Whether the root `target` (settled by {@link writeTarget}) still takes
 * this append, checked under the shard lock. For the handle's own root: no
 * relocation runs and the root's marker names no move of this store (none,
 * and none that cannot be read). For the root the store moved to: the old root's marker
 * still names it, and its `partition` still carries this store's identity
 * file. Anything else sends the batch back to {@link writeTarget}, which
 * waits, follows the move, or refuses.
 */
function targetStands(store: StoreHandle, target: StoreHandle, partition: StorePartition): boolean {
  if (target.root === store.root && relocationRunning(store.deviceStateDir)) return false;
  // The same reading of the markers as {@link writeTarget}'s (and as an
  // open's, `followRelocation`), so the two never disagree and send a
  // batch back and forth, and a write never lands where an open refuses.
  const now = followRelocation(store.root, store.storeId);
  if (target.root === store.root) return now.kind === "none";
  return now.kind === "moved" && now.to === target.root && now.held.has(partition);
}

/**
 * The handle with the root writes go to now (waiting out a relocation that
 * runs), holding only the partitions that root carries for this store. A
 * store whose relocation destination does not hold it now, or whose marker
 * cannot be read, is refused ({@link RelocatedStoreUnavailableError}):
 * neither the frozen old root nor whatever is at the destination may
 * receive its records.
 */
function writeTarget(store: StoreHandle): StoreHandle {
  waitForRelocation(store.deviceStateDir);
  const moved = followRelocation(store.root, store.storeId);
  if (moved.kind === "refused") {
    throw new RelocatedStoreUnavailableError(moved.root, moved.state);
  }
  if (moved.kind === "none") return store;
  const partitions = new Set([...store.partitions].filter((p) => moved.held.has(p)));
  return { ...store, root: moved.to, partitions };
}
