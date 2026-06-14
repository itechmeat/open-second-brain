import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { decomposeNoteHistory } from "../../src/core/brain/note-history.ts";

let tmp: string;
let repo: string;

function git(env: Record<string, string>, ...args: string[]): string {
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
      ...args,
    ],
    { encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", ...env } },
  ).trim();
}

function commitFileAt(relPath: string, content: string, message: string, isoDate: string): void {
  const abs = join(repo, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
  git({}, "add", "--", relPath);
  git({ GIT_AUTHOR_DATE: isoDate, GIT_COMMITTER_DATE: isoDate }, "commit", "-q", "-m", message);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-note-history-"));
  repo = join(tmp, "repo");
  mkdirSync(repo, { recursive: true });
  git({}, "init", "-q", "-b", "main");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("decomposeNoteHistory", () => {
  test("splits a commit chain into phases on a time gap above the threshold", () => {
    // Phase 1: two commits a day apart. Then a 10-day gap. Phase 2: one commit.
    commitFileAt("notes/topic.md", "v1", "start topic", "2026-05-01T10:00:00Z");
    commitFileAt("notes/topic.md", "v2", "refine topic", "2026-05-02T10:00:00Z");
    commitFileAt("notes/topic.md", "v3", "revisit topic", "2026-05-12T10:00:00Z");

    const result = decomposeNoteHistory(repo, "notes/topic.md", {
      repoPath: repo,
      gapHours: 72,
    });
    expect(result.available).toBe(true);
    expect(result.commitCount).toBe(3);
    expect(result.phases.length).toBe(2);
    expect(result.phases[0]!.commitCount).toBe(2);
    expect(result.phases[0]!.subjects).toEqual(["start topic", "refine topic"]);
    expect(result.phases[1]!.commitCount).toBe(1);
    expect(result.phases[1]!.subjects).toEqual(["revisit topic"]);
  });

  test("keeps closely-spaced commits in a single phase", () => {
    commitFileAt("notes/topic.md", "v1", "a", "2026-05-01T10:00:00Z");
    commitFileAt("notes/topic.md", "v2", "b", "2026-05-01T12:00:00Z");
    commitFileAt("notes/topic.md", "v3", "c", "2026-05-01T15:00:00Z");

    const result = decomposeNoteHistory(repo, "notes/topic.md", { repoPath: repo, gapHours: 72 });
    expect(result.phases.length).toBe(1);
    expect(result.phases[0]!.commitCount).toBe(3);
  });

  test("only counts commits that touched the note path", () => {
    commitFileAt("notes/topic.md", "v1", "topic", "2026-05-01T10:00:00Z");
    commitFileAt("other/unrelated.md", "x", "unrelated", "2026-05-01T11:00:00Z");

    const result = decomposeNoteHistory(repo, "notes/topic.md", { repoPath: repo });
    expect(result.commitCount).toBe(1);
    expect(result.phases.length).toBe(1);
  });

  test("a path with no commits is available with zero phases (empty != broken)", () => {
    commitFileAt("notes/topic.md", "v1", "topic", "2026-05-01T10:00:00Z");
    const result = decomposeNoteHistory(repo, "notes/never-existed.md", { repoPath: repo });
    expect(result.available).toBe(true);
    expect(result.commitCount).toBe(0);
    expect(result.phases.length).toBe(0);
    expect(result.reason).toBeDefined();
  });

  test("a non-repository directory reports no history available, not an empty success", () => {
    const notRepo = mkdtempSync(join(tmpdir(), "o2b-not-a-repo-"));
    try {
      const result = decomposeNoteHistory(notRepo, "notes/topic.md", { repoPath: notRepo });
      expect(result.available).toBe(false);
      expect(result.phases.length).toBe(0);
      expect(result.reason).toContain("no history available");
    } finally {
      rmSync(notRepo, { recursive: true, force: true });
    }
  });

  test("phase splitting is independent of commit-message language", () => {
    // Same dates and structure, non-Latin subjects: the split is identical.
    commitFileAt("notes/topic.md", "v1", "начало темы", "2026-05-01T10:00:00Z");
    commitFileAt("notes/topic.md", "v2", "主题更新", "2026-05-12T10:00:00Z");
    const result = decomposeNoteHistory(repo, "notes/topic.md", { repoPath: repo, gapHours: 72 });
    expect(result.phases.length).toBe(2);
  });
});
