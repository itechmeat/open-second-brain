/**
 * What the transition import already read of each legacy JSONL file, so
 * a late-write import costs what changed, not the whole tree (change
 * migration-sync-conflict-copies, follow-up 5).
 *
 * For every file a pass read whole and journaled without a problem, this
 * keeps the file's stamp taken before the read (size, mtime, ctime,
 * inode), how many bytes of complete lines were read, how many lines they
 * hold, their checksum, and how many items they held. The next pass, and
 * the next import, then:
 *
 *  - skip a file whose stamp is unchanged: it is not opened, parsed or
 *    judged;
 *  - read an appended file from the end of what was read, when the inode
 *    is the same, the file is no shorter and the bytes read before have
 *    the same checksum (the whole file is read to check that, but only
 *    the new lines are parsed and judged);
 *  - read every other file whole, as before: a changed line in the
 *    middle, a file replaced by a shorter or another one, a different
 *    inode.
 *
 * The guarantee is the stamp's: a file whose size, mtime, ctime and inode
 * are all unchanged is taken as unchanged. ctime cannot be set back by a
 * tool (setting mtime back changes it), so a same-size rewrite that keeps
 * the mtime is still read again. A file with a problem (an unparseable
 * line, an item held back for a partition this machine does not hold),
 * and an original a sync conflict copy is a version of, is never skipped.
 *
 * The state lives in the device-local migration folder, keyed by the
 * vault it was read from; any doubt (another vault, a file that does not
 * parse) is an empty state, which reads everything.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { atomicWriteFileSync } from "../fs-atomic.ts";

const STATE_FILE = "incremental-reads.json";

/** What a pass knows of one legacy file it read. */
export interface KnownFile {
  readonly stamp: string;
  /** Bytes of complete lines read (up to and including the last newline). */
  readonly bytes: number;
  /** Lines those bytes hold. */
  readonly lines: number;
  /** sha256 of those bytes. */
  readonly sha: string;
  /** Items those lines held (for the device tallies). */
  readonly items: number;
}

/** The stamp a file must still carry to be skipped. */
export function fileStamp(stat: {
  readonly size: number;
  readonly mtimeMs: number;
  readonly ctimeMs: number;
  readonly ino: number;
}): string {
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.ino}`;
}

/** The inode part of a stamp. */
export function stampInode(stamp: string): string {
  return stamp.split(":").at(-1) ?? "";
}

export function checksum(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class IncrementalReads {
  private known: Map<string, KnownFile>;
  private next = new Map<string, KnownFile>();
  private excluded = new Set<string>();

  /**
   * `skip: false` records what every pass read and skips nothing: the
   * migration reads its tree whole (its verification checks every item the
   * final pass saw) and leaves the state for the first import after it.
   */
  constructor(
    known: ReadonlyMap<string, KnownFile> = new Map(),
    private readonly skip: boolean = true,
  ) {
    this.known = new Map(known);
  }

  /** Files this pass must read whole and not record: originals of conflict copies. */
  exclude(paths: Iterable<string>): void {
    this.excluded = new Set(paths);
  }

  /** What an earlier read knows of `path`, unless it must be read whole. */
  lookup(path: string): KnownFile | undefined {
    return !this.skip || this.excluded.has(path) ? undefined : this.known.get(path);
  }

  /** `path` was read (whole, or its new lines): what the next pass may rely on. */
  record(path: string, file: KnownFile): void {
    if (!this.excluded.has(path)) this.next.set(path, file);
  }

  /** `path` had a problem this pass: the next pass reads it whole. */
  drop(path: string): void {
    this.next.delete(path);
  }

  /** End a pass: what it read becomes what the next one knows. */
  endPass(): void {
    this.known = this.next;
    this.next = new Map();
    this.excluded = new Set();
  }

  /** The files known after the last pass. */
  files(): ReadonlyMap<string, KnownFile> {
    return this.known;
  }
}

/** The state an earlier import of `vault` left in the migration folder, or an empty one. */
export function loadIncrementalReads(migrationDir: string, vault: string): IncrementalReads {
  try {
    const parsed = JSON.parse(readFileSync(join(migrationDir, STATE_FILE), "utf8")) as {
      vault?: unknown;
      files?: Record<string, KnownFile>;
    };
    if (parsed.vault !== resolve(vault) || parsed.files === undefined)
      return new IncrementalReads();
    return new IncrementalReads(new Map(Object.entries(parsed.files)));
  } catch {
    return new IncrementalReads();
  }
}

/** Keep what the import read of `vault` for the next one. */
export function saveIncrementalReads(
  migrationDir: string,
  vault: string,
  reads: IncrementalReads,
): void {
  try {
    atomicWriteFileSync(
      join(migrationDir, STATE_FILE),
      `${JSON.stringify({ vault: resolve(vault), files: Object.fromEntries(reads.files()) })}\n`,
    );
  } catch {
    // Only a cost: the next import reads everything.
  }
}
