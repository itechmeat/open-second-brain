/**
 * Git kernel: repo identity + sanitized read-only git reader
 * (Project History Suite, t_c812752c).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { repoKey } from "../../../../src/core/brain/git/identity.ts";
import {
  isFullSha,
  readCommits,
  readTags,
  revListRange,
  shaExists,
} from "../../../../src/core/brain/git/reader.ts";

let tmp: string;
let repo: string;

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
  tmp = mkdtempSync(join(tmpdir(), "o2b-git-reader-"));
  repo = join(tmp, "fixture-repo");
  mkdirSync(repo, { recursive: true });
  git("init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── identity ────────────────────────────────────────────────────────────────

test("repoKey is deterministic, human-prefixed, and path-scoped", () => {
  const a = repoKey(repo);
  expect(a).toBe(repoKey(repo));
  expect(a.startsWith("fixture-repo-")).toBe(true);
  expect(a).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/);
  const sibling = join(tmp, "fixture-repo-2");
  mkdirSync(sibling);
  expect(repoKey(sibling)).not.toBe(a);
});

test("repoKey sanitizes hostile basenames", () => {
  const weird = join(tmp, "My Repo (v2)!");
  mkdirSync(weird);
  const key = repoKey(weird);
  expect(key).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/);
  expect(key.startsWith("my-repo-v2-")).toBe(true);
});

// ── sha validation ──────────────────────────────────────────────────────────

test("isFullSha accepts exactly 40 lowercase hex chars", () => {
  expect(isFullSha("a".repeat(40))).toBe(true);
  expect(isFullSha("A".repeat(40))).toBe(false);
  expect(isFullSha("a".repeat(39))).toBe(false);
  expect(isFullSha("a".repeat(41))).toBe(false);
  expect(isFullSha("--max-count=1; rm -rf /")).toBe(false);
  expect(isFullSha(42)).toBe(false);
  expect(isFullSha(null)).toBe(false);
});

// ── readCommits ─────────────────────────────────────────────────────────────

test("readCommits returns structured commits oldest-first with touched files", () => {
  const first = commitFile("src/a.ts", "export const a = 1;\n", "feat: add a");
  const second = commitFile("src/b.ts", "export const b = 2;\n", "fix: add b\n\nlonger body here");
  const commits = readCommits(repo, {});
  expect(commits).not.toBeNull();
  expect(commits!).toHaveLength(2);
  expect(commits![0]!.sha).toBe(first);
  expect(commits![1]!.sha).toBe(second);
  expect(commits![0]!.subject).toBe("feat: add a");
  expect(commits![0]!.files).toEqual(["src/a.ts"]);
  expect(commits![1]!.body).toBe("longer body here");
  expect(commits![1]!.authorName).toBe("Fixture Author");
  expect(commits![1]!.authorEmail).toBe("fixture@example.com");
  expect(commits![1]!.committedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
});

test("readCommits survives adversarial commit messages", () => {
  commitFile("a.txt", "x", 'subject with "quotes" \\x01 and %x00 percent-codes');
  commitFile(
    "b.txt",
    "y",
    "multi\n\nbody with\nnewlines, NUL-words, __COMMIT__ sentinels and unicode ✓",
  );
  const commits = readCommits(repo, {});
  expect(commits).not.toBeNull();
  expect(commits!).toHaveLength(2);
  expect(commits![0]!.subject).toContain("quotes");
  expect(commits![1]!.body).toContain("__COMMIT__ sentinels and unicode ✓");
  expect(commits![1]!.files).toEqual(["b.txt"]);
});

test("readCommits honours maxCount and range", () => {
  const first = commitFile("a.txt", "1", "one");
  commitFile("b.txt", "2", "two");
  const third = commitFile("c.txt", "3", "three");
  const bounded = readCommits(repo, { maxCount: 2 });
  expect(bounded!).toHaveLength(2);
  // maxCount keeps the NEWEST commits (git log semantics), still oldest-first.
  expect(bounded![1]!.sha).toBe(third);
  const ranged = readCommits(repo, { sinceSha: first });
  expect(ranged!).toHaveLength(2);
  expect(ranged!.map((c) => c.subject)).toEqual(["two", "three"]);
});

test("readCommits rejects an invalid range sha instead of passing it to git", () => {
  commitFile("a.txt", "1", "one");
  expect(() => readCommits(repo, { sinceSha: "HEAD~1; touch /tmp/pwned" })).toThrow(
    /sinceSha must be a full 40-hex/,
  );
});

test("readCommits includes merge commits with empty file list", () => {
  commitFile("a.txt", "1", "base");
  git("checkout", "-q", "-b", "feature");
  commitFile("f.txt", "f", "feature work");
  git("checkout", "-q", "main");
  commitFile("m.txt", "m", "main work");
  git("merge", "--no-ff", "-q", "-m", "merge: feature into main", "feature");
  const commits = readCommits(repo, {});
  const merge = commits!.find((c) => c.subject.startsWith("merge:"));
  expect(merge).toBeDefined();
  expect(merge!.files).toEqual([]);
});

test("readCommits is fail-soft on non-repos and empty repos", () => {
  const notRepo = join(tmp, "plain-dir");
  mkdirSync(notRepo);
  expect(readCommits(notRepo, {})).toBeNull();
  expect(readCommits(join(tmp, "missing"), {})).toBeNull();
  // Freshly-initialised repo with zero commits: empty array, not null.
  expect(readCommits(repo, {})).toEqual([]);
});

// ── readTags / revListRange / shaExists ─────────────────────────────────────

test("readTags returns lightweight and annotated tags peeled to commit shas", () => {
  const first = commitFile("a.txt", "1", "one");
  git("tag", "v0.1.0");
  const second = commitFile("b.txt", "2", "two");
  git("tag", "-a", "v0.2.0", "-m", "release v0.2.0");
  const tags = readTags(repo);
  expect(tags).not.toBeNull();
  expect(tags!).toHaveLength(2);
  const byName = new Map(tags!.map((t) => [t.name, t]));
  expect(byName.get("v0.1.0")!.targetSha).toBe(first);
  expect(byName.get("v0.2.0")!.targetSha).toBe(second);
});

test("readTags is empty on tagless repos and null on non-repos", () => {
  commitFile("a.txt", "1", "one");
  expect(readTags(repo)).toEqual([]);
  expect(readTags(join(tmp, "missing"))).toBeNull();
});

test("revListRange lists shas between two points, oldest-first", () => {
  const first = commitFile("a.txt", "1", "one");
  const second = commitFile("b.txt", "2", "two");
  const third = commitFile("c.txt", "3", "three");
  expect(revListRange(repo, first, third)).toEqual([second, third]);
  expect(revListRange(repo, null, first)).toEqual([first]);
  expect(() => revListRange(repo, "junk", third)).toThrow(/full 40-hex/);
  expect(() => revListRange(repo, first, "junk")).toThrow(/full 40-hex/);
});

test("shaExists validates input and probes the object store", () => {
  const sha = commitFile("a.txt", "1", "one");
  expect(shaExists(repo, sha)).toBe(true);
  expect(shaExists(repo, "0".repeat(40))).toBe(false);
  expect(shaExists(repo, "not-a-sha")).toBe(false);
});
