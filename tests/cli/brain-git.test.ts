/**
 * `o2b brain git <ingest|status|find|mine>` CLI surface
 * (Project History Suite, t_c812752c + t_93d299bb).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../helpers/run-cli.ts";

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
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-git-"));
  repo = join(tmp, "fixture-repo");
  mkdirSync(repo, { recursive: true });
  git("init", "-q", "-b", "main");
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("ingest + status + find round-trip over a real repo", async () => {
  commitFile("src/a.ts", "1", "feat: add alpha module");
  git("tag", "v1.0.0");
  commitFile("src/b.ts", "2", "fix: beta hotfix");

  const ingest = await runCli(["brain", "git", "ingest", repo, "--vault", vault, "--json"]);
  expect(ingest.returncode).toBe(0);
  const ingested = JSON.parse(ingest.stdout) as {
    ok: boolean;
    repo_key: string;
    mode: string;
    new_commits: number;
    new_tags: number;
    digest_path: string;
  };
  expect(ingested.ok).toBe(true);
  expect(ingested.mode).toBe("initial");
  expect(ingested.new_commits).toBe(2);
  expect(ingested.new_tags).toBe(1);
  expect(existsSync(ingested.digest_path)).toBe(true);

  const status = await runCli(["brain", "git", "status", "--vault", vault, "--json"]);
  expect(status.returncode).toBe(0);
  const parsed = JSON.parse(status.stdout) as {
    repos: Array<{ key: string; commits: number; tags: number; last_sha: string | null }>;
  };
  expect(parsed.repos).toHaveLength(1);
  expect(parsed.repos[0]!.key).toBe(ingested.repo_key);
  expect(parsed.repos[0]!.commits).toBe(2);

  const find = await runCli(["brain", "git", "find", "alpha", "--vault", vault, "--json"]);
  expect(find.returncode).toBe(0);
  const found = JSON.parse(find.stdout) as {
    total: number;
    commits: Array<{ sha: string; subject: string; release: string | null; repo_key: string }>;
  };
  expect(found.total).toBe(1);
  expect(found.commits[0]!.subject).toBe("feat: add alpha module");
  expect(found.commits[0]!.release).toBe("v1.0.0");

  const byFile = await runCli([
    "brain",
    "git",
    "find",
    "--file",
    "src/b.ts",
    "--vault",
    vault,
    "--json",
  ]);
  const fileHits = JSON.parse(byFile.stdout) as {
    total: number;
    commits: Array<{ subject: string }>;
  };
  expect(fileHits.total).toBe(1);
  expect(fileHits.commits[0]!.subject).toBe("fix: beta hotfix");
});

test("find requires some filter and reports empty results cleanly", async () => {
  const bare = await runCli(["brain", "git", "find", "--vault", vault, "--json"]);
  expect(bare.returncode).toBe(1);
  expect(bare.stderr).toContain("requires a query");

  commitFile("a.txt", "1", "one");
  await runCli(["brain", "git", "ingest", repo, "--vault", vault]);
  const miss = await runCli([
    "brain",
    "git",
    "find",
    "nothing-matches",
    "--vault",
    vault,
    "--json",
  ]);
  expect(miss.returncode).toBe(0);
  expect((JSON.parse(miss.stdout) as { total: number }).total).toBe(0);
});

test("ingest of a non-repo fails with exit 1 and a clear message", async () => {
  const plain = join(tmp, "plain");
  mkdirSync(plain);
  const res = await runCli(["brain", "git", "ingest", plain, "--vault", vault]);
  expect(res.returncode).toBe(1);
  expect(res.stderr).toContain("not a git repository");
});

test("usage line on unknown subcommand", async () => {
  const res = await runCli(["brain", "git", "frobnicate", "--vault", vault]);
  expect(res.returncode).toBe(1);
  expect(res.stderr).toContain("usage: o2b brain git");
});
