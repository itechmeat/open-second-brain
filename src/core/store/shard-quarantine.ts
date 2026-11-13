/**
 * The device-local quarantine of shard lines (change store-hardening,
 * design D4; spec `store-shard-gaps`).
 *
 * A shard read only in part fails every protection read closed (capture,
 * settings, lane privacy, exact state, attestations, the OKF export, the
 * migration). When the gap is one bad line in another device's shard, the
 * operator can record on this machine that exactly that line is skipped:
 * the shard then reads as whole here, the line stays in the file, and no
 * other machine is affected.
 *
 * An entry is the line's byte offset and the hash of its bytes, from the
 * offset through its newline (newline included, read from the file). A
 * line over the store's line cap is a corrupt line too, so it is hashed as
 * well, up to {@link QUARANTINE_HASH_CAP_BYTES}: a longer run has no hash
 * (`null`), cannot be quarantined and stays a gap, which fails closed. The
 * reader hashes from the descriptor it already holds; every other caller
 * opens the shard through the reader's guarded open (no symbolic link, no
 * special file, no linked folder inside the partition).
 *
 * The reader marks a diagnostic or a pending record only when both match
 * one entry of the matching kind: a `corrupt-line` entry marks only a
 * corrupt line, a `blob-pending` entry only a pending record, and never in
 * a `settings` shard. The shard or the offset alone never marks a line, so
 * another bad line of the same shard, or other bytes at a quarantined
 * offset, stay gaps.
 *
 * The ledger is one file per store root under the device-local stores
 * state folder, never synced:
 * `<storesStateDir()>/shard-quarantine/<sha256(resolve(root))[0:32]>.json`.
 * The reader applies entries only from a ledger of the supported version
 * and fails closed on anything else ({@link appliedLines}).
 * Writes are read-modify-write under the local lock, so two processes
 * quarantining at once both land (`shard-quarantine-write.ts`, kept apart
 * so the readers that only ask for the ledger's stamp or lines load no
 * lock module); reads are cached by the file's size and mtime.
 *
 * This module parses no shard itself (the reader imports it), so
 * {@link listQuarantine} takes the shard reader as an argument.
 */

import { createHash } from "node:crypto";
import { closeSync, readFileSync, readSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

import { STORE_LINE_CAP_BYTES, STORE_PARTITIONS, type StorePartition } from "./constants.ts";
import { parseHlc } from "./hlc.ts";
import { openRegularFileForRead } from "./safe-fs.ts";
import { storesStateDir } from "./store-paths.ts";

/** Folder of the ledgers under the stores state folder. */
export const SHARD_QUARANTINE_DIR = "shard-quarantine";

/** The ledger `version` this release reads and writes. */
export const QUARANTINE_LEDGER_VERSION = 1;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Age from which a pending blob may be quarantined: seven days. */
export const PENDING_BLOB_QUARANTINE_AGE_MS = 7 * DAY_MS;

/** {@link PENDING_BLOB_QUARANTINE_AGE_MS} as message text, e.g. `7 days`. */
export const PENDING_BLOB_QUARANTINE_AGE_TEXT = `${PENDING_BLOB_QUARANTINE_AGE_MS / DAY_MS} days`;

/**
 * The instant a pending record was written, from its clock stamp, or `null`
 * when the stamp does not parse as a time (no stamp, or a physical part no
 * date can hold). Such a record has no age: it is never quarantined by age,
 * and nothing substitutes the current time for it.
 */
export function pendingRecordWrittenMs(hlc: string): number | null {
  const physical = parseHlc(hlc)?.physical;
  if (physical === undefined) return null;
  return Number.isNaN(new Date(physical).getTime()) ? null : physical;
}

export type QuarantineKind = "corrupt-line" | "blob-pending";

export interface QuarantineLine {
  readonly partition: StorePartition;
  /** Partition-relative shard path, `/`-separated. */
  readonly shard: string;
  readonly offset: number;
  /** Hash of the line's bytes from `offset` through its newline. */
  readonly sha256: string;
  readonly kind: QuarantineKind;
  readonly reason: string;
  readonly quarantined_at: string;
}

/** `held`: the same bytes still stand there and are still a gap; `resolved`: they now read as a record; `stale`: other bytes stand at the offset. */
export type QuarantineState = "held" | "resolved" | "stale";

export interface QuarantineListEntry extends QuarantineLine {
  readonly state: QuarantineState;
}

interface Ledger {
  readonly root: string;
  readonly lines: QuarantineLine[];
}

/** The ledger file of the store at `root`. */
export function ledgerPath(root: string): string {
  const key = createHash("sha256").update(resolve(root)).digest("hex").slice(0, 32);
  return join(storesStateDir(), SHARD_QUARANTINE_DIR, `${key}.json`);
}

function stampOf(path: string): string {
  const stat = statSync(path, { throwIfNoEntry: false });
  return stat === undefined ? "absent" : `${stat.size}:${stat.mtimeMs}`;
}

function isPartition(value: unknown): value is StorePartition {
  return (STORE_PARTITIONS as ReadonlyArray<unknown>).includes(value);
}

/** Whether `value` is a ledger entry this release reads. */
export function isLine(value: unknown): value is QuarantineLine {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    isPartition(v["partition"]) &&
    typeof v["shard"] === "string" &&
    typeof v["offset"] === "number" &&
    Number.isSafeInteger(v["offset"]) &&
    typeof v["sha256"] === "string" &&
    (v["kind"] === "corrupt-line" || v["kind"] === "blob-pending") &&
    typeof v["reason"] === "string" &&
    typeof v["quarantined_at"] === "string"
  );
}

const loaded = new Map<string, { readonly stamp: string; readonly ledger: Ledger }>();

/**
 * The entries the reader applies from a parsed ledger file. It fails
 * closed: anything but an object of version {@link QUARANTINE_LEDGER_VERSION}
 * with a `lines` list (another version, a non-object, no list) applies no
 * entry, so every line it names stays a gap. Within such a ledger each
 * entry stands on its own: one this release does not read (a newer
 * build's kind, a missing field) applies nothing, and the others still
 * apply. Skipping an entry only leaves its line a gap, so neither rule
 * ever makes a shard read as whole.
 */
export function appliedLines(parsed: unknown): QuarantineLine[] {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const { version, lines } = parsed as { version?: unknown; lines?: unknown };
  if (version !== QUARANTINE_LEDGER_VERSION || !Array.isArray(lines)) return [];
  return lines.filter(isLine);
}

/**
 * The ledger of `root`, read again only when its file changed. An
 * unreadable ledger, or one {@link appliedLines} does not accept,
 * quarantines nothing.
 */
export function load(root: string): Ledger {
  const path = ledgerPath(root);
  let stamp: string;
  try {
    stamp = stampOf(path);
  } catch {
    return { root: resolve(root), lines: [] };
  }
  const hit = loaded.get(path);
  if (hit !== undefined && hit.stamp === stamp) return hit.ledger;
  let lines: QuarantineLine[] = [];
  if (stamp !== "absent") {
    try {
      lines = appliedLines(JSON.parse(readFileSync(path, "utf8")));
    } catch {
      lines = [];
    }
  }
  const ledger = { root: resolve(root), lines };
  loaded.set(path, { stamp, ledger });
  return ledger;
}

/** Forget the cached ledger at `path`, so the next read takes the file. */
export function dropLoadedLedger(path: string): void {
  loaded.delete(path);
}

/**
 * The size and mtime of the ledger of the store at `root` (`absent` when
 * there is none). A cache of a whole read keys on it beside the shards'
 * stamps: a quarantine or a release changes no shard byte, yet changes
 * whether a shard reads whole.
 */
export function quarantineStamp(root: string): string {
  try {
    return stampOf(ledgerPath(root));
  } catch {
    return "unreadable";
  }
}

/** The ledger's line order: partition, shard, offset. */
export function compareLines(a: QuarantineLine, b: QuarantineLine): number {
  if (a.partition !== b.partition) return a.partition < b.partition ? -1 : 1;
  if (a.shard !== b.shard) return a.shard < b.shard ? -1 : 1;
  return a.offset - b.offset;
}

/** Whether `line` is the entry of that offset of that shard. */
export const sameLine = (
  line: QuarantineLine,
  partition: StorePartition,
  shard: string,
  offset: number,
): boolean => line.partition === partition && line.shard === shard && line.offset === offset;

/** What the reader matches a line against: the entry's line hash and kind. */
export interface QuarantinedLine {
  readonly sha256: string;
  readonly kind: QuarantineKind;
}

/**
 * The quarantined lines of one shard, offset to line hash and kind, for
 * the reader. `partitionRoot` is `<store root>/<partition>`; `rel` the
 * shard's partition-relative path. Empty when the ledger names none.
 */
export function quarantinedLines(
  partitionRoot: string,
  rel: string,
): ReadonlyMap<number, QuarantinedLine> {
  const partition = resolve(partitionRoot).split(/[\\/]/).pop();
  if (!isPartition(partition)) return new Map();
  const out = new Map<number, QuarantinedLine>();
  for (const line of load(resolve(partitionRoot, "..")).lines) {
    if (line.partition === partition && line.shard === rel) {
      out.set(line.offset, { sha256: line.sha256, kind: line.kind });
    }
  }
  return out;
}

const HASH_CHUNK_BYTES = 64 * 1024;

/**
 * The longest line a quarantine entry can name: sixty-four times the store
 * line cap (1 MiB). The reader reports a run past the line cap as a corrupt
 * line, so such a line stays quarantinable up to this bound; past it the
 * hash is `null` and the line stays a gap. The bound keeps a hash from
 * reading without end (a file with no newline).
 */
export const QUARANTINE_HASH_CAP_BYTES = 64 * STORE_LINE_CAP_BYTES;

/**
 * What hashing one line found: its hash, or why there is none. `too-long`:
 * the line runs past {@link QUARANTINE_HASH_CAP_BYTES} with no newline, which
 * stays so until the bytes change. `unreadable`: the file holds nothing at
 * the offset, cannot be opened through the guarded open, or the read failed.
 */
export type LineHashProbe =
  | { readonly sha256: string }
  | { readonly failure: "too-long" | "unreadable" };

/**
 * Hash the bytes of the open file `fd` from `offset` through the next
 * newline (or the end of the file), newline included.
 */
export function probeLineHashAtFd(fd: number, offset: number): LineHashProbe {
  try {
    const hash = createHash("sha256");
    const chunk = Buffer.alloc(HASH_CHUNK_BYTES);
    let position = offset;
    let read = 0;
    for (;;) {
      const want = Math.min(chunk.length, QUARANTINE_HASH_CAP_BYTES - read + 1);
      const n = readSync(fd, chunk, 0, want, position);
      if (n === 0) break;
      const end = chunk.subarray(0, n).indexOf(0x0a);
      const take = end === -1 ? n : end + 1;
      if (read + take > QUARANTINE_HASH_CAP_BYTES) return { failure: "too-long" };
      hash.update(chunk.subarray(0, take));
      read += take;
      if (end !== -1) break;
      position += n;
    }
    return read === 0 ? { failure: "unreadable" } : { sha256: hash.digest("hex") };
  } catch {
    return { failure: "unreadable" };
  }
}

/**
 * {@link probeLineHashAtFd} of the shard at `path`, opened through the
 * reader's guarded open with its partition root: `unreadable` when the name
 * is a symbolic link, a special file, reached through a linked folder
 * inside the partition, or cannot be opened.
 */
export function probeLineHashAt(
  path: string,
  offset: number,
  partitionRoot: string,
): LineHashProbe {
  let fd: number | null;
  try {
    fd = openRegularFileForRead(path, partitionRoot);
  } catch {
    return { failure: "unreadable" };
  }
  if (fd === null) return { failure: "unreadable" };
  try {
    return probeLineHashAtFd(fd, offset);
  } finally {
    closeSync(fd);
  }
}

const hashOf = (probe: LineHashProbe): string | null => ("sha256" in probe ? probe.sha256 : null);

/**
 * The hash of the bytes of the open file `fd` from `offset` through the
 * next newline (or the end of the file), newline included; `null` when the
 * file holds nothing at `offset`, cannot be read, or the line runs past
 * {@link QUARANTINE_HASH_CAP_BYTES}.
 */
export function lineSha256AtFd(fd: number, offset: number): string | null {
  return hashOf(probeLineHashAtFd(fd, offset));
}

/**
 * {@link lineSha256AtFd} of the shard at `path`, opened through the
 * reader's guarded open with its partition root: `null` when the name is a
 * symbolic link, a special file, reached through a linked folder inside the
 * partition, or cannot be opened. `null` fails closed: it matches no entry.
 */
export function lineSha256At(path: string, offset: number, partitionRoot: string): string | null {
  return hashOf(probeLineHashAt(path, offset, partitionRoot));
}

/** What {@link listQuarantine} needs of a shard read: where its records are and which wait for a blob. */
export interface QuarantineShardRead {
  readonly records: ReadonlyArray<{ readonly offset: number; readonly bodyState: string }>;
}

/** The shard reader {@link listQuarantine} asks (`readShard` of `reader.ts`). */
export type QuarantineShardReader = (
  path: string,
  options: { readonly partitionRoot: string },
) => QuarantineShardRead;

/**
 * Every quarantined line of the store at `root`, with its state, in ledger
 * order. Each shard is parsed at most once per call (`read` runs once per
 * shard, and only for a shard with an entry whose bytes still match); the
 * staleness probe hashes each entry's line on its own, so it opens the
 * shard once per entry. A shard whose read throws
 * affects only its own entries: an entry whose bytes still match is then
 * reported `held` (the entry is still in force and the reader still skips
 * the line), never `resolved`.
 */
export function listQuarantine(
  root: string,
  read: QuarantineShardReader,
): ReadonlyArray<QuarantineListEntry> {
  const out: QuarantineListEntry[] = [];
  const reads = new Map<string, QuarantineShardRead | null>();
  const readOnce = (path: string, partitionRoot: string): QuarantineShardRead | null => {
    if (!reads.has(path)) {
      let result: QuarantineShardRead | null;
      try {
        result = read(path, { partitionRoot });
      } catch {
        result = null;
      }
      reads.set(path, result);
    }
    return reads.get(path) ?? null;
  };
  for (const line of load(root).lines.toSorted(compareLines)) {
    const partitionRoot = join(resolve(root), line.partition);
    const path = join(partitionRoot, ...line.shard.split("/"));
    let state: QuarantineState;
    if (lineSha256At(path, line.offset, partitionRoot) !== line.sha256) state = "stale";
    else {
      const record = readOnce(path, partitionRoot)?.records.find((r) => r.offset === line.offset);
      state = record !== undefined && record.bodyState !== "pending" ? "resolved" : "held";
    }
    out.push({ ...line, state });
  }
  return out;
}
