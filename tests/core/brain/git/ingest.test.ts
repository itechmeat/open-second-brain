/**
 * Git history ingest orchestration: full + incremental runs, release
 * attribution, watermark advance, digest rendering
 * (Project History Suite, t_c812752c).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoKey } from "../../../../src/core/brain/git/identity.ts";
import { GitIngestError, ingestGitHistory } from "../../../../src/core/brain/git/ingest.ts";
import {
  gitStoreDir,
  listGitCommits,
  listGitTags,
  readGitState,
  writeGitState,
} from "../../../../src/core/brain/git/store.ts";

let tmp: string;
let repo: string;
let vault: string;

function git(...args: string[]): string {
  return execFileSync(
    "git",
    [
      "-C",
      repo,
      "-c",
      "user.name=Fixture Author",
      "-c",
      "user.email=fixture@example.com",
      "-c",
      "commit.gpgsign=false",
      "-c",
      "tag.gpgsign=false",
      ...args,
    ],
    { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" } },
  ).trim();
}

function commitFile(relPath: string, content: string, message: string): string {
  const abs = join(repo, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  git("add", "--", relPath);
  git("commit", "-q", "-m", message);
  return git("rev-parse", "HEAD");
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-git-ingest-"));
  repo = join(tmp, "fixture-repo");
  mkdirSync(repo, { recursive: true });
  git("init", "-q", "-b", "main");
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("initial ingest stores commits, tags, release edges, watermark, and digest", () => {
  commitFile("src/a.ts", "1", "feat: first");
  const second = commitFile("src/b.ts", "2", "fix: second");
  git("tag", "v1.0.0");
  const third = commitFile("src/a.ts", "3", "feat: post-release work");

  const res = ingestGitHistory(vault, repo);
  expect(res.mode).toBe("initial");
  expect(res.newCommits).toBe(3);
  expect(res.newTags).toBe(1);
  expect(res.warning).toBeNull();
  expect(res.repoKey).toBe(repoKey(repo));

  const key = res.repoKey;
  const commits = listGitCommits(vault, key);
  expect(commits).toHaveLength(3);
  // Release attribution: commits up to the tag carry v1.0.0, later ones null.
  expect(commits[0]!.release).toBe("v1.0.0");
  expect(commits[1]!.release).toBe("v1.0.0");
  expect(commits[2]!.release).toBeNull();
  expect(commits[1]!.sha).toBe(second);
  expect(listGitTags(vault, key)).toHaveLength(1);

  const state = readGitState(vault, key);
  expect(state.state!.lastSha).toBe(third);
  expect(state.state!.repoPath).toBe(repo);

  const digest = readFileSync(join(gitStoreDir(vault, key), "digest.md"), "utf8");
  expect(digest).toContain("kind: git-digest");
  expect(digest).toContain("v1.0.0");
  expect(digest).toContain("feat: post-release work");
  expect(digest).toContain("src/a.ts");
});

test("incremental ingest appends only new commits and advances the watermark", () => {
  commitFile("a.txt", "1", "one");
  const first = ingestGitHistory(vault, repo);
  expect(first.newCommits).toBe(1);

  const second = commitFile("b.txt", "2", "two");
  git("tag", "v0.2.0");
  const res = ingestGitHistory(vault, repo);
  expect(res.mode).toBe("incremental");
  expect(res.newCommits).toBe(1);
  expect(res.newTags).toBe(1);
  expect(readGitState(vault, res.repoKey).state!.lastSha).toBe(second);
  expect(listGitCommits(vault, res.repoKey)).toHaveLength(2);

  // No-change re-run: zero new records, watermark untouched, no duplicates.
  const idle = ingestGitHistory(vault, repo);
  expect(idle.mode).toBe("incremental");
  expect(idle.newCommits).toBe(0);
  expect(listGitCommits(vault, idle.repoKey)).toHaveLength(2);
});

test("a watermark that no longer resolves triggers a clean full re-scan", () => {
  commitFile("a.txt", "1", "one");
  ingestGitHistory(vault, repo);
  // Simulate force-push: watermark sha not in object store anymore.
  writeGitState(vault, repoKey(repo), {
    repoPath: repo,
    lastSha: "0".repeat(40),
    lastIngestedAt: "2026-06-04T00:00:00Z",
  });
  commitFile("b.txt", "2", "two");
  const res = ingestGitHistory(vault, repo);
  expect(res.mode).toBe("rescan");
  expect(res.warning).toMatch(/watermark/i);
  // Dedup keeps the store duplicate-free across the re-scan.
  expect(listGitCommits(vault, res.repoKey)).toHaveLength(2);
});

test("a malformed watermark file triggers a re-scan with the probe error surfaced", () => {
  commitFile("a.txt", "1", "one");
  ingestGitHistory(vault, repo);
  writeFileSync(join(gitStoreDir(vault, repoKey(repo)), "state.json"), "{broken");
  const res = ingestGitHistory(vault, repo);
  expect(res.mode).toBe("rescan");
  expect(res.warning).toMatch(/not valid JSON/);
  expect(listGitCommits(vault, res.repoKey)).toHaveLength(1);
});

test("maxCount bounds the initial walk and surfaces the truncation", () => {
  for (let i = 0; i < 5; i += 1) commitFile(`f${i}.txt`, String(i), `commit ${i}`);
  const res = ingestGitHistory(vault, repo, { maxCount: 2 });
  expect(res.newCommits).toBe(2);
  const commits = listGitCommits(vault, res.repoKey);
  expect(commits.map((c) => c.subject)).toEqual(["commit 3", "commit 4"]);
  // A bounded initial walk must SAY it skipped older history.
  expect(res.warning).toMatch(/older history not ingested/);
});

test("non-repo paths raise a domain error; empty repos ingest cleanly", () => {
  const plain = join(tmp, "plain");
  mkdirSync(plain);
  expect(() => ingestGitHistory(vault, plain)).toThrow(GitIngestError);
  const res = ingestGitHistory(vault, repo); // zero commits yet
  expect(res.newCommits).toBe(0);
  expect(res.watermark).toBeNull();
});

test("digest is deterministic: same store, same bytes", () => {
  commitFile("src/a.ts", "1", "feat: first");
  git("tag", "v1.0.0");
  ingestGitHistory(vault, repo);
  const path = join(gitStoreDir(vault, repoKey(repo)), "digest.md");
  const first = readFileSync(path, "utf8");
  ingestGitHistory(vault, repo);
  expect(readFileSync(path, "utf8")).toBe(first);
});
