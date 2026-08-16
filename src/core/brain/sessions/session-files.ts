/**
 * Which files under an operator-named path are session transcripts.
 *
 * The walk lived inside `importSessionPath` as a closure, which was right
 * while one caller existed. A second one appeared - the transcript dataset
 * export - and two copies of "a session log is a `*.jsonl` that is not a
 * symlink, sorted so runs are reproducible" is exactly the drift a shared
 * primitive prevents: the day the extension set widens, one copy would
 * widen with it. Same reason `read-lines.ts` exists one file over.
 *
 * Symlinks are skipped rather than followed. A cycle would drive the walker
 * into unbounded recursion, and a session export that follows links out of
 * the directory the operator named is reaching further than they asked.
 */

import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { SessionImportError } from "./types.ts";

/** The extension a session transcript is written with. */
const SESSION_FILE_EXTENSION = ".jsonl";

/**
 * Every session transcript under `path`, sorted.
 *
 * A path naming a FILE is returned as the single-element list, whatever
 * its extension: the operator named that file, so filtering it out would
 * answer an explicit request with silence. Inside a DIRECTORY the
 * extension is the only thing separating a transcript from a README, so
 * there it is applied.
 *
 * Throws {@link SessionImportError} with code `IO` when the path does not
 * exist or cannot be stat'ed - an unreadable source is not an empty one.
 */
export function sessionFilesUnder(path: string): ReadonlyArray<string> {
  let root;
  try {
    root = statSync(path);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new SessionImportError(
      "IO",
      `cannot read session path ${path}: ${detail}; check the path exists and is readable`,
    );
  }
  if (root.isFile()) return Object.freeze([path]);

  const found: string[] = [];
  const collect = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      let entry;
      try {
        // lstat, not stat: a symlink cycle would otherwise recurse forever.
        entry = lstatSync(full);
      } catch {
        continue;
      }
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        collect(full);
        continue;
      }
      if (name.endsWith(SESSION_FILE_EXTENSION)) found.push(full);
    }
  };
  collect(path);
  found.sort();
  return Object.freeze(found);
}
