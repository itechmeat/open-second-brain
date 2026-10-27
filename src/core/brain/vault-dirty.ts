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
 * prevent, so a vault that is not a git worktree, a vault its enclosing
 * repository ignores (inside a worktree, `git status` omits ignored
 * files - dirt under such a vault can never be seen), or a git that
 * cannot answer is a named {@link VaultDirtyError}, and the verb refuses
 * with exit 2 rather than passing.
 *
 * Deleted entries are excluded by name: a deleted path cannot be linted,
 * and the gate's subject is the page content a caller is about to
 * commit, not the deletion bookkeeping around it. Untracked directories
 * are expanded with `-uall` - an agent-created new note is exactly the
 * population this gate targets, and plain `--porcelain` would otherwise
 * collapse it into a bare directory row. `-z` NUL-terminated output is
 * parsed instead of line-oriented, so filenames with spaces, quotes and
 * non-ASCII arrive verbatim (git skips its quotePath C-style quoting in
 * this mode), and a rename arrives as its destination followed by the
 * origin in the next NUL field - two adjacent fields rather than an
 * `old -> new` spelling that a filename could forge - of which the gate
 * lints the destination. The listing is bounded by a `.` pathspec and
 * every path is rebased from the repository root onto the vault, so a
 * vault nested inside a larger repository lints exactly its own dirt.
 */

import { execFileSync } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

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

/**
 * The second unmeasurable condition: a vault its enclosing repository
 * IGNORES. `rev-parse --is-inside-work-tree` answers `true` inside an
 * ignored directory and `git status` omits ignored files, so without the
 * check-ignore guard such a vault read as permanently clean - the exact
 * state the module's contract refuses to report. The remedy is the other
 * selector, by name.
 */
const IGNORED_VAULT_MESSAGE =
  "the vault directory is ignored by its enclosing git repository, so git cannot " +
  "measure its dirty state; name pages explicitly with --paths instead";

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

  // Inside a worktree is not yet measurable: a vault that sits in a
  // directory the repository's exclude rules IGNORE passes the check
  // above while `git status` silently omits every file under it - the
  // gate would read permanently clean for dirt it can never see. Ask git
  // directly whether the vault root itself is ignored. `check-ignore -q`
  // exits 0 when the path IS ignored and 1 when it is not; any other
  // exit (or an execution failure) is a git that could not answer, which
  // refuses rather than passes, like every git call in this module.
  let ignored: boolean;
  try {
    execFileSync("git", ["-C", resolve(vault), "check-ignore", "-q", "."], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    ignored = true;
  } catch (err) {
    const status = (err as NodeJS.ErrnoException & { status?: number | null }).status;
    if (status !== 1) {
      throw new VaultDirtyError(
        `${NOT_A_WORKTREE_MESSAGE} (git check-ignore failed: ${firstLine(err)})`,
      );
    }
    ignored = false;
  }
  if (ignored) throw new VaultDirtyError(IGNORED_VAULT_MESSAGE);

  let out: string;
  try {
    // The pathspec bounds the listing to the vault: git answers for the
    // whole repository otherwise, and a vault nested inside a larger
    // repo would inherit its neighbours' dirtiness.
    out = execFileSync(
      "git",
      ["-C", resolve(vault), "status", "--porcelain", "-uall", "-z", "--", "."],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 64 * 1024 * 1024,
      },
    );
  } catch (err) {
    throw new VaultDirtyError(`${NOT_A_WORKTREE_MESSAGE} (git status failed: ${firstLine(err)})`);
  }

  // Porcelain paths are relative to the repository ROOT, not to the `-C`
  // directory, so the vault's own prefix is stripped from every path
  // before it is used - a no-op when the vault IS the repo root.
  let prefix: string;
  try {
    prefix = execFileSync("git", ["-C", resolve(vault), "rev-parse", "--show-prefix"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      // Only the trailing newline goes: a leading space is a real
      // character of a top-level directory's name.
    }).replace(/\r?\n$/, "");
  } catch (err) {
    throw new VaultDirtyError(
      `${NOT_A_WORKTREE_MESSAGE} (git show-prefix failed: ${firstLine(err)})`,
    );
  }

  /** Repo-root-relative porcelain path to a vault-relative one, or `null` outside the vault. */
  const inVault = (repoPath: string): string | null => {
    if (prefix === "") return repoPath;
    return repoPath.startsWith(prefix) ? repoPath.slice(prefix.length) : null;
  };

  const dirty: string[] = [];
  const entries = out.split("\0").filter((e) => e.length > 0);
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const xy = entry.slice(0, 2);
    // In `-z` output a rename or copy entry carries a SECOND NUL field -
    // the origin path - and git orders it AFTER the destination ("the
    // field order is reversed", git-status docs): THIS field's path is
    // the destination, the spelling a commit would contain, and the
    // origin field is consumed here and names nothing to lint.
    if (xy.includes("R") || xy.includes("C")) {
      i++; // consume the origin field
      // The destination can be deleted from the worktree just like a
      // plain entry (a staged rename whose destination was then removed
      // reports `RD`): no file on disk, nothing to lint.
      if (xy[1] === "D") continue;
      const destination = inVault(entry.slice(3));
      if (destination !== null && destination.endsWith(".md")) dirty.push(destination);
      continue;
    }
    const rel = inVault(entry.slice(3));
    if (rel === null) continue; // outside the vault: not this gate's subject
    if (rel.endsWith("/") || !rel.endsWith(".md")) continue; // a directory row, or not a note
    if (xy[0] === "D" || xy[1] === "D") continue; // deleted in the index or the worktree: nothing on disk to lint
    dirty.push(rel);
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
  // A real parent-directory segment is the escape; a name that merely
  // begins with two dots (`..draft.md`) is an ordinary vault-relative
  // name and is kept.
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel
    .split(/[\\/]/)
    .filter((p) => p.length > 0)
    .join("/");
}
