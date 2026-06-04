/**
 * Git history ingest orchestration (Project History Suite, t_c812752c).
 *
 * One run = read new commits + tags from a worktree, attribute carrying
 * releases via tag ranges, append records (store dedups), advance the
 * watermark, regenerate the digest note. Incremental by default: the
 * watermark sha bounds the walk to `<last>..HEAD`. Two degraded paths
 * both fall back to a FULL re-scan with a reported warning instead of
 * failing or duplicating:
 *
 *   - watermark sha no longer resolves in the repo (force-push,
 *     history rewrite) -> `mode: "rescan"`, store dedup absorbs overlap;
 *   - state.json malformed / tampered -> same, with the probe error
 *     surfaced as the warning.
 *
 * Release attribution uses the standard changelog rule: tags sorted by
 * creation date; `rev-list <prev>..<tag>` is exactly the commit set the
 * tag carried (one git call per tag, no per-commit ancestry walks).
 * Commits outside every range carry `release: null` - unreleased work.
 *
 * The ingest never modifies the repository: the reader is read-only by
 * construction, and the only writes land inside the vault.
 */

import { rmSync } from "node:fs";
import { join, resolve } from "node:path";

import { atomicWriteFileSync } from "../../fs-atomic.ts";
import { renderGitDigest } from "./digest.ts";
import { repoKey as deriveRepoKey } from "./identity.ts";
import { readCommits, readTags, revListRange, shaExists } from "./reader.ts";
import type { GitCommit, GitTag } from "./reader.ts";
import {
  appendGitRecords,
  gitStoreDir,
  listGitCommits,
  listGitTags,
  readGitState,
  writeGitState,
} from "./store.ts";
import type { GitCommitRecord, GitRecord, GitTagRecord } from "./store.ts";

export const DEFAULT_MAX_COUNT = 1000;

export type GitIngestMode = "initial" | "incremental" | "rescan";

export class GitIngestError extends Error {
  readonly code: "NOT_A_REPO";

  constructor(message: string) {
    super(message);
    this.name = "GitIngestError";
    this.code = "NOT_A_REPO";
  }
}

export interface IngestGitHistoryOptions {
  /** Bound the walk; git keeps the NEWEST commits. Default 1000. */
  readonly maxCount?: number;
  readonly now?: Date;
}

export interface IngestGitHistoryResult {
  readonly repoKey: string;
  readonly repoPath: string;
  readonly mode: GitIngestMode;
  readonly newCommits: number;
  readonly skippedCommits: number;
  readonly newTags: number;
  /** New watermark sha, or null when the repo has no commits. */
  readonly watermark: string | null;
  /** Absolute path of the regenerated digest note. */
  readonly digestPath: string;
  /** Degradation reason (re-scan cause), or null on a clean run. */
  readonly warning: string | null;
}

/**
 * Build sha -> carrying release name from chronologically ordered tag
 * ranges. First (oldest) containing tag wins, matching changelog
 * attribution.
 */
function attributeReleases(
  repoPath: string,
  tags: ReadonlyArray<GitTag>,
): ReadonlyMap<string, string> {
  const ordered = tags.toSorted((a, b) => {
    if (a.createdAt === null && b.createdAt === null) return a.name.localeCompare(b.name);
    if (a.createdAt === null) return 1;
    if (b.createdAt === null) return -1;
    return Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.name.localeCompare(b.name);
  });
  const bySha = new Map<string, string>();
  let prev: string | null = null;
  for (const tag of ordered) {
    const range = revListRange(repoPath, prev, tag.targetSha);
    if (range !== null) {
      for (const sha of range) {
        if (!bySha.has(sha)) bySha.set(sha, tag.name);
      }
    }
    prev = tag.targetSha;
  }
  return bySha;
}

/** Ingest one repo's history into the vault store + digest note. */
export function ingestGitHistory(
  vault: string,
  repoPath: string,
  opts: IngestGitHistoryOptions = {},
): IngestGitHistoryResult {
  const repo = resolve(repoPath);
  const key = deriveRepoKey(repo);
  const maxCount = opts.maxCount ?? DEFAULT_MAX_COUNT;
  const now = (opts.now ?? new Date()).toISOString();

  // Watermark probe decides the walk mode; degraded probes re-scan.
  const probe = readGitState(vault, key);
  let mode: GitIngestMode;
  let sinceSha: string | undefined;
  let warning: string | null = null;
  if (probe.error !== null) {
    mode = "rescan";
    warning = `watermark unreadable, falling back to full re-scan: ${probe.error}`;
  } else if (probe.state === null) {
    mode = "initial";
  } else if (!shaExists(repo, probe.state.lastSha)) {
    mode = "rescan";
    warning =
      `watermark ${probe.state.lastSha.slice(0, 7)} no longer resolves ` +
      "(history rewritten?), falling back to full re-scan";
  } else {
    mode = "incremental";
    sinceSha = probe.state.lastSha;
  }

  const commits = readCommits(repo, {
    maxCount,
    ...(sinceSha !== undefined ? { sinceSha } : {}),
  });
  if (commits === null) {
    throw new GitIngestError(`not a git repository (or git unavailable): ${repo}`);
  }
  if (commits.length >= maxCount && mode !== "incremental") {
    // A bounded initial/rescan walk kept only the NEWEST maxCount
    // commits; older history is outside the watermark and will not
    // arrive on later incremental runs. Surface that instead of letting
    // the digest silently under-represent deep history.
    warning =
      (warning === null ? "" : `${warning}; `) +
      `walk bounded at ${maxCount} commit(s) - older history not ingested ` +
      "(re-run with a higher --max-count to backfill)";
  }
  const tags = readTags(repo) ?? [];

  // Attribute releases only when there is anything new to attribute.
  const releaseBySha =
    commits.length > 0 ? attributeReleases(repo, tags) : new Map<string, string>();

  const newTagRecords: GitTagRecord[] = tags.map((tag) => ({
    kind: "tag" as const,
    name: tag.name,
    targetSha: tag.targetSha,
    createdAt: tag.createdAt,
  }));
  const newCommitRecords: GitCommitRecord[] = commits.map((commit: GitCommit) => ({
    kind: "commit" as const,
    sha: commit.sha,
    authorName: commit.authorName,
    authorEmail: commit.authorEmail,
    committedAt: commit.committedAt,
    subject: commit.subject,
    body: commit.body,
    files: commit.files,
    release: releaseBySha.get(commit.sha) ?? null,
  }));

  const batch: GitRecord[] = [...newTagRecords, ...newCommitRecords];
  const appendResult = appendGitRecords(vault, key, batch);

  // Advance the watermark to the newest commit we saw this run. On an
  // INCREMENTAL run with no new commits the previous watermark still
  // holds; on a re-scan the prior watermark is the very sha that failed
  // to resolve, so writing it back would loop the repo through rescan
  // warnings forever - clear the state instead and let the next run
  // start clean as an initial walk.
  const newest =
    commits.at(-1)?.sha ?? (mode === "incremental" ? (probe.state?.lastSha ?? null) : null);
  if (newest !== null) {
    writeGitState(vault, key, { repoPath: repo, lastSha: newest, lastIngestedAt: now });
  } else if (mode === "rescan") {
    rmSync(join(gitStoreDir(vault, key), "state.json"), { force: true });
  }

  // Regenerate the digest projection from the FULL store.
  const digestPath = join(gitStoreDir(vault, key), "digest.md");
  const digest = renderGitDigest({
    repoKey: key,
    repoPath: repo,
    commits: listGitCommits(vault, key),
    tags: listGitTags(vault, key),
  });
  atomicWriteFileSync(digestPath, digest);

  return Object.freeze({
    repoKey: key,
    repoPath: repo,
    mode,
    newCommits: appendResult.appendedCommits,
    skippedCommits: appendResult.skipped,
    newTags: appendResult.appendedTags,
    watermark: newest,
    digestPath,
    warning,
  });
}
