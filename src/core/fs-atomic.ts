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
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";

export interface AtomicWriteOptions {
  /**
   * Skip the write when the target already holds byte-identical content. Off
   * by default (a write always happens). When on, an unchanged target is left
   * untouched - no temp file, no rename, no mtime bump - which stops spurious
   * churn in a vault the user is also hand-editing.
   */
  readonly skipIfUnchanged?: boolean;
}

/**
 * Atomic overwrite. Returns `true` when it wrote, `false` when
 * `skipIfUnchanged` short-circuited an identical write.
 */
export function atomicWriteFileSync(
  target: string,
  contents: string,
  opts: AtomicWriteOptions = {},
): boolean {
  if (opts.skipIfUnchanged && isUnchanged(target, contents)) return false;
  withTempFile(target, contents, (tmpPath) => {
    // POSIX `rename(2)` is atomic and clobbers an existing target — that's
    // exactly the "overwrite" semantic we want. No exclusivity guarantee.
    renameSync(tmpPath, target);
  });
  return true;
}

/**
 * True when `target` exists and already holds byte-identical `contents`. A
 * read error is treated as "changed" so a genuine write still proceeds.
 */
function isUnchanged(target: string, contents: string): boolean {
  if (!existsSync(target)) return false;
  try {
    return readFileSync(target, "utf8") === contents;
  } catch {
    return false;
  }
}

export interface AtomicWriteTextOptions {
  /** File mode for the new inode. Defaults to private `0o600`. */
  readonly mode?: number;
  /**
   * Pre-write gate: runs against the candidate text BEFORE anything
   * touches the filesystem. A throw aborts the write and leaves the
   * existing target untouched — used by config writers that must never
   * persist a payload their own parser would reject.
   */
  readonly validate?: (candidate: string) => void;
  /**
   * Skip the write when the target already holds byte-identical content.
   * Off by default. The validate hook still runs first so a rejected
   * payload never counts as "unchanged".
   */
  readonly skipIfUnchanged?: boolean;
}

/**
 * Validated atomic overwrite for sensitive text files (configs,
 * schema documents). Same temp-file + fsync + rename pipeline as
 * {@link atomicWriteFileSync}, plus a validation hook and a private
 * default mode. Returns `true` when it wrote, `false` when
 * `skipIfUnchanged` short-circuited an identical write.
 */
export function atomicWriteText(
  targetPath: string,
  candidate: string,
  opts: AtomicWriteTextOptions = {},
): boolean {
  opts.validate?.(candidate);
  if (opts.skipIfUnchanged && isUnchanged(targetPath, candidate)) return false;
  withTempFile(
    targetPath,
    candidate,
    (tmpPath) => {
      renameSync(tmpPath, targetPath);
    },
    opts.mode ?? 0o600,
  );
  return true;
}

/**
 * The errno POSIX `link(2)` sets when the destination name is already taken.
 * Named once so the thrown class, the predicate and the cause walk cannot
 * drift apart on three copies of a string literal.
 */
const FILE_EXISTS_CODE = "EEXIST";

/** Bound on how far {@link isFileAlreadyExists} follows the `cause` chain. */
const CAUSE_WALK_LIMIT = 8;

/** Optional detail carried by a {@link FileAlreadyExistsError}. */
export interface FileAlreadyExistsOptions {
  /**
   * Human-readable label for what the caller was creating (`"signal"`,
   * `"dead-end"`). Present only when a wrapper knows the artifact kind;
   * this leaf never does.
   */
  readonly kind?: string;
  /**
   * Path as the message should render it — a vault-relative path where an
   * absolute one would leak the operator's home directory into output.
   * Defaults to `path`, which stays the structured, machine-readable field.
   */
  readonly displayPath?: string;
  /** The underlying failure, normally the native `link(2)` errno error. */
  readonly cause?: unknown;
}

/**
 * A file could not be created because the name was already taken.
 *
 * This lives in the leaf that owns `linkSync` rather than in the vault
 * writer above it, so that recognising a collision never costs an import of
 * `vault.ts`: the losing side of a race is usually a slug allocator or a
 * capture writer that has no business depending on the frontmatter layer.
 *
 * It deliberately carries the SAME errno the kernel does instead of a
 * bespoke code. The rejected alternative was a private code (`"FILE_EXISTS"`)
 * plus a translation at the boundary: every existing consumer of this write
 * path already branches on `err.code === "EEXIST"` (`portability/okf.ts`,
 * `write-session/store.ts`, `notes/create-note.ts`), so a private code would
 * have silently stopped matching in three places while the type-checker
 * stayed quiet. Sharing the errno makes the class strictly additive: `.code`
 * keeps working, and `.path` / `.kind` are new.
 */
export class FileAlreadyExistsError extends Error {
  /** Same errno the native `link(2)` failure carries. */
  readonly code: typeof FILE_EXISTS_CODE = FILE_EXISTS_CODE;
  /** Absolute path that was already taken. */
  readonly path: string;
  /** Artifact label supplied by a wrapper, if any. */
  readonly kind: string | undefined;

  constructor(path: string, opts: FileAlreadyExistsOptions = {}) {
    super(fileAlreadyExistsMessage(opts.displayPath ?? path, opts.kind), { cause: opts.cause });
    this.name = "FileAlreadyExistsError";
    this.path = path;
    this.kind = opts.kind;
  }
}

/**
 * The two message shapes, in one place.
 *
 * The kinded form is byte-identical to the wording `writeFrontmatterAtomic`
 * has thrown since before this class existed, because that string is what
 * CLI verbs and MCP envelopes print; the remedy is deliberately NOT appended
 * there. The kindless form is the one nobody was rendering, so it gets the
 * remedy the project's error convention asks for.
 */
function fileAlreadyExistsMessage(displayPath: string, kind: string | undefined): string {
  if (kind) return `${kind} already exists: ${displayPath}`;
  return (
    `file already exists: ${displayPath}; this create refuses to overwrite. ` +
    "Retry under a different name, or write with overwrite semantics if replacing it is intended."
  );
}

/**
 * Is `err` a "the name was already taken" failure, however it was wrapped?
 *
 * One predicate for every call site, so that no caller has to match on a
 * message, and no caller has to know whether the collision reached it as the
 * typed class, as the raw errno from `link(2)`, or nested one level down on
 * `.cause` because a wrapper re-threw it. The walk is bounded rather than
 * recursive-until-null: a `cause` chain can be made cyclic by a caller, and a
 * hang inside an error handler is a worse failure than a missed match.
 *
 * The class is matched by the same errno test as the native error rather
 * than by a separate `instanceof` branch — see {@link FileAlreadyExistsError}
 * for why it shares the kernel's code.
 */
export function isFileAlreadyExists(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < CAUSE_WALK_LIMIT; depth += 1) {
    if (typeof current !== "object" || current === null) return false;
    if ((current as NodeJS.ErrnoException).code === FILE_EXISTS_CODE) return true;
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}

/**
 * Like {@link atomicWriteFileSync} but fails with
 * {@link FileAlreadyExistsError} if `target` already exists, atomically.
 * Implemented via `link(2)` instead of
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
 *
 * A taken destination is the ONE failure this primitive exists to report,
 * so it leaves as a typed error naming the path rather than as the native
 * errno, whose message is a `link(2)` trace mentioning a temp file the
 * caller never asked for. Every other errno propagates untouched: a full
 * disk or a read-only mount is not a collision and must not be retried as
 * one.
 */
export function atomicCreateFileSyncExclusive(target: string, contents: string): void {
  withTempFile(target, contents, (tmpPath) => {
    try {
      linkSync(tmpPath, target);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code === FILE_EXISTS_CODE) {
        throw new FileAlreadyExistsError(target, { cause: err });
      }
      throw err;
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
function withTempFile(
  target: string,
  contents: string,
  commit: (tmpPath: string) => void,
  mode: number = 0o644,
): void {
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
    fd = openSync(tmpPath, "wx", mode);
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
