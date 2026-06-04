/**
 * `o2b brain git <ingest|status|find>` (Project History Suite,
 * t_c812752c): git history as Second Brain memory. `ingest` walks a
 * worktree read-only and lands records + digest in the vault, `status`
 * reports per-repo watermarks, `find` answers "why/when did this
 * change" from the store - no live git calls on the query path, so the
 * answers work even when the repo is gone.
 */

import { defaultConfigPath } from "../../../core/config.ts";
import { mineCommitDecisions } from "../../../core/brain/git/decisions.ts";
import { GitIngestError, ingestGitHistory } from "../../../core/brain/git/ingest.ts";
import { listGitCommits, listGitRepos, listGitTags } from "../../../core/brain/git/store.ts";
import type { GitCommitFilter, GitCommitRecord } from "../../../core/brain/git/store.ts";
import { fail, ok, okJson, parse, resolveBrainVault } from "../helpers.ts";

const USAGE = "usage: o2b brain git <ingest|status|find|mine> [args] [--vault V] [--json]";

const FIND_DEFAULT_LIMIT = 20;

export async function cmdBrainGit(argv: string[]): Promise<number> {
  const action = argv[0];
  if (action === "ingest") return cmdIngest(argv.slice(1));
  if (action === "status") return cmdStatus(argv.slice(1));
  if (action === "find") return cmdFind(argv.slice(1));
  if (action === "mine") return cmdMine(argv.slice(1));
  return fail(USAGE);
}

async function cmdMine(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    repo: { type: "string" },
  });
  try {
    const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());
    const repoFilter = flags["repo"] as string | undefined;
    const repos = listGitRepos(vault).filter(
      (entry) => repoFilter === undefined || entry.key === repoFilter,
    );
    if (repoFilter !== undefined && repos.length === 0) {
      return fail(`no ingested git history for repo key: ${repoFilter}`);
    }
    const results = repos.map((entry) => mineCommitDecisions(vault, entry.key));
    if (flags["json"] === true) {
      okJson({
        ok: true,
        repos: results.map((res) => ({
          repo_key: res.repoKey,
          scanned: res.scanned,
          candidates: res.candidates,
          created: res.created,
          skipped_existing: res.skippedExisting,
          notes: res.notes,
        })),
      });
      return 0;
    }
    if (results.length === 0) {
      ok("no git history ingested yet (run: o2b brain git ingest <repo-path>)");
      return 0;
    }
    for (const res of results) {
      ok(
        `${res.repoKey}: ${res.scanned} commit(s) scanned, ${res.created} new ` +
          `candidate(s), ${res.skippedExisting} already curated`,
      );
    }
    return 0;
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }
}

async function cmdIngest(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    "max-count": { type: "string" },
  });
  const target = positional[0];
  if (!target) return fail("brain git ingest requires a repository path");
  let maxCount: number | undefined;
  if (flags["max-count"] !== undefined) {
    maxCount = Number.parseInt(flags["max-count"] as string, 10);
    if (!Number.isInteger(maxCount) || maxCount < 1) {
      return fail("--max-count must be a positive integer");
    }
  }
  try {
    const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());
    const res = ingestGitHistory(vault, target, maxCount !== undefined ? { maxCount } : {});
    if (flags["json"] === true) {
      okJson({
        ok: true,
        repo_key: res.repoKey,
        repo_path: res.repoPath,
        mode: res.mode,
        new_commits: res.newCommits,
        skipped_records: res.skippedCommits,
        new_tags: res.newTags,
        watermark: res.watermark,
        digest_path: res.digestPath,
        warning: res.warning,
      });
      return 0;
    }
    ok(
      `${res.mode} ingest of ${res.repoKey}: ${res.newCommits} new commit(s), ` +
        `${res.newTags} new tag(s)`,
    );
    if (res.warning !== null) ok(`warning: ${res.warning}`);
    ok(`digest: ${res.digestPath}`);
    return 0;
  } catch (err) {
    if (err instanceof GitIngestError) return fail(err.message);
    return fail((err as Error).message ?? String(err));
  }
}

async function cmdStatus(argv: string[]): Promise<number> {
  const { flags } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
  });
  try {
    const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());
    const repos = listGitRepos(vault).map((entry) => ({
      key: entry.key,
      repo_path: entry.state?.repoPath ?? null,
      last_sha: entry.state?.lastSha ?? null,
      last_ingested_at: entry.state?.lastIngestedAt ?? null,
      state_error: entry.stateError,
      commits: listGitCommits(vault, entry.key).length,
      tags: listGitTags(vault, entry.key).length,
    }));
    if (flags["json"] === true) {
      okJson({ ok: true, repos });
      return 0;
    }
    if (repos.length === 0) {
      ok("no git history ingested yet (run: o2b brain git ingest <repo-path>)");
      return 0;
    }
    for (const repo of repos) {
      const mark = repo.last_sha === null ? "no watermark" : repo.last_sha.slice(0, 7);
      const err = repo.state_error === null ? "" : ` [state error: ${repo.state_error}]`;
      ok(`${repo.key}: ${repo.commits} commit(s), ${repo.tags} tag(s), watermark ${mark}${err}`);
    }
    return 0;
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }
}

async function cmdFind(argv: string[]): Promise<number> {
  const { flags, positional } = parse(argv, {
    vault: { type: "string" },
    json: { type: "boolean" },
    repo: { type: "string" },
    file: { type: "string" },
    author: { type: "string" },
    since: { type: "string" },
    until: { type: "string" },
    limit: { type: "string" },
  });
  const text = positional[0];
  if (
    text === undefined &&
    flags["file"] === undefined &&
    flags["author"] === undefined &&
    flags["since"] === undefined &&
    flags["until"] === undefined
  ) {
    return fail(
      "brain git find requires a query: free text and/or --file/--author/--since/--until",
    );
  }
  let limit = FIND_DEFAULT_LIMIT;
  if (flags["limit"] !== undefined) {
    limit = Number.parseInt(flags["limit"] as string, 10);
    if (!Number.isInteger(limit) || limit < 1) return fail("--limit must be a positive integer");
  }
  try {
    const vault = resolveBrainVault(flags["vault"] as string | undefined, defaultConfigPath());
    const filter: GitCommitFilter = {
      ...(text !== undefined ? { text } : {}),
      ...(flags["file"] !== undefined ? { file: flags["file"] as string } : {}),
      ...(flags["author"] !== undefined ? { author: flags["author"] as string } : {}),
      ...(flags["since"] !== undefined ? { since: flags["since"] as string } : {}),
      ...(flags["until"] !== undefined ? { until: flags["until"] as string } : {}),
    };
    const repoFilter = flags["repo"] as string | undefined;
    const repos = listGitRepos(vault).filter(
      (entry) => repoFilter === undefined || entry.key === repoFilter,
    );
    const matches: Array<{ repoKey: string; commit: GitCommitRecord }> = [];
    for (const entry of repos) {
      for (const commit of listGitCommits(vault, entry.key, filter)) {
        matches.push({ repoKey: entry.key, commit });
      }
    }
    matches.sort(
      (a, b) =>
        Date.parse(b.commit.committedAt) - Date.parse(a.commit.committedAt) ||
        a.commit.sha.localeCompare(b.commit.sha),
    );
    const limited = matches.slice(0, limit);
    if (flags["json"] === true) {
      okJson({
        ok: true,
        total: matches.length,
        commits: limited.map((m) => ({
          repo_key: m.repoKey,
          sha: m.commit.sha,
          committed_at: m.commit.committedAt,
          author: m.commit.authorName,
          subject: m.commit.subject,
          release: m.commit.release,
          files: m.commit.files,
        })),
      });
      return 0;
    }
    if (matches.length === 0) {
      ok("no matching commits");
      return 0;
    }
    for (const m of limited) {
      const release = m.commit.release === null ? "" : ` [${m.commit.release}]`;
      ok(
        `${m.commit.committedAt.slice(0, 10)} ${m.commit.sha.slice(0, 7)} ` +
          `(${m.repoKey}) ${m.commit.subject}${release}`,
      );
    }
    if (matches.length > limited.length) {
      ok(`... ${matches.length - limited.length} more (raise --limit)`);
    }
    return 0;
  } catch (err) {
    return fail((err as Error).message ?? String(err));
  }
}
