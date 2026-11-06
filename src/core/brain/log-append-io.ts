/**
 * Append-only file I/O for the Brain log shards (`log.ts`).
 *
 * The appender used to read a whole day shard and rewrite it through a
 * temp file and a rename for every event, which cost the size of the day
 * file per event. This module gives it the two primitives an append
 * needs instead, both bounded by the size of the file's TAIL:
 *
 *   - {@link scanLinesFromEnd} walks a file's lines backwards in chunks
 *     and stops at the first line the caller accepts, so the hash chain
 *     finds its predecessor without reading the day.
 *   - {@link appendSeparated} adds one block with exactly the bytes the
 *     old rewrite produced (`trimEnd(existing) + separator + block`),
 *     reading only the trailing whitespace. In the normal case that is a
 *     single write on a descriptor opened with the append flag; only an
 *     unusual whitespace tail (blank lines an editor left) is trimmed in
 *     place with a truncate first.
 *
 * Callers hold the log directory lock (`acquireLogLock`); nothing here
 * locks. A write that fails part way is undone (the file is cut back to
 * the bytes it had), so a full disk leaves the shard as it was rather than
 * with a torn row. Durability matches the atomic writer the appender used before:
 * the file is fsynced after the write, and the parent directory is
 * fsynced best-effort when the write created the file.
 */

import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  openSync,
  readSync,
  truncateSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

const NEWLINE = 0x0a;
/** Bytes read per backward step; one chunk holds many log rows. */
const TAIL_CHUNK_BYTES = 64 * 1024;
/** Bytes inspected for trailing whitespace before falling back to a full read. */
const WHITESPACE_PROBE_BYTES = 4 * 1024;

function readAt(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, buf, read, length - read, position + read);
    if (n === 0) break;
    read += n;
  }
  return read === length ? buf : buf.subarray(0, read);
}

function writeAll(fd: number, data: Buffer, position: number | null): void {
  let written = 0;
  while (written < data.byteLength) {
    written += writeSync(
      fd,
      data,
      written,
      data.byteLength - written,
      position === null ? null : position + written,
    );
  }
}

/**
 * Write `data` at `position` (or at the end, for `null`) and fsync. When
 * the write or the fsync fails (a full disk, an I/O error), the file is
 * cut back to `restoreSize` bytes and `restoreTail` is written after them,
 * best effort, before the error is rethrown: a write that stopped half way
 * must not leave a torn row in the shard that every later read and the
 * hash-chain check would then see as damage.
 */
function writeOrRestore(
  path: string,
  fd: number,
  data: Buffer,
  position: number | null,
  restoreSize: number,
  restoreTail: Buffer = Buffer.alloc(0),
): void {
  try {
    writeAll(fd, data, position);
    fsyncSync(fd);
  } catch (err) {
    try {
      try {
        ftruncateSync(fd, restoreSize);
      } catch {
        // A descriptor opened for appending may not truncate (Windows
        // grants it append access only); the path can.
        truncateSync(path, restoreSize);
      }
      if (restoreTail.byteLength > 0) writeAll(fd, restoreTail, restoreSize);
      fsyncSync(fd);
    } catch {
      // Best effort: the original error is the one the caller must see.
    }
    throw err;
  }
}

/** Open for reading, or `null` when the file does not exist. */
function openForRead(path: string): number | null {
  try {
    return openSync(path, "r");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/**
 * Visit the lines of `path` from the last to the first, decoded as
 * UTF-8, and return the first non-`null` answer `visit` gives. A final
 * line without a trailing newline is still a line, exactly as
 * `text.split(/\r?\n/)` would yield it; a trailing `\r` is dropped.
 * Returns `null` for a missing or empty file or when no line answers.
 *
 * Splitting happens on the raw `\n` byte, which never occurs inside a
 * multi-byte UTF-8 sequence, so a chunk boundary cannot corrupt a line.
 */
export function scanLinesFromEnd<T>(path: string, visit: (line: string) => T | null): T | null {
  const fd = openForRead(path);
  if (fd === null) return null;
  try {
    let position = fstatSync(fd).size;
    // The bytes after the last newline seen so far, as the chunks that hold
    // them (front first). They hold no newline, so only a freshly read chunk
    // is ever scanned, and they are joined once, when their line is visited:
    // a long line costs its length, not its length squared.
    let carry: Buffer[] = [];
    while (position > 0) {
      const size = Math.min(TAIL_CHUNK_BYTES, position);
      position -= size;
      const chunk = readAt(fd, position, size);
      let end = chunk.length;
      for (let i = chunk.length - 1; i >= 0; i--) {
        if (chunk[i] !== NEWLINE) continue;
        const head = chunk.subarray(i + 1, end);
        const line = carry.length > 0 ? Buffer.concat([head, ...carry]) : head;
        const answer = visitSegment(line, 0, line.length, visit);
        if (answer !== null) return answer;
        carry = [];
        end = i;
      }
      // Everything before the first newline may continue in the previous chunk.
      if (end > 0) carry.unshift(chunk.subarray(0, end));
    }
    if (carry.length === 0) return null;
    const first = Buffer.concat(carry);
    return visitSegment(first, 0, first.length, visit);
  } finally {
    closeSync(fd);
  }
}

function visitSegment<T>(
  buf: Buffer,
  start: number,
  end: number,
  visit: (line: string) => T | null,
): T | null {
  let stop = end;
  if (stop > start && buf[stop - 1] === 0x0d) stop--;
  return visit(buf.toString("utf8", start, stop));
}

/** Trailing whitespace of the file as `/\s+$/` sees it, and its byte length. */
function trailingWhitespace(fd: number, size: number): { text: string; bytes: number } {
  let probe = Math.min(WHITESPACE_PROBE_BYTES, size);
  for (;;) {
    const tail = readAt(fd, size - probe, probe).toString("utf8");
    const text = /\s+$/.exec(tail)?.[0] ?? "";
    // A probe that is whitespace all the way back may have cut the run
    // short; widen it until the run ends inside the probe or the file does.
    if (text.length < tail.length || probe === size) {
      return { text, bytes: Buffer.byteLength(text, "utf8") };
    }
    probe = Math.min(probe * 4, size);
  }
}

function fsyncDirBestEffort(path: string): void {
  try {
    const dfd = openSync(dirname(path), "r");
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // Directory fsync is a best-effort durability step; some platforms refuse it.
  }
}

/**
 * Append `block` to `path` so the file ends up byte-identical to
 * `existing.replace(/\s+$/, "") + separator + block`, or to `initial`
 * when the file is missing or empty.
 *
 * The trailing whitespace already on disk decides the write: when it is
 * a prefix of `separator` (the shape every append leaves), the missing
 * rest of the separator and the block go out in one append. Any other
 * whitespace tail is truncated away first, then the separator and block
 * are written in its place. Nothing before the trailing whitespace is
 * ever read or rewritten.
 */
export function appendSeparated(
  path: string,
  block: string,
  separator: string,
  initial: string,
): void {
  const readFd = openForRead(path);
  let size = 0;
  let whitespace = { text: "", bytes: 0 };
  if (readFd !== null) {
    try {
      size = fstatSync(readFd).size;
      if (size > 0) whitespace = trailingWhitespace(readFd, size);
    } finally {
      closeSync(readFd);
    }
  }

  if (size === 0) {
    const fd = openSync(path, "a");
    try {
      writeOrRestore(path, fd, Buffer.from(initial, "utf8"), null, 0);
    } finally {
      closeSync(fd);
    }
    fsyncDirBestEffort(path);
    return;
  }

  if (separator.startsWith(whitespace.text)) {
    const fd = openSync(path, "a");
    try {
      writeOrRestore(
        path,
        fd,
        Buffer.from(separator.slice(whitespace.text.length) + block, "utf8"),
        null,
        size,
      );
    } finally {
      closeSync(fd);
    }
    return;
  }

  const keep = size - whitespace.bytes;
  const fd = openSync(path, "r+");
  try {
    ftruncateSync(fd, keep);
    writeOrRestore(
      path,
      fd,
      Buffer.from(separator + block, "utf8"),
      keep,
      keep,
      Buffer.from(whitespace.text, "utf8"),
    );
  } finally {
    closeSync(fd);
  }
}
