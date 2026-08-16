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
 * A THIRD copy existed anyway, one layer out: the globs in
 * `src/core/runtime/host-facts.ts` decide what the machine-wide sweep
 * enrols, and the Codex rows named a wider extension set than this walk
 * accepted. The extension itself therefore lives in the session
 * vocabulary now ({@link SESSION_FILE_EXTENSION}), which both this
 * primitive and those rows read.
 *
 * Symlinks are skipped rather than followed. A cycle would drive the walker
 * into unbounded recursion, and a session export that follows links out of
 * the directory the operator named is reaching further than they asked.
 */

import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { SESSION_FILE_EXTENSION, SessionImportError } from "./types.ts";

/**
 * How deep the walk goes before it refuses.
 *
 * Symlinks are skipped, so a cycle cannot drive the recursion - but a
 * pathologically deep real tree still can, and an unbounded recursive
 * walk answers that with a stack overflow rather than a sentence. Every
 * declared session root is at most four components deep below its own
 * base (`~/.claude/projects/<encoded-cwd>/<file>`,
 * `~/.grok/sessions/<cwd>/<id>/updates.jsonl`), so 32 is far past any
 * layout this build expects and still a bound.
 */
const MAX_WALK_DEPTH = 32;

/**
 * True when a file inside a directory is a session transcript by name.
 *
 * Exported so the machine-wide sweep and this walk cannot answer the
 * question differently - see {@link SESSION_FILE_EXTENSION} for the three
 * answers that existed before there was one.
 */
export function isSessionFileName(name: string): boolean {
  return name.endsWith(SESSION_FILE_EXTENSION);
}

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
 * exist or cannot be stat'ed, when a subdirectory of it cannot be listed,
 * or when the tree is deeper than {@link MAX_WALK_DEPTH} - an unreadable
 * source is not an empty one, and that has to hold for every level of the
 * walk rather than only for the level the caller named. A `readdirSync`
 * that was left unguarded turned one mode-000 subdirectory into a raw
 * `EACCES` errno escaping through both the import and the transcript
 * export, where the sibling sweep in `discover.ts` reports the same
 * condition as `unreadable` and carries on.
 */
export function sessionFilesUnder(path: string): ReadonlyArray<string> {
  let root;
  try {
    root = statSync(path);
  } catch (err) {
    throw ioRefusal(path, err);
  }
  if (root.isFile()) return Object.freeze([path]);

  const found: string[] = [];
  const collect = (dir: string, depth: number): void => {
    if (depth > MAX_WALK_DEPTH) {
      throw new SessionImportError(
        "IO",
        `session path ${path} nests deeper than ${MAX_WALK_DEPTH} directories at ${dir}; ` +
          "point the import or export at the subdirectory that holds the transcripts",
      );
    }
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      throw ioRefusal(dir, err);
    }
    for (const name of names) {
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
        collect(full, depth + 1);
        continue;
      }
      if (isSessionFileName(name)) found.push(full);
    }
  };
  collect(path, 0);
  found.sort();
  return Object.freeze(found);
}

/** One spelling of "this level of the walk could not be read". */
function ioRefusal(at: string, err: unknown): SessionImportError {
  const detail = err instanceof Error ? err.message : String(err);
  return new SessionImportError(
    "IO",
    `cannot read session path ${at}: ${detail}; check the path exists and is readable`,
  );
}
