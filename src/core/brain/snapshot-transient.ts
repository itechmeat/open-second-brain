/**
 * What a Brain snapshot leaves out because it is provably a transient file
 * of the product itself, and nothing else (the one rule the archive list,
 * its sidecar manifest and the retry after a tar failure share).
 *
 * `Brain/` is a tree a person and a file sync write into too, and a
 * snapshot is the backup before a destructive step: a file it leaves out
 * is gone for good after a rollback to it. So a name alone never decides
 * (a person's `notes.md.lock` or `draft.tmp` is archived like any file).
 * An entry is left out only when it has a form no content has:
 *
 *  - `atomic-temp`: the dotted temp file of `atomicWriteFileSync`
 *    (`.<target>.<pid>.<ms>.<hex>.tmp`, `fs-atomic.ts`), which that writer
 *    renames onto its target or removes;
 *  - `lock-stamped`: a `<target>.lock` file whose body is exactly the
 *    stamp `sync-lockfile.ts` writes into every lock it creates (pid,
 *    random UUID and an ISO time, or `null` and the time on Windows:
 *    `LOCK_STAMP_BODY_RE`);
 *  - `shard-lock`: an EMPTY `<shard>.jsonl.lock` file, the lock of an
 *    append shard (metrics, ledgers) between its create and its stamp. A
 *    surface's first row creates the `.jsonl` under that lock, so the lock
 *    exists before its target, and this is the case a start's own metrics
 *    append met beside the upgrade worker's snapshot. It holds no byte;
 *  - `lock-directory`: an EMPTY directory `<target>.lock` beside an
 *    existing `<target>`, the form `proper-lockfile` takes (the trigger
 *    store, `withFileLock`). It holds no file.
 *
 * Everything else, an unknown `.lock` or `.tmp` included, is archived.
 */
import { closeSync, readdirSync, readSync, type Stats } from "node:fs";

import { isAtomicWriteTemp, lockSiblingOriginal } from "../fs-atomic.ts";
import { openRegularFileForRead } from "../store/safe-fs.ts";
import { LOCK_STAMP_BODY_RE } from "./sync-lockfile.ts";

export type ProductTransientKind =
  | "atomic-temp"
  | "lock-stamped"
  | "shard-lock"
  | "lock-directory"
  /**
   * Gone between the caller's `lstat` and the read that classifies it
   * (ENOENT only): the walk's rule for an entry that vanished applies, and
   * every caller leaves it out. Any other read error is content.
   */
  | "vanished";

/** The longest body a stamped lock has (pid, UUID, ISO time and newlines: under 100 bytes), with room. */
const STAMP_MAX_BYTES = 128;

function isGone(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

/**
 * At most `STAMP_MAX_BYTES + 1` bytes of the file at `abs`, never more
 * whatever it grew to since its `lstat`, or null when it is no regular
 * file now. Opened through the store readers' guarded opener
 * (`openRegularFileForRead`): never through a symbolic link, and never
 * blocking on a FIFO swapped in after the `lstat` (a non-blocking open,
 * then an `fstat` that refuses a non-regular descriptor), which would
 * otherwise hold the snapshot before tar and its timeout for good.
 */
function readHead(abs: string | Buffer): Buffer | null {
  const fd = openRegularFileForRead(abs);
  if (fd === null) return null;
  try {
    const buf = Buffer.alloc(STAMP_MAX_BYTES + 1);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

/**
 * Which product transient the entry at `abs` (base name `name`, its
 * `lstat` `stat`: a symbolic link is never followed, so a link named
 * `*.lock` is content) is, or null for content. `targetExists` answers
 * whether the lock's target exists beside it (the caller knows the
 * directory it walks). A file larger than the stamp is content without a
 * read, and the read that classifies a small one is bounded.
 */
export function productTransientKind(
  abs: string | Buffer,
  name: string,
  stat: Stats,
  targetExists: (original: string) => boolean,
): ProductTransientKind | null {
  if (stat.isFile() && isAtomicWriteTemp(name)) return "atomic-temp";
  const original = lockSiblingOriginal(name);
  if (original === null) return null;
  if (stat.isDirectory()) {
    if (!targetExists(original)) return null;
    try {
      return readdirSync(abs).length === 0 ? "lock-directory" : null;
    } catch (err) {
      return isGone(err) ? "vanished" : null;
    }
  }
  if (!stat.isFile()) return null;
  if (stat.size > STAMP_MAX_BYTES) return null;
  // Read even when the lstat said empty: a writer may have put bytes in it
  // since, and an append-shard lock is one only while it is really empty.
  let head: Buffer | null;
  try {
    head = readHead(abs);
  } catch (err) {
    return isGone(err) ? "vanished" : null;
  }
  // No regular file any more (a FIFO, a link, a directory swapped in): content.
  if (head === null) return null;
  if (head.length === 0) return original.endsWith(".jsonl") ? "shard-lock" : null;
  if (head.length > STAMP_MAX_BYTES) return null;
  return LOCK_STAMP_BODY_RE.test(head.toString("utf8")) ? "lock-stamped" : null;
}
