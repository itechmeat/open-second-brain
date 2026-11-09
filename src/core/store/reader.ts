/**
 * The shard reader of the brain store (design D3, task 1.5).
 *
 * Reads one shard from a byte offset (the index resumes from the offset
 * it stored), parses and verifies every line, and returns the records with
 * the diagnostics a doctor reports:
 *
 *  - An incomplete last line (no newline yet) or a last line that fails
 *    verification is NOT consumed: `nextOffset` stops before it, so the
 *    next read retries it once the sync tool has delivered the rest. It is
 *    never treated as deleted, and it is reported only as a pending tail.
 *  - A middle line that fails verification is skipped and reported.
 *  - A record with an unknown format version is skipped and reported.
 *  - A `compacted` record is returned like any other and its shard lists
 *    are collected, so a caller can tell a replaced shard from a missing one.
 *  - A record whose body is a blob reference gets its body from the blob
 *    when the blob is present and verifies; otherwise the record is
 *    returned with its body pending, to be filled in on a later read. A
 *    blob that verifies but does not hold the record's body (not a JSON
 *    object, not canonical, a different length than the reference says)
 *    can never change, since its name fixes its content: the record is
 *    skipped and reported as a corrupt line.
 *  - A record whose `device` is not the device directory its shard sits
 *    in is skipped and reported as a corrupt line: only that device
 *    writes there.
 *
 * The shard is read in bounded chunks, never whole. A run of bytes longer
 * than the line-size cap without a newline can never be a record (the
 * writer refuses such a line), so it is reported as a corrupt line and
 * consumed, never held back as a pending tail.
 */

import { basename, dirname } from "node:path";
import { closeSync, fstatSync, readSync } from "node:fs";

import { isValidDeviceId } from "../config.ts";
import {
  BLOB_REF_BYTES_KEY,
  BLOB_REF_KEY,
  COMPACTED_KIND,
  STORE_LINE_CAP_BYTES,
} from "./constants.ts";
import { readBlob } from "./blobs.ts";
import { noteObservedClock } from "./clock-floor.ts";
import { compareHlc, parseHlc, type Hlc } from "./hlc.ts";
import {
  BODY_TOO_DEEP_REASON,
  bodyChecksum,
  bodyTooDeep,
  isBlobRef,
  verifyEnvelope,
  type RecordBody,
  type StoreRecord,
} from "./envelope.ts";
import { openRegularFileForRead } from "./safe-fs.ts";
import { isShardFileName } from "./shard-list.ts";
import { isTornObjectPrefix } from "./torn-line.ts";

/** Where a returned record's body came from. */
export type BodyState = "inline" | "blob" | "pending";

export interface ReadRecord {
  /** The record; for a pending blob its body is still the blob reference. */
  readonly record: StoreRecord;
  readonly bodyState: BodyState;
  /** Byte offset of the line in the shard. */
  readonly offset: number;
  /** Byte length of the line, newline included. */
  readonly length: number;
}

export type ShardDiagnosticKind =
  | "corrupt-line"
  | "unknown-version"
  | "offset-past-end"
  | "not-a-file";

export interface ShardDiagnostic {
  readonly kind: ShardDiagnosticKind;
  /** Byte offset of the line concerned (or the requested offset). */
  readonly offset: number;
  readonly reason: string;
  /**
   * A `corrupt-line` that is a record line cut short by a crash and closed
   * by the device's next append (`torn-line.ts`): never a record any
   * machine read, so it hides nothing.
   */
  readonly torn?: true;
}

/** One compaction a shard announced: partition-relative shard paths. */
export interface Compaction {
  readonly id: string;
  readonly replaces: ReadonlyArray<string>;
  readonly into: ReadonlyArray<string>;
}

export interface ShardRead {
  readonly records: ReadonlyArray<ReadRecord>;
  readonly diagnostics: ReadonlyArray<ShardDiagnostic>;
  readonly compactions: ReadonlyArray<Compaction>;
  /** First byte not consumed: where the next read of this shard resumes. */
  readonly nextOffset: number;
  /** Bytes after `nextOffset` held back for a retry (an incomplete or unverified last line). */
  readonly pendingTailBytes: number;
  /** Size of the shard when it was read. */
  readonly size: number;
}

export interface ReadShardOptions {
  /** Byte offset to start from (default 0); must be the start of a line. */
  readonly offset?: number;
  /**
   * The shard's partition directory, to resolve blob references (without it
   * blob bodies stay pending) and to refuse a shard reached through a linked
   * folder below it.
   */
  readonly partitionRoot?: string;
}

const NEWLINE = 0x0a;

/**
 * Reading is receiving (`clock-floor.ts`): the newest stamp among `records`
 * raises this process's clock floor for the store the partition belongs
 * to, so a write that replaces or removes one of them orders after it.
 */
function observeRead(partitionRoot: string, records: ReadonlyArray<ReadRecord>): void {
  let newest: Hlc | null = null;
  for (const { record } of records) {
    const clock = parseHlc(record.hlc);
    if (clock !== null && (newest === null || compareHlc(clock, newest) > 0)) newest = clock;
  }
  if (newest !== null) noteObservedClock(dirname(partitionRoot), newest);
}

/** Bytes read from a shard per call. */
const READ_CHUNK_BYTES = 1024 * 1024;

function isPaths(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0);
}

function asCompaction(record: StoreRecord): Compaction | null {
  const { replaces, into } = record.body as { replaces?: unknown; into?: unknown };
  if (!isPaths(replaces) || !isPaths(into)) return null;
  return { id: record.id, replaces, into };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Outcome of {@link readBlobBody}. */
export type BlobBodyRead =
  | { readonly status: "ok"; readonly body: RecordBody }
  /** Absent, or not (yet) hashing to its name: a sync tool may still deliver it. */
  | { readonly status: "pending" }
  /** Hashes to its name but is not the record's body; it can never change. */
  | { readonly status: "invalid"; readonly reason: string };

/**
 * The body a blob reference points at: blob `sum` in the partition at
 * `partitionRoot`, parsed and checked to be the canonical JSON of a plain
 * object whose checksum is `sum`. `bytes`, when given, is the length the
 * reference promises. Never throws for what the blob holds.
 */
export function readBlobBody(partitionRoot: string, sum: string, bytes?: number): BlobBodyRead {
  const blob = readBlob(partitionRoot, sum, bytes);
  if (blob.status !== "ok") return { status: "pending" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(blob.text);
  } catch {
    return { status: "invalid", reason: `blob ${sum} is not valid JSON` };
  }
  if (!isPlainObject(parsed) || BLOB_REF_KEY in parsed) {
    return { status: "invalid", reason: `blob ${sum} does not hold a record body (a JSON object)` };
  }
  // Before the checksum: its canonical JSON walks the body recursively.
  if (bodyTooDeep(parsed))
    return { status: "invalid", reason: `blob ${sum}: ${BODY_TOO_DEEP_REASON}` };
  if (bodyChecksum(parsed) !== sum) {
    return { status: "invalid", reason: `blob ${sum} does not hold the canonical JSON of a body` };
  }
  return { status: "ok", body: parsed };
}

function resolveBody(
  record: StoreRecord,
  partitionRoot: string | undefined,
): "inline" | "pending" | { readonly body: RecordBody } | { readonly invalid: string } {
  if (!isBlobRef(record.body)) return "inline";
  if (partitionRoot === undefined) return "pending";
  const read = readBlobBody(
    partitionRoot,
    record.body[BLOB_REF_KEY] as string,
    record.body[BLOB_REF_BYTES_KEY] as number,
  );
  if (read.status === "ok") return { body: read.body };
  if (read.status === "invalid") return { invalid: read.reason };
  return "pending";
}

/**
 * The device a shard path belongs to: its parent directory, when the path
 * has the shard shape (`<device>/<YYYY-MM>[.<suffix>].jsonl`). `null` for
 * any other path, which is then not checked.
 */
function shardDeviceOf(path: string): string | null {
  if (!isShardFileName(basename(path))) return null;
  const device = basename(dirname(path));
  return isValidDeviceId(device) ? device : null;
}

/** What one complete line turned out to be. */
type LineOutcome =
  | { readonly kind: "record"; readonly record: ReadRecord; readonly compaction: Compaction | null }
  | { readonly kind: "skip" }
  | { readonly kind: "diagnostic"; readonly diagnostic: ShardDiagnostic }
  | { readonly kind: "hold" };

function readLine(
  text: string,
  lineOffset: number,
  length: number,
  isLast: boolean,
  shardDevice: string | null,
  partitionRoot: string | undefined,
): LineOutcome {
  if (text.trim() === "") return { kind: "skip" };
  let check: ReturnType<typeof verifyEnvelope>;
  let notJson = false;
  try {
    check = verifyEnvelope(JSON.parse(text));
  } catch {
    notJson = true;
    check = { ok: false, reason: "line is not valid JSON" };
  }
  const corrupt = (reason: string): LineOutcome => ({
    kind: "diagnostic",
    diagnostic: { kind: "corrupt-line", offset: lineOffset, reason },
  });
  if (notJson && !isLast && isTornObjectPrefix(text)) {
    return {
      kind: "diagnostic",
      diagnostic: {
        kind: "corrupt-line",
        offset: lineOffset,
        reason: "line is a record cut short by a crash (a torn write)",
        torn: true,
      },
    };
  }
  if (!check.ok) {
    if (check.unknownVersion !== undefined) {
      return {
        kind: "diagnostic",
        diagnostic: { kind: "unknown-version", offset: lineOffset, reason: check.reason },
      };
    }
    // An unverified last line may still be arriving: retry it later.
    return isLast ? { kind: "hold" } : corrupt(check.reason);
  }
  let record = check.record;
  if (shardDevice !== null && record.device !== shardDevice) {
    return corrupt(
      `record device "${record.device}" is not the device "${shardDevice}" whose shard it is in`,
    );
  }
  const body = resolveBody(record, partitionRoot);
  let bodyState: BodyState;
  if (typeof body === "string") bodyState = body;
  else if ("invalid" in body) return corrupt(body.invalid);
  else {
    record = { ...record, body: body.body };
    bodyState = "blob";
  }
  const compaction =
    record.kind === COMPACTED_KIND && bodyState !== "pending" ? asCompaction(record) : null;
  return { kind: "record", record: { record, bodyState, offset: lineOffset, length }, compaction };
}

/** Read and verify the shard at `path` from `options.offset`. */
export function readShard(path: string, options: ReadShardOptions = {}): ShardRead {
  const start = options.offset ?? 0;
  const records: ReadRecord[] = [];
  const diagnostics: ShardDiagnostic[] = [];
  const compactions: Compaction[] = [];
  const shardDevice = shardDeviceOf(path);
  // The same guard as a blob read: a symlink or a FIFO a sync peer swaps
  // in under the name after the listing is never followed or blocked on.
  // With the partition known, a shard reached through a linked folder
  // below it is refused the same way.
  const fd = openRegularFileForRead(path, options.partitionRoot);
  if (fd === null) {
    diagnostics.push({
      kind: "not-a-file",
      offset: start,
      reason:
        "the shard is not a regular file (a symbolic link or a special file) or is reached " +
        "through a linked folder inside the partition; it is not read",
    });
    // Nothing was read past `start`, so the size says the same as the offset.
    return {
      records,
      diagnostics,
      compactions,
      nextOffset: start,
      pendingTailBytes: 0,
      size: start,
    };
  }
  try {
    const size = fstatSync(fd).size;
    if (start > size) {
      diagnostics.push({
        kind: "offset-past-end",
        offset: start,
        reason: `offset ${start} is past the end of the shard (${size} bytes); the shard was truncated or replaced`,
      });
      return { records, diagnostics, compactions, nextOffset: start, pendingTailBytes: 0, size };
    }
    const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, Math.max(size - start, 1)));
    /** First byte not consumed. */
    let consumed = start;
    /** File offset just past the bytes read so far. */
    let position = start;
    /** Bytes of the current line read so far (its start is `consumed`). */
    let carry: Buffer[] = [];
    let carried = 0;
    /** Inside a run longer than the cap: discard up to the next newline. */
    let oversized = false;
    const overlong = (): void => {
      diagnostics.push({
        kind: "corrupt-line",
        offset: consumed,
        reason: `line is longer than the ${STORE_LINE_CAP_BYTES}-byte line-size cap`,
      });
    };
    let held = false;
    while (!held && position < size) {
      const n = readSync(fd, chunk, 0, Math.min(chunk.length, size - position), position);
      if (n === 0) break;
      const base = position;
      position += n;
      let cursor = 0;
      while (cursor < n) {
        const end = chunk.subarray(0, n).indexOf(NEWLINE, cursor);
        if (end === -1) {
          if (!oversized) {
            carry.push(Buffer.from(chunk.subarray(cursor, n)));
            carried += n - cursor;
            if (carried >= STORE_LINE_CAP_BYTES) {
              oversized = true;
              carry = [];
              carried = 0;
            }
          }
          break;
        }
        const lineEnd = base + end + 1;
        if (oversized) {
          overlong();
          oversized = false;
        } else if (carried + (end - cursor) + 1 > STORE_LINE_CAP_BYTES) {
          overlong();
        } else {
          carry.push(chunk.subarray(cursor, end));
          const text = Buffer.concat(carry).toString("utf8");
          const outcome = readLine(
            text,
            consumed,
            lineEnd - consumed,
            lineEnd === size,
            shardDevice,
            options.partitionRoot,
          );
          if (outcome.kind === "hold") {
            held = true;
            break;
          }
          if (outcome.kind === "diagnostic") diagnostics.push(outcome.diagnostic);
          if (outcome.kind === "record") {
            records.push(outcome.record);
            if (outcome.compaction !== null) compactions.push(outcome.compaction);
          }
        }
        carry = [];
        carried = 0;
        consumed = lineEnd;
        cursor = end + 1;
      }
    }
    // A run past the cap that reaches the end of the shard is no record
    // either; holding it back would re-read it on every pass.
    if (!held && oversized) {
      overlong();
      consumed = position;
    }
    if (options.partitionRoot !== undefined) observeRead(options.partitionRoot, records);
    return {
      records,
      diagnostics,
      compactions,
      nextOffset: consumed,
      pendingTailBytes: size - consumed,
      size,
    };
  } finally {
    closeSync(fd);
  }
}

/**
 * Why a read of a whole shard misses records it holds, or `null` when it
 * saw every record: a record whose body is a blob that has not arrived, a
 * bad line in the middle (anything but a write torn by a crash), a record
 * of a newer format, a shard that is no regular file. The held-back last
 * line is not a gap: it is an append still arriving (FORMAT.md,
 * "Reading"), and no machine has read it as a record yet. A reader whose
 * answer decides a protection treats a shard with a gap as unseen.
 */
export function shardReadGap(read: ShardRead): string | null {
  const reasons: string[] = [];
  const pending = read.records.filter((r) => r.bodyState === "pending").length;
  if (pending > 0) {
    reasons.push(
      pending === 1
        ? "a record whose body is a blob that has not arrived yet"
        : `${pending} records whose bodies are blobs that have not arrived yet`,
    );
  }
  for (const d of read.diagnostics) {
    if (d.torn === true) continue;
    reasons.push(`${d.kind} at byte ${d.offset}: ${d.reason}`);
  }
  return reasons.length === 0 ? null : reasons.join("; ");
}

/**
 * The partition-relative paths of every shard the given compactions
 * replaced. A known shard that has disappeared and is in this set was
 * compacted away, not lost.
 */
export function replacedShards(compactions: Iterable<Compaction>): ReadonlySet<string> {
  const out = new Set<string>();
  for (const compaction of compactions) for (const rel of compaction.replaces) out.add(rel);
  return out;
}

/** How a shard that a caller knew about but can no longer find is to be read. */
export function classifyMissingShard(
  rel: string,
  replaced: ReadonlySet<string>,
): "replaced" | "missing" {
  return replaced.has(rel) ? "replaced" : "missing";
}
