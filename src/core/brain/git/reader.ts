/**
 * Sanitized read-only git reader (Project History Suite, t_c812752c).
 *
 * Every entry point shells out to the `git` binary with a FIXED argv via
 * `execFileSync` - no shell, no user-controlled flags, `--` separators
 * where paths could be ambiguous - following the proven
 * `src/core/discipline/activity-git.ts` pattern. The reader never
 * modifies the repository or its index.
 *
 * Caller-supplied SHAs are validated against the full-40-hex grammar
 * BEFORE they reach argv (`isFullSha`); anything else throws, so an
 * injection-shaped watermark can never become a git argument.
 *
 * Fail-soft contract: a missing repo, a non-repo directory, or a git
 * failure returns `null` (callers report "no history available"); an
 * EMPTY repository returns `[]` - "git works, zero commits" is a real
 * state the ingest watermark logic must distinguish from breakage.
 *
 * Commit records are parsed from `git log` with control-character field
 * separators: %x01 starts a record, %x00 separates fields, %x02 ends the
 * body. Control bytes cannot survive into commit metadata via normal git
 * usage, and a hand-crafted collision degrades to a skipped record, not
 * a corrupted neighbour.
 */

import { existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";

export interface GitCommit {
  readonly sha: string;
  readonly authorName: string;
  readonly authorEmail: string;
  /** Author date, ISO-8601 strict. */
  readonly committedAt: string;
  readonly subject: string;
  readonly body: string;
  /** Repo-relative touched paths; empty for merge commits. */
  readonly files: ReadonlyArray<string>;
}

export interface GitTag {
  readonly name: string;
  /** Peeled commit sha (annotated tags resolve through the tag object). */
  readonly targetSha: string;
  /** Tag creation date, ISO-8601 strict; null when git reports none. */
  readonly createdAt: string | null;
}

export interface ReadCommitsOptions {
  /** Only commits AFTER this sha (exclusive), i.e. `<sha>..HEAD`. */
  readonly sinceSha?: string;
  /** Bound the walk; git keeps the NEWEST `maxCount` commits. */
  readonly maxCount?: number;
  /**
   * Restrict the walk to commits that touched this repo-relative path
   * (a git pathspec). Passed after a `--` separator so it can never be
   * mistaken for a flag. Empty/whitespace is ignored (no restriction).
   */
  readonly path?: string;
}

// Output-side separators. argv strings cannot carry raw NUL bytes
// (Node rejects them), so the FORMAT strings below spell these as
// git-side hex escapes (`%x00` in pretty formats, `%00` in
// for-each-ref formats) and git emits the raw bytes in its OUTPUT,
// where they are safe to split on.
const RECORD_START = "\x01";
const FIELD_SEP = "\x00";
const BODY_END = "\x02";

/** Exactly 40 lowercase hex characters - a full git object sha. */
export function isFullSha(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function isGitRepo(repoPath: string): boolean {
  try {
    if (!statSync(repoPath).isDirectory()) return false;
  } catch {
    return false;
  }
  return existsSync(join(resolve(repoPath), ".git"));
}

function runGit(repoPath: string, args: ReadonlyArray<string>): string | null {
  try {
    return execFileSync("git", ["-C", resolve(repoPath), ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    // Fail-soft: a broken repo / missing git binary reads as "no
    // history", mirroring activity-git.ts. Callers that need to
    // distinguish breakage from emptiness check isGitRepo first.
    return null;
  }
}

/**
 * Read commits oldest-first. `null` when the directory is not a git
 * repo or git fails; `[]` for a repo with no commits (yet).
 */
export function readCommits(
  repoPath: string,
  opts: ReadCommitsOptions,
): ReadonlyArray<GitCommit> | null {
  if (!isGitRepo(repoPath)) return null;
  if (opts.sinceSha !== undefined && !isFullSha(opts.sinceSha)) {
    throw new Error(`sinceSha must be a full 40-hex git sha, got: ${String(opts.sinceSha)}`);
  }
  const args = [
    "log",
    "--name-only",
    "--pretty=format:%x01%H%x00%an%x00%ae%x00%aI%x00%s%x00%b%x02",
  ];
  if (opts.maxCount !== undefined) {
    args.push(`--max-count=${Math.max(1, Math.floor(opts.maxCount))}`);
  }
  if (opts.sinceSha !== undefined) args.push(`${opts.sinceSha}..HEAD`);
  const pathspec = opts.path?.trim();
  if (pathspec !== undefined && pathspec.length > 0) args.push("--", pathspec);
  const raw = runGit(repoPath, args);
  if (raw === null) {
    // `git log` exits non-zero on a repo with zero commits; report that
    // as empty history rather than breakage when the repo itself is fine.
    return emptyRepoOrNull(repoPath);
  }
  const commits: GitCommit[] = [];
  for (const record of raw.split(RECORD_START)) {
    if (record.trim() === "") continue;
    const bodyEnd = record.indexOf(BODY_END);
    if (bodyEnd === -1) continue; // collision-degraded record: skip
    const fields = record.slice(0, bodyEnd).split(FIELD_SEP);
    if (fields.length !== 6) continue;
    const [sha, authorName, authorEmail, committedAt, subject, body] = fields;
    if (!isFullSha(sha)) continue;
    const files = record
      .slice(bodyEnd + 1)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    commits.push(
      Object.freeze({
        sha,
        authorName: authorName ?? "",
        authorEmail: authorEmail ?? "",
        committedAt: committedAt ?? "",
        subject: subject ?? "",
        body: (body ?? "").trim(),
        files: Object.freeze(files),
      }),
    );
  }
  return Object.freeze(commits.toReversed());
}

function emptyRepoOrNull(repoPath: string): ReadonlyArray<GitCommit> | null {
  const probe = runGit(repoPath, ["rev-parse", "--git-dir"]);
  return probe === null ? null : Object.freeze([]);
}

/**
 * List tags with peeled commit shas. `null` on non-repos / git failure,
 * `[]` on tagless repos.
 */
export function readTags(repoPath: string): ReadonlyArray<GitTag> | null {
  if (!isGitRepo(repoPath)) return null;
  const format =
    "%(refname:short)%00" +
    "%(if)%(*objectname)%(then)%(*objectname)%(else)%(objectname)%(end)%00" +
    "%(creatordate:iso-strict)";
  const raw = runGit(repoPath, ["tag", "--list", `--format=${format}`]);
  if (raw === null) return null;
  const tags: GitTag[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    const [name, targetSha, createdAt] = line.split(FIELD_SEP);
    if (name === undefined || name === "" || !isFullSha(targetSha)) continue;
    tags.push(
      Object.freeze({
        name,
        targetSha,
        createdAt: createdAt !== undefined && createdAt !== "" ? createdAt : null,
      }),
    );
  }
  return Object.freeze(tags);
}

/**
 * Shas reachable from `to` but not from `from`, oldest-first - the
 * standard changelog range. `from === null` means "everything up to
 * `to`" (the first tag's range).
 */
export function revListRange(
  repoPath: string,
  from: string | null,
  to: string,
): ReadonlyArray<string> | null {
  if (!isGitRepo(repoPath)) return null;
  if (from !== null && !isFullSha(from)) {
    throw new Error(`revListRange 'from' must be a full 40-hex git sha, got: ${String(from)}`);
  }
  if (!isFullSha(to)) {
    throw new Error(`revListRange 'to' must be a full 40-hex git sha, got: ${String(to)}`);
  }
  const raw = runGit(repoPath, ["rev-list", "--reverse", from === null ? to : `${from}..${to}`]);
  if (raw === null) return null;
  return Object.freeze(raw.split("\n").filter((line) => isFullSha(line.trim())));
}

/** True when the (validated) sha resolves to a commit in this repo. */
export function shaExists(repoPath: string, sha: string): boolean {
  if (!isFullSha(sha)) return false;
  if (!isGitRepo(repoPath)) return false;
  return runGit(repoPath, ["cat-file", "-e", `${sha}^{commit}`]) !== null;
}
