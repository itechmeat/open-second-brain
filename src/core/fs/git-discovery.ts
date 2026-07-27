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
 * A malformed pattern is RETURNED as a structured {@link IgnoreWarning}. This is
 * kernel code: it never writes to a stream, so the hygiene scan can keep its
 * `hygiene:` stderr sink while the ingest planner carries the same warnings out
 * on its plan.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
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

/**
 * Read one ignore file and stack it at the highest precedence. Absent or
 * unreadable files leave the scope untouched: an ignore file the walker cannot
 * read narrows nothing, and refusing to walk the tree over it would be a worse
 * answer than walking it unfiltered.
 */
function extendWithIgnoreFile(
  scope: IgnoreScope,
  filePath: string,
  baseDir: string,
  source: string,
  warnings: IgnoreWarning[],
): IgnoreScope {
  if (!existsSync(filePath)) return scope;
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    return scope;
  }
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
 * Applies to candidate CHILD directories only: the walk root itself is a
 * repository root in the ordinary case, and pruning it would empty the walk.
 */
export function isNestedRepositoryBoundary(dir: string): boolean {
  try {
    const stats = statSync(join(dir, GIT_ENTRY));
    return stats.isFile() || stats.isDirectory();
  } catch {
    return false; // no `.git` entry, or an unreadable one: an ordinary directory
  }
}
