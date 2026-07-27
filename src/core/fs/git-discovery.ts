/**
 * Git-aware discovery: the ignore layering a repository declares about itself.
 *
 * Two walkers need the same three facts about a tree - what the root excludes
 * (`.git/info/exclude` plus the root `.gitignore`), what a given directory
 * excludes for its own subtree (a nested `.gitignore`), and where the working
 * tree stops (a submodule or a nested repository). The hygiene repo scan
 * ({@link ../hygiene/scan-repo.ts}) grew that layering first; the ingest batch
 * planner ({@link ../brain/ingest/batch-plan.ts}) needs it too. This module is
 * the one implementation both compose, so the precedence order cannot drift
 * between them.
 *
 * Matching itself is NOT reimplemented here: every layer is compiled by the
 * shared engine in {@link ./ignore.ts}, which owns the documented gitignore
 * subset. This module only decides which files are read and in what order they
 * stack.
 *
 * ## Base-dir contract
 *
 * `IgnoreLayer.baseDir` and the paths later passed to
 * {@link IgnoreScope.isIgnored} must be expressed in ONE path space, and this
 * module never assumes which one. The caller names it by passing the POSIX
 * path of the governed directory relative to the root of its own space:
 *
 *   - the hygiene scan walks a repository and matches repo-root-relative paths,
 *     so it passes `""` for the repository root;
 *   - the ingest planner walks a source directory inside a vault and matches
 *     vault-relative paths, so it passes the source dir's vault-relative path
 *     for that same repository root.
 *
 * The `source` recorded on a warning follows the same space, which makes a
 * warning's provenance meaningful to whichever surface reports it.
 *
 * ## Stream discipline
 *
 * A malformed pattern is RETURNED as a structured {@link IgnoreWarning}, and so
 * is an ignore file that exists but cannot be honoured (unreadable, a symlink,
 * oversized). This is kernel code: it never writes to a stream, so the hygiene
 * scan can keep its `hygiene:` stderr sink while the ingest planner carries the
 * same warnings out on its plan. Nothing is ever dropped silently - a
 * declaration the walker could not apply always leaves a warning behind.
 */

import { lstatSync, readFileSync, statSync, type Stats } from "node:fs";
import { join } from "node:path";

import { IgnoreScope, parseIgnoreLayer, type IgnoreWarning } from "./ignore.ts";

/** Git's per-repository metadata entry: a directory, or a gitlink file. */
const GIT_ENTRY = ".git";

/** Per-directory ignore file, governing the subtree rooted at its directory. */
const GITIGNORE_FILE = ".gitignore";

/** Repo-local exclude file, layered beneath every `.gitignore`. */
const GIT_INFO_EXCLUDE_PATH: ReadonlyArray<string> = [GIT_ENTRY, "info", "exclude"];

/** Provenance recorded for a warning raised by the repo-local exclude file. */
const GIT_INFO_EXCLUDE_SOURCE = GIT_INFO_EXCLUDE_PATH.join("/");

/**
 * Largest ignore file this module will read. A `.gitignore` is a hand-written
 * list of patterns; anything past this is not one, and reading it unbounded
 * would let a single path stall or exhaust the walker.
 */
export const MAX_IGNORE_FILE_BYTES = 1024 * 1024;

/**
 * Line recorded on a warning that concerns no single pattern line - an ignore
 * file that could not be read at all, or a scoping decision a caller made about
 * a whole subtree. Pattern lines are 1-based, so zero can never collide with
 * one, and a surface can tell the two apart to render them differently.
 */
export const IGNORE_WARNING_NO_LINE = 0;

/** Errno codes that mean "there is simply no ignore file here" - the normal case. */
const ABSENT_FILE_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

/**
 * Render one warning as a single human-readable line, so every surface that
 * reports these (the hygiene stderr sink, the CLI plan output) words them
 * identically. Callers add their own prefix and indentation.
 */
export function formatIgnoreWarning(warning: IgnoreWarning): string {
  return warning.line === IGNORE_WARNING_NO_LINE
    ? `${warning.source}: ${warning.reason}`
    : `malformed ignore pattern at ${warning.source}:${warning.line} ` +
        `(${warning.pattern}): ${warning.reason}`;
}

/** A composed scope plus every malformed pattern found while composing it. */
export interface DiscoveredScope {
  readonly scope: IgnoreScope;
  /** Empty when every pattern read compiled cleanly. */
  readonly warnings: readonly IgnoreWarning[];
}

/** Join a base directory and a name in the caller's POSIX path space. */
function inBaseDir(baseDir: string, name: string): string {
  return baseDir === "" ? name : `${baseDir}/${name}`;
}

/** A warning about the ignore FILE rather than about one pattern inside it. */
function fileWarning(source: string, reason: string): IgnoreWarning {
  return { source, line: IGNORE_WARNING_NO_LINE, pattern: "", reason };
}

/** The errno code of an I/O failure, or its message when it carries no code. */
function ioReason(err: unknown): string {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (typeof code === "string") return code;
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read one ignore file, or return null and push a warning saying why it was not
 * read. An ABSENT file is the ordinary case and warns nothing; every other
 * refusal is reported, because a declaration the walker cannot apply changes
 * what the walk returns and the operator has to be able to see that.
 *
 * A symlinked ignore file is refused outright rather than resolved: the walk
 * itself never follows symlinked directories, so honouring one here would read
 * patterns from outside the tree being walked (`/etc/shadow`) or from a stream
 * with no end (`/dev/zero`). Containment-checking the resolved target was the
 * alternative; refusal is chosen because this module is composed by callers
 * walking different path spaces (a repo root, a vault subdirectory) and it must
 * not have to know which boundary "contained" means for each of them.
 */
function readIgnoreFile(
  filePath: string,
  source: string,
  warnings: IgnoreWarning[],
): string | null {
  let stats: Stats;
  try {
    // lstat, NOT stat: a symlink must be seen as itself, not as its target.
    stats = lstatSync(filePath);
  } catch (err) {
    const code = ioReason(err);
    if (!ABSENT_FILE_CODES.has(code)) {
      warnings.push(fileWarning(source, `ignore file could not be inspected (${code})`));
    }
    return null;
  }
  if (stats.isSymbolicLink()) {
    warnings.push(fileWarning(source, "ignore file is a symbolic link and was not read"));
    return null;
  }
  if (!stats.isFile()) {
    warnings.push(fileWarning(source, "ignore file is not a regular file and was not read"));
    return null;
  }
  if (stats.size > MAX_IGNORE_FILE_BYTES) {
    warnings.push(
      fileWarning(
        source,
        `ignore file is ${stats.size} bytes, over the ${MAX_IGNORE_FILE_BYTES}-byte limit, ` +
          "and was not read",
      ),
    );
    return null;
  }
  try {
    return readFileSync(filePath, "utf8");
  } catch (err) {
    warnings.push(fileWarning(source, `ignore file could not be read (${ioReason(err)})`));
    return null;
  }
}

/**
 * Read one ignore file and stack it at the highest precedence. A file that
 * cannot be honoured leaves the scope untouched - refusing to walk the tree over
 * it would be a worse answer than walking it unfiltered - but never quietly:
 * {@link readIgnoreFile} records why on `warnings`.
 */
function extendWithIgnoreFile(
  scope: IgnoreScope,
  filePath: string,
  baseDir: string,
  source: string,
  warnings: IgnoreWarning[],
): IgnoreScope {
  const content = readIgnoreFile(filePath, source, warnings);
  if (content === null) return scope;
  const parsed = parseIgnoreLayer(content, baseDir, source);
  warnings.push(...parsed.warnings);
  return scope.extend(parsed.layer);
}

/**
 * Base scope for a repository: `.git/info/exclude` at the lowest precedence,
 * then the root `.gitignore` above it - so a re-include the tracked file
 * declares wins over the untracked local one, matching git's own ordering.
 *
 * `baseDir` names `repoRoot`'s position in the caller's path space; see the
 * base-dir contract above.
 */
export function buildRepositoryBaseScope(repoRoot: string, baseDir: string): DiscoveredScope {
  const warnings: IgnoreWarning[] = [];
  let scope = IgnoreScope.empty();
  scope = extendWithIgnoreFile(
    scope,
    join(repoRoot, ...GIT_INFO_EXCLUDE_PATH),
    baseDir,
    inBaseDir(baseDir, GIT_INFO_EXCLUDE_SOURCE),
    warnings,
  );
  scope = extendWithIgnoreFile(
    scope,
    join(repoRoot, GITIGNORE_FILE),
    baseDir,
    inBaseDir(baseDir, GITIGNORE_FILE),
    warnings,
  );
  return { scope, warnings };
}

/**
 * Stack `dir`'s own `.gitignore` on top of `scope`, governing `dir`'s subtree.
 * Returns `scope` itself when the directory declares nothing, so a walk over a
 * tree with no nested ignore files allocates no layers.
 *
 * `baseDir` names `dir`'s position in the caller's path space.
 */
export function extendWithDirectoryIgnore(
  scope: IgnoreScope,
  dir: string,
  baseDir: string,
): DiscoveredScope {
  const warnings: IgnoreWarning[] = [];
  const extended = extendWithIgnoreFile(
    scope,
    join(dir, GITIGNORE_FILE),
    baseDir,
    inBaseDir(baseDir, GITIGNORE_FILE),
    warnings,
  );
  return { scope: extended, warnings };
}

/**
 * Whether `dir` is the root of a repository other than the one being walked -
 * a submodule or worktree (`.git` is a gitlink file) or a nested independent
 * checkout (`.git` is a directory). Either way its contents belong to that
 * repository's index, not the outer walk's, so a caller descending into it
 * would attribute foreign files to the tree it was asked about.
 *
 * The walk root itself is exempt: it is a repository root in the ordinary case,
 * and pruning it would empty the walk. Every OTHER directory a caller enters
 * must be checked - including the ones a caller starting deeper in the tree
 * (an ingest `--src-subpath`) descends past without ever reading them as
 * `readdir` entries. Checking only `readdir` children leaves that path open.
 */
export function isNestedRepositoryBoundary(dir: string): boolean {
  try {
    const stats = statSync(join(dir, GIT_ENTRY));
    return stats.isFile() || stats.isDirectory();
  } catch {
    return false; // no `.git` entry, or an unreadable one: an ordinary directory
  }
}
