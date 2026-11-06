/**
 * The verified-prefix hash of a shard watermark (design D5).
 *
 * Catch-up must notice a shard that was rewritten under the same name,
 * inode and size (a sync tool writing in place, a restored copy), or it
 * would resume from an offset that no longer starts a line. Re-hashing the
 * whole verified prefix on every append would cost a full read of the
 * shard each time it grows, so the hash covers samples of the prefix: its
 * length, its first {@link PREFIX_SAMPLE_BYTES} bytes and the last
 * {@link PREFIX_SAMPLE_BYTES} bytes before the offset. A rewrite that
 * keeps the length and both samples byte for byte is not detected; any
 * other rewrite is.
 *
 * Only a shard whose stat changed is hashed, so an unchanged store opens
 * no file.
 */

import { closeSync, openSync, readSync } from "node:fs";

import { sha256Hex } from "../../integrity/digest.ts";

/** Bytes sampled from each end of the verified prefix. */
export const PREFIX_SAMPLE_BYTES = 4096;

function readAt(fd: number, position: number, length: number): Buffer {
  const out = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const n = readSync(fd, out, read, length - read, position + read);
    if (n === 0) break;
    read += n;
  }
  return out.subarray(0, read);
}

/** The hash of the first `offset` bytes of the shard at `path`, as sampled. */
export function prefixHash(path: string, offset: number): string {
  if (offset <= 0) return sha256Hex("0:");
  const fd = openSync(path, "r");
  try {
    const headLength = Math.min(PREFIX_SAMPLE_BYTES, offset);
    const head = readAt(fd, 0, headLength);
    const tailStart = Math.max(headLength, offset - PREFIX_SAMPLE_BYTES);
    const tail = readAt(fd, tailStart, offset - tailStart);
    return sha256Hex(Buffer.concat([Buffer.from(`${offset}:`), head, tail]));
  } finally {
    closeSync(fd);
  }
}
