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
 *  2. Take the next clock stamp (send rule, persisted per device).
 *  3. Build the envelope. When the line would exceed the line-size cap,
 *     write the body as a blob first and put a blob reference on the line;
 *     the blob is complete before any line names it. Its temp file goes to
 *     the device-local state directory when that is on the store's
 *     filesystem (see `blobs.ts`).
 *  4. Under the shard lock, append the line and fsync it. When the shard
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

import { tickClock, type WallClock } from "./clock-store.ts";
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
import { ensureStoreDir, openShardForAppend } from "./safe-fs.ts";
import type { StoreHandle } from "./store-open.ts";
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
        `the record was not written. Sync the ${partition} folder to this machine to write ${partition} records here.`,
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
    const size = fstatSync(fd).size;
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
  if (!store.partitions.has(input.partition)) {
    throw new PartitionUnavailableError(input.partition, store.root);
  }
  const ref: StreamRef =
    input.ledger === undefined
      ? { stream: input.stream }
      : { stream: input.stream, ledger: input.ledger };
  const hlc = tickClock(store.deviceStateDir, store.device, options.now);
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
  let spilled = false;
  if (bytes.length > STORE_LINE_CAP_BYTES) {
    const text = canonicalBodyText(record.body);
    const reference = {
      [BLOB_REF_KEY]: record.sum,
      [BLOB_REF_BYTES_KEY]: Buffer.byteLength(text, "utf8"),
    };
    bytes = lineBytes({ ...record, body: reference });
    // Checked before the blob is written, so a refused record leaves no
    // orphan blob in the synced partition.
    if (bytes.length > STORE_LINE_CAP_BYTES) throw new RecordTooLargeError(bytes.length);
    writeBlob(partitionDir(store.root, input.partition), text, {
      tempDir: join(store.deviceStateDir, STORE_TMP_DIR),
    });
    spilled = true;
  }

  const path = shardPath(store.root, input.partition, ref, store.device, month);
  withLocalLock(shardLockTarget(store.deviceStateDir, input.partition, rel), () =>
    appendLine(partitionDir(store.root, input.partition), path, bytes),
  );
  return { record, path, rel, spilled };
}
