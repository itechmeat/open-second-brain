/**
 * The git-dirty page set for `o2b brain validate --dirty` (t_dc782fd5,
 * task C4): every Markdown note under the vault that git reports as
 * modified, added or untracked.
 *
 * The one git subprocess in the module follows the `git/reader.ts`
 * precedent (`execFileSync("git", ["-C", repo], ...)`, quiet stderr,
 * bounded buffer). Unlike the reader, this module is NOT fail-soft: a
 * gate that silently reported "clean" for a vault whose dirtiness it
 * could not measure would be the exact failure the verb exists to
 * prevent, so a vault that is not a git worktree (or a git that cannot
 * answer) is a named {@link VaultDirtyError}, and the verb refuses with
 * exit 2 rather than passing.
 *
 * Deleted entries are excluded by name: a deleted path cannot be linted,
 * and the gate's subject is the page content a caller is about to
 * commit, not the deletion bookkeeping around it. Untracked directories
 * are expanded with `-uall` - an agent-created new note is exactly the
 * population this gate targets, and plain `--porcelain` would otherwise
 * collapse it into a bare directory row. `-z` NUL-terminated output is
 * parsed instead of line-oriented, so filenames with spaces, quotes and
 * non-ASCII arrive verbatim (git skips its quotePath C-style quoting in
 * this mode) and a rename arrives as two adjacent fields rather than an
 * `old -> new` spelling that a filename could forge.
 */

import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

/** The refusal for a vault whose dirtiness git cannot measure. */
export class VaultDirtyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultDirtyError";
  }
}

/** The condition behind the refusal, stated so the remedy names the other selector. */
const NOT_A_WORKTREE_MESSAGE =
  "the vault is not inside a git worktree, so --dirty has nothing to measure; " +
  "name pages explicitly with --paths instead";

/** The first line of an error's message: git output is multi-line. */
function firstLine(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message.split("\n")[0] ?? message;
}

/**
 * Every git-dirty Markdown path under `vault`, vault-relative with POSIX
 * separators: modified, added (staged), renamed and untracked. Deleted
 * paths are never returned. Order is git's own (sorted by path).
 */
export function listDirtyMarkdownPaths(vault: string): ReadonlyArray<string> {
  // The worktree check is its own call, not an inference from an empty
  // status: an empty status in a non-worktree is indistinguishable from
  // a clean one, and the refusal must name the condition rather than
  // read as a clean pass.
  try {
    const inside = execFileSync(
      "git",
      ["-C", resolve(vault), "rev-parse", "--is-inside-work-tree"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 * 1024 * 1024 },
    ).trim();
    if (inside !== "true") throw new Error(`git answered ${JSON.stringify(inside)}`);
  } catch (err) {
    throw new VaultDirtyError(`${NOT_A_WORKTREE_MESSAGE} (${firstLine(err)})`);
  }

  let out: string;
  try {
    out = execFileSync("git", ["-C", resolve(vault), "status", "--porcelain", "-uall", "-z"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    throw new VaultDirtyError(`${NOT_A_WORKTREE_MESSAGE} (git status failed: ${firstLine(err)})`);
  }

  const dirty: string[] = [];
  const entries = out.split("\0").filter((e) => e.length > 0);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (xy[1] === "R" || xy[0] === "R") {
      // -z rename entry: the field just parsed carried the OLD name and
      // the NEXT field carries the new one; the gate lints the
      // destination spelling, the one a commit would contain.
      const renamed = entries[++i];
      if (renamed !== undefined && renamed.endsWith(".md")) dirty.push(renamed);
      continue;
    }
    if (path.endsWith("/") || !path.endsWith(".md")) continue; // a directory row, or not a note
    if (xy.includes("D") && !xy.includes("M")) continue; // deleted: nothing to lint
    dirty.push(path);
  }
  return dirty;
}

/**
 * The vault-relative spelling of a `--paths` argument, or `null` when it
 * resolves outside the vault, so the caller refuses by name without
 * inventing its own boundary arithmetic. Mirrors the derivation
 * `lintPagesWithContext` applies to every page it names (`vaultRelative`
 * over `resolve(vault, page)`), so the refusal and the report can never
 * disagree about where the boundary sits.
 */
export function vaultRelativeOrNull(vault: string, page: string): string | null {
  const rel = relative(resolve(vault), resolve(vault, page));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) return null;
  return rel
    .split(/[\\/]/)
    .filter((p) => p.length > 0)
    .join("/");
}
