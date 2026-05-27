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

import {
  closeSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export function atomicWriteFileSync(target: string, contents: string): void {
  withTempFile(target, contents, (tmpPath) => {
    // POSIX `rename(2)` is atomic and clobbers an existing target — that's
    // exactly the "overwrite" semantic we want. No exclusivity guarantee.
    renameSync(tmpPath, target);
  });
}

/**
 * Like {@link atomicWriteFileSync} but fails with `EEXIST` if `target`
 * already exists, atomically. Implemented via `link(2)` instead of
 * `rename(2)` because POSIX `link` returns EEXIST when the destination
 * inode is taken — there is no `rename`-with-no-clobber primitive that's
 * portable.
 *
 * Use this where the caller's "refuse to overwrite" guarantee must be
 * race-free: a plain `existsSync(target) || writeFileSync(...)` is
 * vulnerable to TOCTOU when two processes (CLI + MCP server, concurrent
 * agents) target the same path in parallel.
 *
 * Requires `tmpPath` and `target` to live on the same filesystem, which
 * is guaranteed because the temp file is placed alongside the target.
 */
export function atomicCreateFileSyncExclusive(target: string, contents: string): void {
  withTempFile(target, contents, (tmpPath) => {
    try {
      linkSync(tmpPath, target);
    } finally {
      // Always remove the temp inode regardless of whether linkSync
      // succeeded — the temp is an implementation detail.
      try {
        unlinkSync(tmpPath);
      } catch {
        // already gone; ignore
      }
    }
  });
}

/**
 * Internal helper: write `contents` to a sibling temp file (atomic + fsynced),
 * then call `commit` to attach the temp inode to the final path. The temp
 * file is unlinked on any failure; durability fsync of the parent directory
 * is best-effort after a successful commit.
 */
function withTempFile(target: string, contents: string, commit: (tmpPath: string) => void): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });

  // pid + ms timestamp alone collide when two writes for the same target
  // hit within the same millisecond (concurrent writers bypassing the
  // lockfile path). The random suffix makes openSync(..., "wx") safely
  // unique even in that race.
  const tmpName = `.${basename(target)}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  const tmpPath = join(dir, tmpName);

  let fd: number | null = null;
  let committed = false;
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
    commit(tmpPath);
    committed = true;

    // Durably persist the new directory entry by fsyncing the parent dir.
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
      // the rename/link itself is already atomic at the inode level.
    }
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore
      }
    }
    if (!committed) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // tmp file may not exist if openSync failed
      }
    }
    throw err;
  }
}
