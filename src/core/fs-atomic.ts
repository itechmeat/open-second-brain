/**
 * Atomic file write helper.
 *
 * Writes the payload to a sibling temp file in the same directory, fsyncs it,
 * then renames over the target. An interrupted run leaves either the previous
 * version or the new one — never a half-written hybrid. Mirrors the Python
 * implementation in `set_config_value` and `append_event`.
 *
 * Parent-directory fsync is included so that a crash immediately after the
 * rename still surfaces the new file on remount (POSIX requires fsync of the
 * directory entry to durably persist the rename).
 */

import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function atomicWriteFileSync(target: string, contents: string): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });

  // pid + ms timestamp alone collide when two writes for the same target
  // hit within the same millisecond (e.g. concurrent appendEvent calls
  // bypassing the lockfile path). The random suffix makes openSync(..., "wx")
  // safely unique even in that race.
  const tmpName = `.${basename(target)}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  const tmpPath = join(dir, tmpName);

  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, "wx", 0o644);
    const buf = Buffer.from(contents, "utf8");
    let written = 0;
    while (written < buf.byteLength) {
      written += writeSync(fd, buf, written, buf.byteLength - written);
    }
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    renameSync(tmpPath, target);

    // Durably persist the rename by fsyncing the parent directory.
    // Node has no portable directory fsync; on Linux the open-O_RDONLY trick works.
    try {
      const dfd = openSync(dir, "r");
      try {
        fsyncSync(dfd);
      } finally {
        closeSync(dfd);
      }
    } catch {
      // Directory fsync is a best-effort durability optimization.
      // Failure on platforms that don't support it (rare) is not fatal —
      // the rename itself is already atomic at the inode level.
    }
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    try {
      unlinkSync(tmpPath);
    } catch {
      // tmp file may not exist if openSync failed
    }
    throw err;
  }
}
