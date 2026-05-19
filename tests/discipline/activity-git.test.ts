import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { gitActivity } from "../../src/core/discipline/activity-git.ts";

let repo: string;

beforeAll(() => {
  repo = mkdtempSync(join(tmpdir(), "o2b-disc-git-"));
  execSync("git init -q -b main", { cwd: repo });
  execSync("git config user.email t@t && git config user.name t", { cwd: repo });
  writeFileSync(join(repo, "a.txt"), "hello\n");
  execSync("git add a.txt && git commit -q -m c1 --date=2026-05-17T10:00:00Z",
    { cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: "2026-05-17T10:00:00Z" } });
  writeFileSync(join(repo, "a.txt"), "hello\nworld\n");
  execSync("git add a.txt && git commit -q -m c2 --date=2026-05-17T20:00:00Z",
    { cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: "2026-05-17T20:00:00Z" } });
  writeFileSync(join(repo, "b.txt"), "x\n");
  execSync("git add b.txt && git commit -q -m c3 --date=2026-05-18T10:00:00Z",
    { cwd: repo, env: { ...process.env, GIT_COMMITTER_DATE: "2026-05-18T10:00:00Z" } });
});
afterAll(() => rmSync(repo, { recursive: true, force: true }));

describe("gitActivity", () => {
  test("counts only commits inside the [start, end) UTC window", () => {
    const out = gitActivity(repo, {
      startUtc: new Date("2026-05-17T00:00:00Z"),
      endUtc: new Date("2026-05-18T00:00:00Z"),
    });
    expect(out?.commits).toBe(2);
    expect(out?.filesChanged).toBe(1);
    expect(out?.insertions).toBe(2); // 1 + 1
    expect(out?.deletions).toBe(0);
  });

  test("non-git path → null sentinel, no throw", () => {
    const empty = mkdtempSync(join(tmpdir(), "o2b-disc-nogit-"));
    const out = gitActivity(empty, {
      startUtc: new Date("2026-05-17T00:00:00Z"),
      endUtc: new Date("2026-05-18T00:00:00Z"),
    });
    expect(out).toBeNull();
    rmSync(empty, { recursive: true });
  });
});
