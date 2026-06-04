/**
 * Per-repo git record store with watermark
 * (Project History Suite, t_c812752c).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  appendGitRecords,
  gitStoreDir,
  listGitCommits,
  listGitRepos,
  listGitTags,
  readGitState,
  writeGitState,
} from "../../../../src/core/brain/git/store.ts";
import type { GitCommitRecord, GitTagRecord } from "../../../../src/core/brain/git/store.ts";

let tmp: string;
let vault: string;

const KEY = "fixture-repo-abcd1234";

function commit(sha: string, over: Partial<GitCommitRecord> = {}): GitCommitRecord {
  return {
    kind: "commit",
    sha,
    authorName: "Fixture Author",
    authorEmail: "fixture@example.com",
    committedAt: "2026-06-01T10:00:00+00:00",
    subject: "feat: default subject",
    body: "",
    files: ["src/a.ts"],
    release: null,
    ...over,
  };
}

function tag(name: string, targetSha: string): GitTagRecord {
  return { kind: "tag", name, targetSha, createdAt: "2026-06-02T10:00:00+00:00" };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-git-store-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("gitStoreDir nests under Brain/projects/git/<repo-key>", () => {
  expect(gitStoreDir(vault, KEY)).toBe(join(vault, "Brain", "projects", "git", KEY));
});

test("append + list round-trips commits and tags, oldest-first", () => {
  const a = commit("a".repeat(40), { subject: "feat: first" });
  const b = commit("b".repeat(40), { subject: "fix: second", files: ["src/b.ts", "docs/x.md"] });
  const res = appendGitRecords(vault, KEY, [a, tag("v1.0.0", "b".repeat(40)), b]);
  expect(res.appended).toBe(3);
  expect(res.skipped).toBe(0);
  const commits = listGitCommits(vault, KEY);
  expect(commits.map((c) => c.subject)).toEqual(["feat: first", "fix: second"]);
  expect(commits[1]!.files).toEqual(["src/b.ts", "docs/x.md"]);
  const tags = listGitTags(vault, KEY);
  expect(tags).toHaveLength(1);
  expect(tags[0]!.name).toBe("v1.0.0");
});

test("append dedups commits by sha and tags by name across calls", () => {
  appendGitRecords(vault, KEY, [commit("a".repeat(40)), tag("v1.0.0", "a".repeat(40))]);
  const res = appendGitRecords(vault, KEY, [
    commit("a".repeat(40), { subject: "changed subject must not re-append" }),
    tag("v1.0.0", "a".repeat(40)),
    commit("c".repeat(40)),
  ]);
  expect(res.appended).toBe(1);
  expect(res.skipped).toBe(2);
  const commits = listGitCommits(vault, KEY);
  expect(commits).toHaveLength(2);
  expect(commits[0]!.subject).toBe("feat: default subject");
});

test("listGitCommits filters by file, author, text, time range, and limit keeps newest", () => {
  appendGitRecords(vault, KEY, [
    commit("a".repeat(40), {
      subject: "feat: alpha",
      files: ["src/a.ts"],
      committedAt: "2026-06-01T10:00:00+00:00",
    }),
    commit("b".repeat(40), {
      subject: "fix: beta touches a",
      files: ["src/a.ts", "src/b.ts"],
      committedAt: "2026-06-02T10:00:00+00:00",
      authorName: "Other Author",
    }),
    commit("c".repeat(40), {
      subject: "docs: gamma",
      body: "explains the alpha decision",
      files: ["docs/g.md"],
      committedAt: "2026-06-03T10:00:00+00:00",
    }),
  ]);
  expect(listGitCommits(vault, KEY, { file: "src/a.ts" })).toHaveLength(2);
  expect(listGitCommits(vault, KEY, { author: "other" })).toHaveLength(1);
  // text matches subject AND body, case-insensitive
  expect(listGitCommits(vault, KEY, { text: "ALPHA" }).map((c) => c.subject)).toEqual([
    "feat: alpha",
    "docs: gamma",
  ]);
  expect(listGitCommits(vault, KEY, { since: "2026-06-02T00:00:00Z" })).toHaveLength(2);
  expect(listGitCommits(vault, KEY, { until: "2026-06-01T23:59:59Z" })).toHaveLength(1);
  const limited = listGitCommits(vault, KEY, { limit: 2 });
  expect(limited.map((c) => c.subject)).toEqual(["fix: beta touches a", "docs: gamma"]);
});

test("malformed JSONL lines are skipped, not fatal", () => {
  appendGitRecords(vault, KEY, [commit("a".repeat(40))]);
  const path = join(gitStoreDir(vault, KEY), "commits.jsonl");
  writeFileSync(path, `${readFileSync(path, "utf8")}not json\n{"kind":"junk"}\n`);
  appendGitRecords(vault, KEY, [commit("b".repeat(40))]);
  expect(listGitCommits(vault, KEY)).toHaveLength(2);
});

test("git state round-trips and validates the watermark sha", () => {
  expect(readGitState(vault, KEY)).toEqual({ state: null, error: null });
  writeGitState(vault, KEY, {
    repoPath: "/work/fixture-repo",
    lastSha: "d".repeat(40),
    lastIngestedAt: "2026-06-04T08:00:00Z",
  });
  const probe = readGitState(vault, KEY);
  expect(probe.error).toBeNull();
  expect(probe.state!.lastSha).toBe("d".repeat(40));
  expect(probe.state!.repoPath).toBe("/work/fixture-repo");
  expect(() =>
    writeGitState(vault, KEY, {
      repoPath: "/work/fixture-repo",
      lastSha: "HEAD",
      lastIngestedAt: "2026-06-04T08:00:00Z",
    }),
  ).toThrow(/full 40-hex/);
});

test("a corrupted state file reads as an error probe, never throws", () => {
  mkdirSync(gitStoreDir(vault, KEY), { recursive: true });
  writeFileSync(join(gitStoreDir(vault, KEY), "state.json"), "{broken");
  const probe = readGitState(vault, KEY);
  expect(probe.state).toBeNull();
  expect(probe.error).toMatch(/not valid JSON/);
  // Tampered watermark sha is rejected on read too.
  writeFileSync(
    join(gitStoreDir(vault, KEY), "state.json"),
    JSON.stringify({ repo_path: "/x", last_sha: "HEAD~1; evil", last_ingested_at: "t" }),
  );
  expect(readGitState(vault, KEY).error).toMatch(/full 40-hex/);
});

test("listGitRepos enumerates per-repo stores with their states", () => {
  expect(listGitRepos(vault)).toEqual([]);
  appendGitRecords(vault, KEY, [commit("a".repeat(40))]);
  writeGitState(vault, "other-repo-00000000", {
    repoPath: "/work/other",
    lastSha: "e".repeat(40),
    lastIngestedAt: "2026-06-04T08:00:00Z",
  });
  const repos = listGitRepos(vault);
  expect(repos.map((r) => r.key)).toEqual([KEY, "other-repo-00000000"]);
  expect(repos[0]!.state).toBeNull();
  expect(repos[1]!.state!.repoPath).toBe("/work/other");
  expect(existsSync(join(vault, "Brain", "projects", "git", KEY, "commits.jsonl"))).toBe(true);
});
