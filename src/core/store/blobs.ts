/**
 * Content-addressed blobs of the brain store (design D1, D2).
 *
 * A blob is the canonical JSON of a record body that was too large for a
 * shard line, stored at `<partition>/blobs/<sha[0:2]>/<sha>`, where the
 * name is the sha256 of the content. Blobs are immutable: a blob is
 * created once and never changed. Two processes spilling the same body
 * race for one name, and the loser simply finds the blob already there.
 *
 * How a blob is created, so that no reader on this machine sees a
 * half-written one and nothing temporary lands where a sync tool picks it
 * up as data:
 *
 *  1. The content goes to a temp file first. The temp file lives in the
 *     device-local state directory when that directory is on the same
 *     filesystem as the store (it is never synced). Otherwise it lives in
 *     the blob's own directory under a dot-prefixed name, which FORMAT.md
 *     tells readers and sync setups to ignore.
 *  2. The temp file is hard-linked to the final name, which fails when the
 *     name is taken, so the create is exclusive.
 *  3. Some filesystems (FAT, exFAT) have no hard links. There the final
 *     name is created directly with an exclusive create (`wx`). A reader
 *     may then briefly see a partly written blob; it reads it as pending,
 *     exactly like a blob a sync tool is still delivering.
 *
 * When the final name is already taken, the existing file is verified.
 * Its content is fixed by its name, so a file that does not hash to its
 * name (a crash during a direct create, or a sync tool still writing) is
 * given a short grace and then replaced with the one content it can ever
 * have: written to a temp file beside it and renamed over it, so a reader
 * never sees the repair half done.
 *
 * A blob that a record references but that is absent, or whose bytes do
 * not hash to its name, is pending: the reader marks the record's body
 * pending and tries again later.
 */

import {
  closeSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

import { renameWithRetry, sleepSync } from "../fs-atomic.ts";
import { sha256Hex } from "../integrity/digest.ts";
import { BLOB_TEMP_PREFIX, STORE_BLOB_MAX_BYTES } from "./constants.ts";
import {
  ensureStoreDir,
  openRegularFileForRead,
  STORE_DIR_MODE,
  STORE_FILE_MODE,
} from "./safe-fs.ts";
import { blobPath } from "./store-paths.ts";

/** Errors of `link(2)` that mean the filesystem cannot hard-link here. */
export const NO_LINK_CODES = new Set([
  "EPERM",
  "ENOTSUP",
  "EOPNOTSUPP",
  "ENOSYS",
  "EXDEV",
  "EMLINK",
]);

/** How long a taken name that does not verify may still be in the middle of a write. */
const VERIFY_ATTEMPTS = 5;
const VERIFY_SLEEP_MS = 20;

export interface WrittenBlob {
  readonly sha: string;
  readonly path: string;
  /** False when the blob was already present (written earlier, or by another process). */
  readonly created: boolean;
}

export interface WriteBlobOptions {
  /**
   * Device-local directory for the temp file. Used when it is on the same
   * filesystem as the store; otherwise the temp file is a dot-prefixed
   * file beside the blob.
   */
  readonly tempDir?: string;
  /**
   * The hard-link call. A seam only so tests can reproduce a filesystem
   * without hard links (FAT, exFAT), which no test host can mount
   * unprivileged; production always uses `fs.linkSync`.
   */
  readonly link?: (existingPath: string, newPath: string) => void;
  /**
   * The rename a repair uses. A seam only so tests can reproduce a Windows
   * sharing violation (a rename over a file another process still holds
   * open), which no POSIX test host can produce; production always uses
   * `renameWithRetry`.
   */
  readonly rename?: (from: string, to: string) => void;
}

/** Errors of a rename over a file that another process still holds open (Windows). */
const STILL_OPEN_CODES = new Set(["EPERM", "EBUSY"]);

function errnoCode(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

function sameFilesystem(a: string, b: string): boolean {
  try {
    return statSync(a).dev === statSync(b).dev;
  } catch {
    return false;
  }
}

function writeAll(fd: number, bytes: Buffer): void {
  let written = 0;
  while (written < bytes.length) written += writeSync(fd, bytes, written, bytes.length - written);
  fsyncSync(fd);
}

/** Create `path` with `bytes`, failing with EEXIST when the name is taken. */
function createExclusive(path: string, bytes: Buffer): void {
  const fd = openSync(path, "wx", STORE_FILE_MODE);
  try {
    writeAll(fd, bytes);
  } finally {
    closeSync(fd);
  }
}

function tempPathFor(target: string, tempDir: string | undefined): string {
  const unique = `${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}`;
  const blobDir = dirname(target);
  if (tempDir !== undefined) {
    try {
      mkdirSync(tempDir, { recursive: true });
      if (sameFilesystem(tempDir, blobDir)) return join(tempDir, `${basename(target)}.${unique}`);
    } catch {
      // An unusable device-local directory falls back to the blob directory.
    }
  }
  return join(blobDir, `${BLOB_TEMP_PREFIX}${basename(target)}.${unique}`);
}

/**
 * Whether `path` hashes to `sha` within `attempts` reads, sleeping
 * `sleepMs` between them; a missing file counts as not yet written.
 */
function verifies(
  path: string,
  sha: string,
  size: number,
  attempts: number,
  sleepMs: number,
): boolean {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      // A symlink or anything but a file of the right size is never read:
      // the repair renames over the name itself, never through it.
      const fd = openRegularFileForRead(path);
      if (fd !== null) {
        try {
          if (fstatSync(fd).size === size && sha256Hex(readFileSync(fd)) === sha) return true;
        } finally {
          closeSync(fd);
        }
      }
    } catch (err) {
      if (errnoCode(err) !== "ENOENT") throw err;
    }
    if (attempt < attempts - 1) sleepSync(sleepMs);
  }
  return false;
}

/**
 * The blob at `path` already exists: make sure it holds `bytes`. A file
 * that does not verify gets a short grace (another process may be in the
 * middle of a direct create) and is then atomically replaced with its one
 * content.
 */
function settleExisting(path: string, sha: string, bytes: Buffer, options: WriteBlobOptions): void {
  if (verifies(path, sha, bytes.length, VERIFY_ATTEMPTS, VERIFY_SLEEP_MS)) return;
  // The repair temp goes where the first write's temp went: the
  // device-local directory when it can, so a crash before the rename
  // leaves nothing in the synced partition.
  const repair = tempPathFor(path, options.tempDir);
  try {
    createExclusive(repair, bytes);
    try {
      (options.rename ?? renameWithRetry)(repair, path);
    } catch (err) {
      // A writer still holding the name open (Windows, a slow direct
      // create on a filesystem without hard links) refuses the rename.
      // That writer is writing the one content the name can have, so it
      // is given a longer grace before the refusal counts.
      const code = errnoCode(err);
      if (code === undefined || !STILL_OPEN_CODES.has(code)) throw err;
      if (!verifies(path, sha, bytes.length, VERIFY_ATTEMPTS, VERIFY_SLEEP_MS * 10)) throw err;
    }
  } finally {
    try {
      unlinkSync(repair);
    } catch {
      // renamed into place, or never created
    }
  }
  if (!verifies(path, sha, bytes.length, 1, 0)) {
    throw new Error(
      `blob ${path} does not hold the content its name promises, even after a rewrite`,
    );
  }
}

/**
 * Create `path` with `bytes` exactly once: a complete temp file hard-linked
 * to the name, or, where the filesystem has no hard links, an exclusive
 * create of the name itself. Returns `false` when the name is already
 * taken; every other error propagates. Shared with the store identity
 * file, which needs the same exclusive create on the same filesystems.
 */
export function createFileOnce(
  path: string,
  bytes: Buffer,
  options: WriteBlobOptions = {},
): boolean {
  const link = options.link ?? linkSync;
  mkdirSync(dirname(path), { recursive: true, mode: STORE_DIR_MODE });
  const temp = tempPathFor(path, options.tempDir);
  try {
    createExclusive(temp, bytes);
    try {
      link(temp, path);
      return true;
    } catch (err) {
      const code = errnoCode(err);
      if (code === "EEXIST") return false;
      if (code === undefined || !NO_LINK_CODES.has(code)) throw err;
    }
  } finally {
    try {
      unlinkSync(temp);
    } catch {
      // never created, or already gone
    }
  }
  // No hard links on this filesystem: an exclusive create of the final name.
  try {
    createExclusive(path, bytes);
    return true;
  } catch (err) {
    if (errnoCode(err) !== "EEXIST") throw err;
    return false;
  }
}

/** Store `text` as a blob in the partition at `partitionRoot`. */
export function writeBlob(
  partitionRoot: string,
  text: string,
  options: WriteBlobOptions = {},
): WrittenBlob {
  const sha = sha256Hex(text);
  const path = blobPath(partitionRoot, sha);
  const bytes = Buffer.from(text, "utf8");
  // `blobs/<xx>/` may not be a symlink a peer planted (`safe-fs.ts`).
  ensureStoreDir(partitionRoot, dirname(path));
  if (createFileOnce(path, bytes, options)) return { sha, path, created: true };
  settleExisting(path, sha, bytes, options);
  return { sha, path, created: false };
}

/** Outcome of {@link readBlob}. */
export type BlobRead =
  | { readonly status: "ok"; readonly text: string }
  | { readonly status: "missing" }
  | { readonly status: "mismatch" };

/**
 * Read and verify blob `sha`: its bytes must hash to its name. The file is
 * sized before it is read: one that is not a regular file, is larger than
 * {@link STORE_BLOB_MAX_BYTES}, or is not the `bytes` long the reference
 * promises is a mismatch and is never read into memory.
 */
export function readBlob(partitionRoot: string, sha: string, bytes?: number): BlobRead {
  const path = blobPath(partitionRoot, sha);
  let fd: number;
  try {
    // Only a regular file is opened: a symlink or a FIFO a peer planted
    // under a blob name is never followed or blocked on.
    // A blob folder that is a link is refused too.
    const opened = openRegularFileForRead(path, partitionRoot);
    if (opened === null) return { status: "mismatch" };
    fd = opened;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" };
    throw err;
  }
  try {
    const stat = fstatSync(fd);
    if (stat.size > STORE_BLOB_MAX_BYTES) return { status: "mismatch" };
    if (bytes !== undefined && stat.size !== bytes) return { status: "mismatch" };
    const content = Buffer.alloc(stat.size);
    let read = 0;
    while (read < content.length) {
      const n = readSync(fd, content, read, content.length - read, read);
      if (n === 0) break;
      read += n;
    }
    const got = content.subarray(0, read);
    if (sha256Hex(got) !== sha) return { status: "mismatch" };
    return { status: "ok", text: got.toString("utf8") };
  } finally {
    closeSync(fd);
  }
}
