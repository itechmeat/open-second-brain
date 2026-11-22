/**
 * Set a parked index aside: move it, as the whole SQLite file set it is,
 * out of the parked name into a folder of its own, and delete nothing.
 *
 * A parked index a rebuild keeps (`parked-index.ts`) may be the only copy
 * of stored embeddings, so the product never deletes it; but a rebuild
 * cannot always release it either (one that cannot be read, one that holds
 * more embeddings than the notes left in the vault can produce). Moving it
 * by hand is where data gets lost: the main file goes and its `-wal` stays,
 * the next rebuild clears journals it finds at a free parked name, and the
 * commits that were only in that log are gone from the moved copy. So the
 * move is the product's, through the same set mover the swap uses, under
 * the writer lock, so no rebuild runs while the set is on its way.
 *
 * A move of several files can still be stopped between two renames. So,
 * like the swap, a set-aside writes its record before the first rename:
 * the swap's own park record (`writeParkMarker`, the parked suffix in one
 * atomically written line), here inside the destination folder. The next
 * set-aside, and the next rebuild before it reuses a parked name, finish
 * every move such a record names; the record goes only once the whole set
 * is in its folder.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  parkSqliteFileSet,
  sqliteSiblingsPresent,
  SQLITE_SIBLING_SUFFIXES,
} from "../sqlite-file-set.ts";
import { WINDOWS_RENAME_RETRY_BUDGET_MS } from "../fs-atomic.ts";
import {
  plainParkedTarget,
  releaseCommand,
  setAsideCommand,
  type ParkedIndexTarget,
} from "./parked-index.ts";
import { SearchError } from "./search-error.ts";
import { clearParkMarker, parkMarkerPath, writeParkMarker } from "./store/lifecycle.ts";
import {
  acquireWriterLease,
  keepWriterLeasesFresh,
  type WriterLease,
} from "./store/writer-lock.ts";

/** The parked names a set-aside takes, as the operator types them. */
export type ParkedKind = "bak" | "old";

/** The folder, inside the index folder, that set-aside indexes go to. */
export const SET_ASIDE_FOLDER = "set-aside";

/** What a set-aside moved, or would move on a dry run. */
export interface SetAsideResult {
  /** The parked main file. */
  readonly from: string;
  /** The folder the set goes to, a new one per set-aside. */
  readonly folder: string;
  /** Every file of the set, at its old path. */
  readonly files: ReadonlyArray<string>;
  /** Whether the set was moved; false on a dry run. */
  readonly applied: boolean;
}

/**
 * Move the parked index `kind` beside the index at `dbPath` into a new
 * folder under `<index folder>/set-aside/`, main file first and its
 * journals after, or only report that move when `apply` is false.
 *
 * Under the writer lock it first finishes any set-aside an earlier run
 * left part way ({@link finishInterruptedSetAsides}); when that was this
 * very name, the finished move is the result. It refuses, moving nothing,
 * when there is no parked index at that name, when the folder already
 * exists, or when a rebuild stopped part way through its swap (no live
 * index, and its journals or the swap's record still at the live path):
 * that parked set is the one the crash restore puts back, and its files
 * may be split between the two names. `target` names the index in the
 * refusal's command.
 */
export async function setAsideParkedIndex(
  dbPath: string,
  kind: ParkedKind,
  apply: boolean,
  now: Date = new Date(),
  target: ParkedIndexTarget = plainParkedTarget(dbPath),
): Promise<SetAsideResult> {
  const from = `${dbPath}.${kind}`;
  const stamp = now.toISOString().replace(/[:.]/gu, "-");
  const folder = join(dirname(dbPath), SET_ASIDE_FOLDER, `${stamp}-${kind}`);
  if (!apply) {
    assertParked(dbPath, from, target);
    // A recorded move of this set is finished into its own folder.
    const recorded = pendingSetAsides(dbPath).find((p) => p.from === from)?.folder;
    const files = [from, ...sqliteSiblingsPresent(from)];
    return { from, folder: recorded ?? folder, files, applied: false };
  }
  const lease = await acquireWriterLease(dbPath);
  try {
    if (swapInterrupted(dbPath)) {
      throw new SearchError(
        "INDEX_LOCKED",
        `a rebuild of ${dbPath} stopped part way through its swap, and ${from} may be the ` +
          `index it puts back; run ${releaseCommand(target, "o2b search reindex")}, which ` +
          "restores it first, then set the parked index aside; nothing was moved",
      );
    }
    const finished = finishInterruptedSetAsides(dbPath, lease).find((r) => r.from === from);
    if (finished !== undefined && !existsSync(from)) return finished;
    // Decided again under the lock: another set-aside may have moved the
    // set while this one waited for it.
    assertParked(dbPath, from, target);
    mkdirSync(dirname(folder), { recursive: true });
    try {
      mkdirSync(folder);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      throw new SearchError(
        "INVALID_INPUT",
        `the set-aside folder ${folder} already exists; nothing was moved`,
      );
    }
    return moveRecorded(dbPath, from, folder, lease);
  } finally {
    lease.release();
  }
}

/** The parked set at `from` is whole enough to set aside, or a refusal naming why not. */
function assertParked(dbPath: string, from: string, target: ParkedIndexTarget): void {
  if (existsSync(from)) return;
  const journals = sqliteSiblingsPresent(from);
  const kind = from.slice(dbPath.length + 1);
  const recorded = pendingSetAsides(dbPath).some((p) => p.from === from);
  throw new SearchError(
    "INVALID_INPUT",
    journals.length === 0 && !recorded
      ? `there is no parked index at ${from}; nothing was moved`
      : recorded
        ? `an earlier set-aside of ${from} stopped part way; ` +
          `${setAsideCommand(from, target)} finishes it, and so does the next rebuild; ` +
          "nothing was moved"
        : `${from} is gone but its journals are still there (${journals.join(", ")}), and no ` +
          "set-aside recorded their move; move them into the set-aside folder that holds " +
          `${basename(from)} (one ending in -${kind}), beside it; nothing was moved`,
  );
}

/** No live index, and the swap's record or journals still at the live path. */
function swapInterrupted(dbPath: string): boolean {
  return (
    !existsSync(dbPath) &&
    (existsSync(parkMarkerPath(dbPath)) || sqliteSiblingsPresent(dbPath).length > 0)
  );
}

/** A set-aside's record: the parked set it moves and the folder it moves it to. */
function pendingSetAsides(dbPath: string): Array<{ from: string; folder: string }> {
  const root = join(dirname(dbPath), SET_ASIDE_FOLDER);
  let names: string[];
  try {
    names = readdirSync(root).toSorted();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return names.flatMap((name) => {
    const folder = join(root, name);
    const markerDbPath = join(folder, basename(dbPath));
    let marker: string;
    try {
      marker = readFileSync(parkMarkerPath(markerDbPath), "utf8").trim();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const suffix = [".old", ".bak"].find((candidate) => candidate === marker) ?? null;
    return suffix === null ? [] : [{ from: dbPath + suffix, folder }];
  });
}

/** Whether a destination holds any part of a set, propagating uncertain stats. */
function destinationSetExists(path: string): boolean {
  for (const file of [path, ...SQLITE_SIBLING_SUFFIXES.map((suffix) => path + suffix)]) {
    try {
      statSync(file);
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }
  return false;
}

/**
 * Write the record, move the set main file first, clear the record. Files
 * already in the folder stay: a kill between two renames leaves the rest
 * at the parked name, and this same call finishes them.
 */
function moveRecorded(
  dbPath: string,
  from: string,
  folder: string,
  lease: WriterLease,
): SetAsideResult {
  const stem = join(folder, basename(dbPath));
  const to = join(folder, basename(from));
  const files = [from, ...sqliteSiblingsPresent(from)].filter((f) => existsSync(f));
  const clash = files.find((f) => existsSync(to + f.slice(from.length)));
  if (clash !== undefined) {
    throw new SearchError(
      "INDEX_LOCKED",
      `${clash} and ${to + clash.slice(from.length)} both exist, so the set-aside recorded in ` +
        `${folder} cannot be finished without replacing one; move the one that is not wanted ` +
        `out of the index folder, or delete the record ${parkMarkerPath(stem)} to leave both ` +
        "where they are; nothing was moved",
    );
  }
  lease.assertHeld();
  writeParkMarker(stem, stem + from.slice(dbPath.length));
  try {
    keepWriterLeasesFresh(2 * (files.length + 1) * WINDOWS_RENAME_RETRY_BUDGET_MS, () =>
      parkSqliteFileSet(from, to, undefined, () => lease.assertHeld()),
    );
  } catch (err) {
    // A failed move put everything back: with nothing of the set in the
    // folder the record names no move to finish, and a later rebuild must
    // not make the move the operator saw fail.
    if (!destinationSetExists(to)) {
      try {
        lease.assertHeld();
      } catch {
        throw err;
      }
      clearParkMarker(stem);
    }
    throw err;
  }
  lease.assertHeld();
  clearParkMarker(stem);
  return { from, folder, files, applied: true };
}

/**
 * Finish every set-aside a stop left part way: move what its record names
 * from the parked name into its folder, then clear the record. The caller
 * holds the writer lock on `dbPath`; a rebuild calls this before it
 * reuses a parked name, so it never clears journals a set-aside left
 * behind. Nothing is moved while a swap's own recovery is pending.
 */
export function finishInterruptedSetAsides(
  dbPath: string,
  lease: WriterLease,
): ReadonlyArray<SetAsideResult> {
  if (swapInterrupted(dbPath)) return [];
  return pendingSetAsides(dbPath).map((p) => moveRecorded(dbPath, p.from, p.folder, lease));
}
