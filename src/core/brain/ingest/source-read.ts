/**
 * The shared bounded source-read substrate (Lane 5, t_a9cd4221).
 *
 * Everything the ingest lane's file reads share, hoisted into one leaf so
 * the whole-read and the from-offset tail read ({@link ./tail-read.ts})
 * cannot grow import cycles around the pipeline module:
 *
 *   - the one open discipline: read-only, never blocking, so a FIFO met
 *     where a file was expected cannot stall the server;
 *   - the named refusal vocabulary every bounded read answers with - data
 *     on the wire, never a thrown error;
 *   - the whole-source bounded read itself;
 *   - the shared scale cap: the largest source the code-structure pass
 *     reads, which is also the scale at which an appended tail stops being
 *     a delta and becomes a reprocess.
 *
 * Language-agnostic: bytes in, decoded UTF-8 text out; no natural-language
 * content is inspected.
 */

import { closeSync, constants as fsConstants, fstatSync, openSync, readSync } from "node:fs";

/**
 * The largest source the code-structure pass reads. A hand-written module
 * is far smaller; a larger file is generated or vendored, and its seeds are
 * not worth a parse whose cost grows with the file.
 */
export const PRE_EXTRACT_MAX_SOURCE_BYTES = 1_048_576;

/** Why a source read yields no text, apart from a thrown error. */
export const SOURCE_UNREAD = Object.freeze({
  notAFile: "not a regular file",
  tooLarge: "larger than the read limit",
} as const);

/** Why a bounded source read read no text. */
export type SourceUnread = (typeof SOURCE_UNREAD)[keyof typeof SOURCE_UNREAD];

/**
 * How a source is opened: read-only and never blocking, so a FIFO met
 * where a file was expected cannot stall the server. No `O_NOFOLLOW`: an
 * in-vault symlink is admitted by the containment check in
 * `runPreExtract` (`resolvesInsideVault`). The flag
 * is POSIX; where the platform lacks it it is simply absent.
 */
export const SOURCE_OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NONBLOCK ?? 0);

/**
 * Read a source through ONE descriptor, so the checks hold for the bytes
 * read: the descriptor must be a regular file, and no more than `maxBytes`
 * is read however large the file has grown since the `fstat`. The buffer is
 * sized to the file plus one byte, so a small source costs a small buffer;
 * a file that grew under the cap is read on into one buffer of the cap plus
 * one byte. `bytes` are exactly the bytes read, for a caller that must judge
 * their encoding itself.
 */
export function readSourceBounded(
  absolute: string,
  maxBytes: number,
):
  | { readonly text: string; readonly bytes: Uint8Array; readonly unread?: undefined }
  | { readonly text: null; readonly bytes?: undefined; readonly unread: SourceUnread } {
  const fd = openSync(absolute, SOURCE_OPEN_FLAGS);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return { text: null, unread: SOURCE_UNREAD.notAFile };
    if (stat.size > maxBytes) return { text: null, unread: SOURCE_UNREAD.tooLarge };
    // One byte past the size, so growth since the fstat is seen.
    let buffer = Buffer.allocUnsafe(stat.size + 1);
    let filled = 0;
    for (;;) {
      // A full buffer is under the cap here: past it, the loop has returned.
      if (filled === buffer.length) buffer = Buffer.concat([buffer], maxBytes + 1);
      const count = readSync(fd, buffer, filled, buffer.length - filled, null);
      if (count === 0) break;
      filled += count;
      if (filled > maxBytes) return { text: null, unread: SOURCE_UNREAD.tooLarge };
    }
    const bytes = buffer.subarray(0, filled);
    return { text: bytes.toString("utf8"), bytes };
  } finally {
    closeSync(fd);
  }
}
