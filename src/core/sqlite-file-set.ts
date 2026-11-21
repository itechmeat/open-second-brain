/**
 * A SQLite database on disk is a set of files: the main file and the
 * siblings SQLite keeps beside it under the same name - the write-ahead
 * log (`-wal`) and its index (`-shm`) in WAL mode, the rollback journal
 * (`-journal`) in DELETE mode. A sibling belongs to the main file whose
 * name it carries, and SQLite finds it by that name alone: a `-wal` left
 * at a path when another database is renamed there is replayed into the
 * newcomer on its next open (committed frames of a writer killed before a
 * checkpoint are exactly that), and a hot `-journal` is rolled back over
 * it. Either corrupts the database that now holds the name.
 *
 * So every place that renames one database over another moves the whole
 * set, through the two functions here, in an order that keeps the live
 * path consistent at every instant a crash can stop it: the live path
 * never holds a main file without its own siblings. Parking the live
 * database moves its main file first and its siblings after (a crash in
 * between leaves siblings with no main file at the live path, and the
 * main file at the parked path, which the crash restore moves back next
 * to them); bringing a parked database back moves the siblings first and
 * the main file last, for the same reason.
 */

import { existsSync } from "node:fs";

import { renameWithRetry, unlinkWithRetry, type RenameRetrySeams } from "./fs-atomic.ts";

/** The files SQLite keeps beside a database, as suffixes of its name. */
export const SQLITE_SIBLING_SUFFIXES: ReadonlyArray<string> = Object.freeze([
  "-wal",
  "-shm",
  "-journal",
]);

/** The siblings present beside `path` (full paths). */
export function sqliteSiblingsPresent(path: string): string[] {
  return SQLITE_SIBLING_SUFFIXES.map((suffix) => path + suffix).filter((p) => existsSync(p));
}

/** Journals that can replay data into the main database at `path`. */
export function sqliteJournalsPresent(path: string): string[] {
  return [`${path}-wal`, `${path}-journal`].filter((p) => existsSync(p));
}

/**
 * Thrown when a set could not be moved. The files already moved were moved
 * back unless {@link SqliteFileSetMoveError.stranded} names some: those
 * stayed at the destination, the main file among them whenever one of its
 * siblings could not be brought back (a main file back at its name without
 * its `-wal` would lose the commits in that log).
 */
export class SqliteFileSetMoveError extends Error {
  constructor(
    message: string,
    /** The file whose move failed. */
    readonly failedPath: string,
    /** Files left at the destination by an undo that could not finish. */
    readonly stranded: ReadonlyArray<string>,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "SqliteFileSetMoveError";
  }
}

/**
 * Move the set at `from` to `to` in the given order. When one move fails,
 * the moves already made are undone siblings first and the main file last,
 * and the main file only when every sibling came back: a sibling that
 * cannot be moved back keeps the main file at the destination with it,
 * and the error names what stayed there.
 */
function moveInOrder(
  from: string,
  to: string,
  suffixes: ReadonlyArray<string>,
  seams: RenameRetrySeams | undefined,
  beforeRename?: () => void,
): void {
  const moved: string[] = [];
  for (const suffix of suffixes) {
    if (!existsSync(from + suffix)) continue;
    try {
      beforeRename?.();
      renameWithRetry(from + suffix, to + suffix, seams);
      moved.push(suffix);
    } catch (err) {
      const stranded = undoMoves(from, to, moved, seams, beforeRename);
      const strandedText = stranded.map((s) => `${to + s.suffix} (${s.reason})`);
      throw new SqliteFileSetMoveError(
        `could not move ${from + suffix} to ${to + suffix}: ${errorText(err)}` +
          (stranded.length > 0
            ? `; these could not be moved back and stay at: ${strandedText.join(", ")}`
            : moved.length > 0
              ? "; the files already moved were moved back"
              : ""),
        from + suffix,
        stranded.map((s) => to + s.suffix),
        { cause: err },
      );
    }
  }
}

/** Undo `moved` (suffixes moved from `from` to `to`); returns what stayed at `to`. */
function undoMoves(
  from: string,
  to: string,
  moved: ReadonlyArray<string>,
  seams: RenameRetrySeams | undefined,
  beforeRename?: () => void,
): Array<{ readonly suffix: string; readonly reason: string }> {
  const stranded: Array<{ suffix: string; reason: string }> = [];
  for (const suffix of moved.filter((s) => s !== "").toReversed()) {
    try {
      beforeRename?.();
      renameWithRetry(to + suffix, from + suffix, seams);
    } catch (undoErr) {
      stranded.push({ suffix, reason: errorText(undoErr) });
    }
  }
  if (!moved.includes("")) return stranded;
  if (stranded.length > 0) {
    stranded.push({ suffix: "", reason: "kept with its journal" });
    return stranded;
  }
  try {
    beforeRename?.();
    renameWithRetry(to, from, seams);
  } catch (undoErr) {
    stranded.push({ suffix: "", reason: errorText(undoErr) });
  }
  return stranded;
}

/**
 * Move the live database at `live` and its siblings aside to `parked`:
 * main file first. Whatever was at `parked` before must have been
 * discarded by the caller (a sibling left there would be adopted by the
 * parked main file). A missing main file moves nothing but the siblings.
 */
export function parkSqliteFileSet(
  live: string,
  parked: string,
  seams?: RenameRetrySeams,
  beforeRename?: () => void,
): void {
  moveInOrder(live, parked, ["", ...SQLITE_SIBLING_SUFFIXES], seams, beforeRename);
}

/**
 * Move a parked database and its siblings back to `live`: siblings first,
 * main file last.
 */
export function unparkSqliteFileSet(
  parked: string,
  live: string,
  seams?: RenameRetrySeams,
  beforeRename?: () => void,
): void {
  moveInOrder(parked, live, [...SQLITE_SIBLING_SUFFIXES, ""], seams, beforeRename);
}

/**
 * Delete the database at `path` with its siblings: siblings first and the
 * main file last. A failure part way can leave the main file without a
 * sibling already deleted (its `-wal`, and the commits in it), so the
 * first failure (ENOENT is not one) is thrown and the caller treats what
 * is left at `path` as incomplete, never as a database to open. The main
 * file is never deleted first: a `-wal` left behind would be replayed
 * into the next database created at `path`.
 */
export function discardSqliteFileSet(
  path: string,
  seams?: RenameRetrySeams,
  beforeUnlink?: () => void,
): void {
  for (const target of [...SQLITE_SIBLING_SUFFIXES.map((s) => path + s), path]) {
    try {
      beforeUnlink?.();
      unlinkWithRetry(target, seams);
    } catch (err) {
      if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") continue;
      throw err;
    }
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
