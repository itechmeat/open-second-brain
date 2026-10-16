/**
 * The from-offset tail read for appended source text (t_a9cd4221).
 *
 * A growing source (a chat log, a session transcript) is re-extracted one
 * appended delta at a time instead of whole, keyed on the extraction
 * watermark the content manifest records ({@link ./content-manifest.ts}).
 * This module is the byte discipline that makes such a watermark honest:
 *
 *   - Deltas are measured and sliced in BYTES, but the emitted text is cut
 *     only at UTF-8-safe boundaries: the start snaps forward past any
 *     partial multi-byte sequence a mid-codepoint offset can land on, and
 *     the end is cut after the LAST complete newline, so an unfinished
 *     trailing line stays uncovered for the next delta instead of being
 *     covered by two deltas that each carry a fragment of it.
 *   - `fromByte`/`toByte` are the exact byte range the returned text was
 *     decoded from. A watermark stamped at `toByte` therefore never
 *     overlaps the next delta and never claims bytes the text does not
 *     carry. When no complete line exists in the appended range, the
 *     delta covers nothing (`toByte === fromByte`) - and what happens to
 *     the watermark then is the CALLER's decision, not this module's.
 *     The production caller ({@link ./ingest.ts}) stamps the extraction
 *     watermark at the announced delta's `toByte`, so an empty delta
 *     leaves the watermark at `fromByte`: the unterminated trailing
 *     fragment stays unstamped, and the next append's delta starts AT it
 *     rather than past it - the fragment is stitched into the series the
 *     first time an append ends with a newline. The ingest lane accepts
 *     the trade because extraction itself stays whole-source - the
 *     fragment is extracted, just never announced as a delta on its own.
 *   - A file that SHRANK below the offset (rotated, truncated, rewritten)
 *     falls back to the full current content with the shrink NAMED - the
 *     full-reprocess direction, never a bogus negative slice.
 *   - The read is bounded: past `maxBytes` it refuses with the shared
 *     bounded-read refusal vocabulary ({@link SOURCE_UNREAD}), the same
 *     names {@link ./ingest.ts} answers bounded reads with.
 *
 * One descriptor per read, positioned reads past the offset: a delta of a
 * large log costs the delta's bytes, not the file's.
 *
 * Language-agnostic: bytes in, decoded UTF-8 text out; no natural-language
 * content is inspected.
 */

import { closeSync, fstatSync, openSync, readSync } from "node:fs";

import {
  PRE_EXTRACT_MAX_SOURCE_BYTES,
  SOURCE_OPEN_FLAGS,
  SOURCE_UNREAD,
  type SourceUnread,
} from "./source-read.ts";

/** Bytes pulled per positioned read, so a delta never over-allocates. */
const READ_CHUNK_BYTES = 65_536;

/** UTF-8 continuation byte: 0b10xxxxxx - never a codepoint start. */
function isContinuationByte(byte: number): boolean {
  return (byte & 0b1100_0000) === 0b1000_0000;
}

/** What one tail read concluded. */
export type TailReadResult =
  | {
      /** Text was appended past `fromByte` (possibly only up to a line boundary). */
      readonly kind: "appended";
      /** The decoded delta text; empty when no complete line exists yet. */
      readonly text: string;
      /** First byte of the source the returned text was decoded from. */
      readonly fromByte: number;
      /** One past the last byte the text covers - the watermark position. */
      readonly toByte: number;
    }
  | {
      /** The file shrank below `fromByte`; the FULL content is the answer. */
      readonly kind: "shrank";
      readonly text: string;
      readonly fromByte: 0;
      readonly toByte: number;
    }
  | {
      /** The read refused: not a regular file, or past the ceiling. */
      readonly kind: "unread";
      readonly unread: SourceUnread;
    };

export interface TailReadOptions {
  /**
   * The most text one read may pull, in bytes. Absent: the same ceiling the
   * code-structure pre-extract pass applies - a tail past it is a
   * reprocess-scale change, not a delta.
   */
  readonly maxBytes?: number;
}

/**
 * Read the text appended to `absolute` since `fromByte`, boundary-safe and
 * bounded. A missing file throws (the caller that opened the ingest knows
 * the source existed moments ago; a vanished source is its own named error,
 * exactly as for {@link ./ingest.ts}'s bounded read).
 */
export function readTail(
  absolute: string,
  fromByte: number,
  opts: TailReadOptions = {},
): TailReadResult {
  const maxBytes = opts.maxBytes ?? PRE_EXTRACT_MAX_SOURCE_BYTES;
  const fd = openSync(absolute, SOURCE_OPEN_FLAGS);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { kind: "unread", unread: SOURCE_UNREAD.notAFile };
    if (stat.size < fromByte) {
      const full = readFrom(fd, 0, maxBytes);
      if (full.overCeiling) return { kind: "unread", unread: SOURCE_UNREAD.tooLarge };
      return {
        kind: "shrank",
        text: Buffer.from(full.bytes).toString("utf8"),
        fromByte: 0,
        toByte: full.bytes.length,
      };
    }
    const tail = readFrom(fd, fromByte, maxBytes);
    if (tail.overCeiling) return { kind: "unread", unread: SOURCE_UNREAD.tooLarge };
    return appendedDelta(tail.bytes, fromByte);
  } finally {
    closeSync(fd);
  }
}

/**
 * Cut the appended bytes into an honest delta: decode from the first
 * UTF-8-safe boundary, through the last complete newline, and report the
 * exact byte range the text covers. Exported so the single-pass append
 * snapshot ({@link ./ingest.ts}) cuts the tail bytes it already read with
 * the same discipline {@link readTail} applies, never a second cut rule.
 */
export interface AppendedCut {
  /** The decoded delta text; empty when no complete line exists yet. */
  readonly text: string;
  /** First byte of the source the returned text was decoded from. */
  readonly fromByte: number;
  /** One past the last byte the text covers - the watermark position. */
  readonly toByte: number;
}

export function cutAppendedDelta(bytes: Uint8Array, fromByte: number): AppendedCut {
  let start = 0;
  while (start < bytes.length && isContinuationByte(bytes[start]!)) start++;
  // One past the last complete newline; `start` when the range holds no
  // complete line, in which case the delta covers nothing.
  let end = bytes.length;
  while (end > start && bytes[end - 1] !== 0x0a) end--;
  return {
    text: Buffer.from(bytes.subarray(0, end).subarray(start)).toString("utf8"),
    fromByte: fromByte + start,
    toByte: fromByte + end,
  };
}

/**
 * Shape {@link cutAppendedDelta} into a full tail-read answer.
 */
function appendedDelta(bytes: Uint8Array, fromByte: number): TailReadResult {
  return { kind: "appended", ...cutAppendedDelta(bytes, fromByte) };
}

/**
 * Positioned reads from `start` through EOF, at most `maxBytes` bytes.
 * `overCeiling` is the named refusal: the caller answers with
 * {@link SOURCE_UNREAD.tooLarge} rather than truncating silently.
 */
function readFrom(
  fd: number,
  start: number,
  maxBytes: number,
): { readonly bytes: Uint8Array; readonly overCeiling: boolean } {
  const chunks: Buffer[] = [];
  let filled = 0;
  let position = start;
  for (;;) {
    const chunk = Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - filled));
    const count = readSync(fd, chunk, 0, chunk.length, position);
    if (count === 0) break;
    chunks.push(count === chunk.length ? chunk : chunk.subarray(0, count));
    filled += count;
    position += count;
    if (filled > maxBytes) return { bytes: Buffer.concat(chunks), overCeiling: true };
  }
  return { bytes: Buffer.concat(chunks), overCeiling: false };
}
