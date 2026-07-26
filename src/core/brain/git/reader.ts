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

interface RunGitOptions {
  /**
   * Hard wall-clock bound for this invocation. Absent means "no bound",
   * which is the historical behaviour every pre-existing caller keeps.
   * A bounded caller (the workspace probe below, which runs inside a
   * hook's process ceiling) passes the remaining slice of its budget.
   */
  readonly timeoutMs?: number;
  /** Discard git's stderr instead of inheriting the parent's. */
  readonly quiet?: boolean;
}

function runGit(
  repoPath: string,
  args: ReadonlyArray<string>,
  opts: RunGitOptions = {},
): string | null {
  try {
    return execFileSync("git", ["-C", resolve(repoPath), ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // SIGKILL rather than SIGTERM: a git process wedged on a stalled
      // network filesystem is exactly the case the bound exists for, and
      // it is the case least likely to honour a polite signal.
      ...(opts.timeoutMs !== undefined
        ? { timeout: opts.timeoutMs, killSignal: "SIGKILL" as const }
        : {}),
      ...(opts.quiet === true ? { stdio: ["ignore", "pipe", "ignore"] as const } : {}),
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

// ----- Workspace identity (context-integrity-gates, Unit C) ----------------
//
// Session continuation needs to know whether two lifecycle observations
// happened in the SAME working state, not merely under the same `cwd`
// string. Repo, branch and commit are that state.

/**
 * What a working directory can attest about itself. Every field is
 * explicitly `null` when git could not report it (no remote, detached
 * HEAD, unborn branch), never absent - a caller comparing two
 * identities must be able to distinguish "not attested" from "attested
 * differently" without probing for key presence.
 */
export interface GitWorkspaceIdentity {
  /** Canonical remote identity - see {@link canonicalizeGitRemote}. */
  readonly repo: string | null;
  /** Short branch name; `null` on a detached HEAD. */
  readonly branch: string | null;
  /** Full 40-hex commit sha; `null` on an unborn branch. */
  readonly commit: string | null;
}

/** Default wall-clock bound for the whole workspace probe. */
export const GIT_PROBE_TIMEOUT_MS = 2_000;

/** `HEAD` is what `--abbrev-ref` prints for a detached checkout. */
const DETACHED_HEAD_REF = "HEAD";

/** `user@host:path` - the scp-like remote syntax, which is not a URL. */
const SCP_REMOTE_RE = /^(?<user>[^\s/@]+)@(?<host>[^\s/:]+):(?<path>(?!\/).+)$/;

/** A trailing `.git`, with or without trailing slashes already stripped. */
const DOT_GIT_SUFFIX_RE = /\.git$/;

/**
 * Reduce a git remote URL to a COMPARABLE repository identity of the
 * form `scheme://host/org/repo`, or `null` when the input names no
 * repository.
 *
 * This is a canonicalizer, NOT a redactor. `redactor.ts` rewrites
 * embedded credentials to a placeholder, which is right for a log and
 * useless as an identity key: two clones carrying different tokens
 * would produce the same placeholder string but a different one from a
 * credential-free clone of the same repository. Here userinfo, port, a
 * `.git` suffix and trailing slashes are normalized AWAY, so all three
 * clones compare equal - and, as a direct consequence, the credential
 * cannot survive into any recorded field.
 *
 * Host case is normalized (DNS is case-insensitive); path case is not
 * (many forges are case-sensitive, and folding it would merge two
 * genuinely distinct repositories).
 */
export function canonicalizeGitRemote(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;

  const url = parseRemote(trimmed);
  if (url === null) return null;
  // A URL-shaped string with no authority is not a remote - except for
  // `file:`, whose authority is empty by construction.
  const isFile = url.protocol === "file:";
  if (!isFile && url.hostname.length === 0) return null;

  const path = canonicalRemotePath(url.pathname);
  if (path === null) return null;
  return `${url.protocol}//${url.hostname}${path}`;
}

function parseRemote(value: string): URL | null {
  const scp = SCP_REMOTE_RE.exec(value);
  if (scp?.groups !== undefined) {
    return safeUrl(`ssh://${scp.groups["host"]}/${scp.groups["path"]}`);
  }
  // An absolute filesystem path is a legitimate git remote and is not a
  // URL; give it the `file:` scheme so it lands in the same shape.
  if (value.startsWith("/")) return safeUrl(`file://${value}`);
  return safeUrl(value);
}

function safeUrl(value: string): URL | null {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function canonicalRemotePath(pathname: string): string | null {
  let path = pathname;
  while (path.endsWith("/")) path = path.slice(0, -1);
  path = path.replace(DOT_GIT_SUFFIX_RE, "");
  while (path.endsWith("/")) path = path.slice(0, -1);
  // `https://host` alone identifies a forge, not a repository.
  return path.length === 0 || path === "/" ? null : path;
}

/**
 * Probe `repoPath` for its workspace identity, or `null` when it is not
 * inside a git repository (or the probe's budget ran out).
 *
 * TWO git invocations, both through the hardened fixed-argv {@link
 * runGit}: `rev-parse HEAD --abbrev-ref HEAD` yields the commit and the
 * branch together, and `remote get-url origin` yields the remote. The
 * whole probe shares ONE wall-clock budget - each invocation gets only
 * what is left of it - because this runs inside a lifecycle hook whose
 * own process ceiling it must never consume.
 *
 * Deliberately NOT gated on {@link isGitRepo}: that helper looks for a
 * `.git` entry in the directory itself, so it reports `false` for every
 * SUBDIRECTORY of a repository, which is where a session's `cwd`
 * usually sits. git's own resolution walks upward and is the authority.
 */
export function readGitWorkspaceIdentity(
  repoPath: string,
  opts: { readonly timeoutMs?: number } = {},
): GitWorkspaceIdentity | null {
  const budgetMs =
    typeof opts.timeoutMs === "number" && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? Math.floor(opts.timeoutMs)
      : GIT_PROBE_TIMEOUT_MS;
  const deadline = Date.now() + budgetMs;
  const probe = (args: ReadonlyArray<string>): string => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return "";
    return runGit(repoPath, args, { timeoutMs: remaining, quiet: true })?.trim() ?? "";
  };

  const [shaLine, refLine] = probe(["rev-parse", "HEAD", "--abbrev-ref", "HEAD"]).split("\n");
  const commit = isFullSha(shaLine?.trim()) ? shaLine!.trim() : null;
  const ref = refLine?.trim() ?? "";
  const branch = ref.length > 0 && ref !== DETACHED_HEAD_REF ? ref : null;
  const repo = canonicalizeGitRemote(probe(["remote", "get-url", "origin"]));

  if (repo === null && branch === null && commit === null) return null;
  return Object.freeze({ repo, branch, commit });
}

/** True when the (validated) sha resolves to a commit in this repo. */
export function shaExists(repoPath: string, sha: string): boolean {
  if (!isFullSha(sha)) return false;
  if (!isGitRepo(repoPath)) return false;
  return runGit(repoPath, ["cat-file", "-e", `${sha}^{commit}`]) !== null;
}
