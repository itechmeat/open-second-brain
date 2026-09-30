/**
 * Per-repo git record store (Project History Suite, t_c812752c).
 *
 * Canonical source of truth for ingested history. Each linked repo owns
 * `Brain/projects/git/<repo-key>/` with two kinds of file:
 *
 *   - `commits[.<deviceId>].jsonl` - one append-only shard per device of
 *     mixed-kind records (`commit` | `tag`), merged on read by record time,
 *     snake_case on disk like the continuity shards, deduplicated by
 *     commit sha / tag (name, target) on append and again on the merged
 *     read. Typed edges (touched files,
 *     author, carrying release) are STRUCTURED FIELDS here; wikilinks in
 *     rendered notes are always derived from these records, never
 *     hand-maintained (design decision: contain dual-representation drift).
 *   - `state.json` - the ingest watermark. The sha is validated against
 *     the full-40-hex grammar on BOTH write and read, so a tampered
 *     watermark surfaces as a probe error long before it could reach a
 *     git argv (the reader re-validates anyway - defense in depth).
 *
 * The store lives INSIDE the vault (unlike the device-local
 * `projects.json` registry): project memory syncs with the Brain.
 * Tolerant reads: malformed JSONL lines are skipped, a malformed state
 * file reads as an error probe - mirroring `Brain/log/` conventions.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import {
  interleaveShardRows,
  JSONL_LEDGER_EXT,
  jsonlLedgerGrammar,
  readShardLinesByShard,
  resolveAppendShardId,
  shardedFileName,
} from "../ledger-shards.ts";
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { isFullSha } from "./reader.ts";
import { acquireLockSyncWithRetry, ingestLockRemedy } from "../sync-lockfile.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";

export interface GitCommitRecord {
  readonly kind: "commit";
  readonly sha: string;
  readonly authorName: string;
  readonly authorEmail: string;
  readonly committedAt: string;
  readonly subject: string;
  readonly body: string;
  readonly files: ReadonlyArray<string>;
  /** Carrying release (tag name) assigned by range attribution, or null. */
  readonly release: string | null;
}

export interface GitTagRecord {
  readonly kind: "tag";
  readonly name: string;
  readonly targetSha: string;
  readonly createdAt: string | null;
}

export type GitRecord = GitCommitRecord | GitTagRecord;

export interface GitState {
  readonly repoPath: string;
  readonly lastSha: string;
  readonly lastIngestedAt: string;
}

export interface GitStateProbe {
  readonly state: GitState | null;
  readonly error: string | null;
}

export interface GitCommitFilter {
  /** Exact repo-relative touched path. */
  readonly file?: string;
  /** Case-insensitive substring over author name + email. */
  readonly author?: string;
  /** Case-insensitive substring over subject + body. */
  readonly text?: string;
  /** ISO bound on committedAt (inclusive). */
  readonly since?: string;
  readonly until?: string;
  /** Keep the NEWEST n matches (order stays oldest-first). */
  readonly limit?: number;
}

export interface AppendGitRecordsResult {
  readonly appended: number;
  readonly appendedCommits: number;
  readonly appendedTags: number;
  readonly skipped: number;
}

/** The commits ledger's shard stem: `commits[.<deviceId>].jsonl`. */
const COMMITS_STEM = "commits";

/** The commits ledger's file-name layout, handed to the shared shard grammar. */
const COMMITS_GRAMMAR = jsonlLedgerGrammar(COMMITS_STEM);

/** `Brain/projects/git/`: the root that holds one store directory per repository. */
export function gitStoreRootDir(vault: string): string {
  return join(vault, "Brain", "projects", "git");
}

/** Per-repo store directory inside the vault. */
export function gitStoreDir(vault: string, repoKey: string): string {
  return join(gitStoreRootDir(vault), repoKey);
}

function commitsPath(vault: string, repoKey: string): string {
  // Per-device shard (t_774dea61): each machine appends to - and locks -
  // its own file; the empty device id keeps the legacy un-sharded name.
  return join(
    gitStoreDir(vault, repoKey),
    shardedFileName(COMMITS_STEM, resolveAppendShardId(), JSONL_LEDGER_EXT),
  );
}

function statePath(vault: string, repoKey: string): string {
  return join(gitStoreDir(vault, repoKey), "state.json");
}

function serializeRecord(record: GitRecord): string {
  if (record.kind === "commit") {
    return JSON.stringify({
      kind: "commit",
      sha: record.sha,
      author_name: record.authorName,
      author_email: record.authorEmail,
      committed_at: record.committedAt,
      subject: record.subject,
      body: record.body,
      files: record.files,
      release: record.release,
    });
  }
  return JSON.stringify({
    kind: "tag",
    name: record.name,
    target_sha: record.targetSha,
    created_at: record.createdAt,
  });
}

function parseRecord(line: string): GitRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const rec = raw as Record<string, unknown>;
  if (rec["kind"] === "commit") {
    if (!isFullSha(rec["sha"])) return null;
    return Object.freeze({
      kind: "commit" as const,
      sha: rec["sha"],
      authorName: typeof rec["author_name"] === "string" ? rec["author_name"] : "",
      authorEmail: typeof rec["author_email"] === "string" ? rec["author_email"] : "",
      committedAt: typeof rec["committed_at"] === "string" ? rec["committed_at"] : "",
      subject: typeof rec["subject"] === "string" ? rec["subject"] : "",
      body: typeof rec["body"] === "string" ? rec["body"] : "",
      files: Object.freeze(
        Array.isArray(rec["files"])
          ? rec["files"].filter((f): f is string => typeof f === "string")
          : [],
      ),
      release: typeof rec["release"] === "string" ? rec["release"] : null,
    });
  }
  if (rec["kind"] === "tag") {
    if (typeof rec["name"] !== "string" || rec["name"] === "") return null;
    if (!isFullSha(rec["target_sha"])) return null;
    return Object.freeze({
      kind: "tag" as const,
      name: rec["name"],
      targetSha: rec["target_sha"],
      createdAt: typeof rec["created_at"] === "string" ? rec["created_at"] : null,
    });
  }
  return null;
}

/**
 * When a record happened, as the cross-device merge orders it. A record
 * without a readable time (a tag with no `createdAt`) sorts as early as
 * possible, which in the merge means straight after the record its own
 * shard holds before it.
 */
function recordTime(record: GitRecord): number {
  const time = Date.parse(record.kind === "commit" ? record.committedAt : (record.createdAt ?? ""));
  return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
}

/**
 * Every record across every device's shard (t_774dea61), oldest first:
 * shards are interleaved by record time, each shard keeping its own file
 * order, so a single-shard store reads exactly as before and `limit` and
 * the latest-tag view see one timeline whatever the shard names are. The
 * dedup on append reads the same merge, so it also sees commits a synced
 * peer ingested.
 *
 * The merge also keeps only the first occurrence of each record identity
 * (see {@link recordIdentity}). The append dedup cannot see a shard that
 * has not synced yet, so two devices ingesting the same history before
 * Syncthing delivers both write it; without this, every commit they share
 * would list twice and a `limit` would count the copies.
 */
function readRecords(vault: string, repoKey: string): ReadonlyArray<GitRecord> {
  const shards = readShardLinesByShard(gitStoreDir(vault, repoKey), COMMITS_GRAMMAR).map(
    (shard) => ({
      shardId: shard.shardId,
      rows: shard.rows.map(parseRecord).filter((record) => record !== null),
    }),
  );
  const seen = new Set<string>();
  return interleaveShardRows(shards, recordTime).filter((record) => {
    const identity = recordIdentity(record);
    if (seen.has(identity)) return false;
    seen.add(identity);
    return true;
  });
}

/**
 * What makes two records the same record: a commit's sha, a tag's
 * (name, target). A retargeted tag (same name, new target) is a new
 * record; listGitTags surfaces the latest per name. The kind prefix keeps
 * the two key spaces apart.
 */
function recordIdentity(record: GitRecord): string {
  return record.kind === "commit"
    ? `commit\x00${record.sha}`
    : `tag\x00${record.name}\x00${record.targetSha}`;
}

/**
 * Append records, deduplicating commits by sha and tags by
 * (name, target) against everything already on disk AND earlier
 * entries of the same batch.
 *
 * The dedup read and the append are ONE critical section under the
 * sync lock. Appending is atomic enough that no line is ever torn, but
 * dedup is a read-modify-append: two processes ingesting overlapping
 * history at once would both find a sha absent and both write it, so
 * the store's identity guarantee holds only while the read and the
 * append cannot interleave.
 */
export function appendGitRecords(
  vault: string,
  repoKey: string,
  records: ReadonlyArray<GitRecord>,
): AppendGitRecordsResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const handle = acquireLockSyncWithRetry(commitsPath(vault, repoKey), undefined, {
    remedy: ingestLockRemedy,
  });
  try {
    return appendGitRecordsLocked(vault, repoKey, records);
  } finally {
    handle.release();
  }
}

function appendGitRecordsLocked(
  vault: string,
  repoKey: string,
  records: ReadonlyArray<GitRecord>,
): AppendGitRecordsResult {
  // Tag identity is (name, target): a RETARGETED tag (same name, new
  // commit after a force-move) appends a fresh record instead of being
  // silently dropped; listGitTags surfaces the latest record per name.
  const seen = new Set(readRecords(vault, repoKey).map(recordIdentity));
  const lines: string[] = [];
  let skipped = 0;
  let appendedCommits = 0;
  let appendedTags = 0;
  for (const record of records) {
    const key = recordIdentity(record);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    if (record.kind === "commit") appendedCommits += 1;
    else appendedTags += 1;
    lines.push(serializeRecord(record) + "\n");
  }
  if (lines.length > 0) {
    mkdirSync(gitStoreDir(vault, repoKey), { recursive: true });
    appendFileSync(commitsPath(vault, repoKey), lines.join(""));
  }
  return { appended: lines.length, appendedCommits, appendedTags, skipped };
}

/** Commits oldest-first (file order, devices merged by commit time), optionally filtered. */
export function listGitCommits(
  vault: string,
  repoKey: string,
  filter: GitCommitFilter = {},
): ReadonlyArray<GitCommitRecord> {
  let commits = readRecords(vault, repoKey).filter(
    (record): record is GitCommitRecord => record.kind === "commit",
  );
  if (filter.file !== undefined) {
    const file = filter.file;
    commits = commits.filter((c) => c.files.includes(file));
  }
  if (filter.author !== undefined) {
    const needle = filter.author.toLowerCase();
    commits = commits.filter((c) =>
      `${c.authorName} ${c.authorEmail}`.toLowerCase().includes(needle),
    );
  }
  if (filter.text !== undefined) {
    const needle = filter.text.toLowerCase();
    commits = commits.filter((c) => `${c.subject}\n${c.body}`.toLowerCase().includes(needle));
  }
  if (filter.since !== undefined) {
    const since = Date.parse(filter.since);
    if (Number.isNaN(since)) {
      throw new Error(`invalid 'since' datetime: ${filter.since}`);
    }
    commits = commits.filter((c) => Date.parse(c.committedAt) >= since);
  }
  if (filter.until !== undefined) {
    const until = Date.parse(filter.until);
    if (Number.isNaN(until)) {
      throw new Error(`invalid 'until' datetime: ${filter.until}`);
    }
    commits = commits.filter((c) => Date.parse(c.committedAt) <= until);
  }
  if (filter.limit !== undefined && filter.limit >= 0) {
    commits = commits.slice(Math.max(0, commits.length - Math.floor(filter.limit)));
  }
  return Object.freeze(commits);
}

/**
 * Tags in first-seen order, latest record per name - a retargeted tag
 * (appended as a fresh (name, target) record) replaces its predecessor
 * in this view.
 */
export function listGitTags(vault: string, repoKey: string): ReadonlyArray<GitTagRecord> {
  const byName = new Map<string, GitTagRecord>();
  for (const record of readRecords(vault, repoKey)) {
    if (record.kind === "tag") byName.set(record.name, record);
  }
  return Object.freeze([...byName.values()]);
}

/** Watermark write; the sha grammar is enforced before anything lands. */
export function writeGitState(vault: string, repoKey: string, state: GitState): void {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  if (!isFullSha(state.lastSha)) {
    throw new Error(`git state lastSha must be a full 40-hex git sha, got: ${state.lastSha}`);
  }
  mkdirSync(gitStoreDir(vault, repoKey), { recursive: true });
  atomicWriteFileSync(
    statePath(vault, repoKey),
    JSON.stringify(
      {
        repo_path: state.repoPath,
        last_sha: state.lastSha,
        last_ingested_at: state.lastIngestedAt,
      },
      null,
      2,
    ) + "\n",
  );
}

/**
 * Watermark probe. Missing file: `{ state: null, error: null }` (fresh
 * repo). Malformed JSON or an invalid sha: `{ state: null, error }` so
 * ingest can fall back to a full re-scan and REPORT why.
 */
export function readGitState(vault: string, repoKey: string): GitStateProbe {
  const path = statePath(vault, repoKey);
  if (!existsSync(path)) return Object.freeze({ state: null, error: null });
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (exc) {
    return Object.freeze({
      state: null,
      error: `git state is not valid JSON: ${(exc as Error).message}`,
    });
  }
  const rec = (raw ?? {}) as Record<string, unknown>;
  const lastSha = rec["last_sha"];
  if (!isFullSha(lastSha)) {
    return Object.freeze({
      state: null,
      error: `git state last_sha must be a full 40-hex git sha, got: ${String(lastSha)}`,
    });
  }
  return Object.freeze({
    state: Object.freeze({
      repoPath: typeof rec["repo_path"] === "string" ? rec["repo_path"] : "",
      lastSha,
      lastIngestedAt: typeof rec["last_ingested_at"] === "string" ? rec["last_ingested_at"] : "",
    }),
    error: null,
  });
}

export interface GitRepoEntry {
  readonly key: string;
  readonly state: GitState | null;
  readonly stateError: string | null;
}

/**
 * Stat errors that mean the entry is simply not there any more (removed
 * between the listing and the stat, or a dangling link), so skipping it
 * is the honest answer. Any other code is a store that could not be read.
 */
const VANISHED_ENTRY_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]);

/**
 * Every per-repo store under Brain/projects/git/, sorted by key. An entry
 * that vanished is skipped; one that exists but cannot be stat'ed throws
 * an error naming the path and its code instead of disappearing from the
 * list.
 */
export function listGitRepos(vault: string): ReadonlyArray<GitRepoEntry> {
  const root = gitStoreRootDir(vault);
  if (!existsSync(root)) return [];
  const entries: GitRepoEntry[] = [];
  for (const name of readdirSync(root).toSorted()) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch (exc) {
      const code = (exc as NodeJS.ErrnoException).code;
      if (code !== undefined && VANISHED_ENTRY_CODES.has(code)) continue;
      throw new Error(`git store entry ${dir} could not be read: ${code ?? String(exc)}`, {
        cause: exc,
      });
    }
    const probe = readGitState(vault, name);
    entries.push(Object.freeze({ key: name, state: probe.state, stateError: probe.error }));
  }
  return Object.freeze(entries);
}
