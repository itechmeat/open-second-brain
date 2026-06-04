/**
 * Per-repo git record store (Project History Suite, t_c812752c).
 *
 * Canonical source of truth for ingested history. Each linked repo owns
 * `Brain/projects/git/<repo-key>/` with two files:
 *
 *   - `commits.jsonl` - append-only mixed-kind records (`commit` | `tag`),
 *     snake_case on disk like the continuity shards, deduplicated by
 *     commit sha / tag name on append. Typed edges (touched files,
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
import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { isFullSha } from "./reader.ts";

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
  readonly skipped: number;
}

/** Per-repo store directory inside the vault. */
export function gitStoreDir(vault: string, repoKey: string): string {
  return join(vault, "Brain", "projects", "git", repoKey);
}

function commitsPath(vault: string, repoKey: string): string {
  return join(gitStoreDir(vault, repoKey), "commits.jsonl");
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

function readRecords(vault: string, repoKey: string): ReadonlyArray<GitRecord> {
  const path = commitsPath(vault, repoKey);
  if (!existsSync(path)) return [];
  const records: GitRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (line.trim() === "") continue;
    const record = parseRecord(line);
    if (record !== null) records.push(record);
  }
  return records;
}

/**
 * Append records, deduplicating commits by sha and tags by name against
 * everything already on disk AND earlier entries of the same batch.
 */
export function appendGitRecords(
  vault: string,
  repoKey: string,
  records: ReadonlyArray<GitRecord>,
): AppendGitRecordsResult {
  const existing = readRecords(vault, repoKey);
  const seenShas = new Set<string>();
  const seenTags = new Set<string>();
  for (const record of existing) {
    if (record.kind === "commit") seenShas.add(record.sha);
    else seenTags.add(record.name);
  }
  const lines: string[] = [];
  let skipped = 0;
  for (const record of records) {
    const key = record.kind === "commit" ? record.sha : record.name;
    const seen = record.kind === "commit" ? seenShas : seenTags;
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    lines.push(serializeRecord(record) + "\n");
  }
  if (lines.length > 0) {
    mkdirSync(gitStoreDir(vault, repoKey), { recursive: true });
    appendFileSync(commitsPath(vault, repoKey), lines.join(""));
  }
  return { appended: lines.length, skipped };
}

/** Commits oldest-first (file order), optionally filtered. */
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
    commits = commits.filter((c) => Date.parse(c.committedAt) >= since);
  }
  if (filter.until !== undefined) {
    const until = Date.parse(filter.until);
    commits = commits.filter((c) => Date.parse(c.committedAt) <= until);
  }
  if (filter.limit !== undefined && filter.limit >= 0) {
    commits = commits.slice(Math.max(0, commits.length - Math.floor(filter.limit)));
  }
  return Object.freeze(commits);
}

/** Tags in file (ingest) order. */
export function listGitTags(vault: string, repoKey: string): ReadonlyArray<GitTagRecord> {
  return Object.freeze(
    readRecords(vault, repoKey).filter((record): record is GitTagRecord => record.kind === "tag"),
  );
}

/** Watermark write; the sha grammar is enforced before anything lands. */
export function writeGitState(vault: string, repoKey: string, state: GitState): void {
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

/** Every per-repo store under Brain/projects/git/, sorted by key. */
export function listGitRepos(vault: string): ReadonlyArray<GitRepoEntry> {
  const root = join(vault, "Brain", "projects", "git");
  if (!existsSync(root)) return [];
  const entries: GitRepoEntry[] = [];
  for (const name of readdirSync(root).toSorted()) {
    const dir = join(root, name);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const probe = readGitState(vault, name);
    entries.push(Object.freeze({ key: name, state: probe.state, stateError: probe.error }));
  }
  return Object.freeze(entries);
}
