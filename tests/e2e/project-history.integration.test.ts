/**
 * End-to-end flow of the Project History Suite (epic t_41c34987):
 * one real repo + one vault, driven through ingest -> find -> mine ->
 * architect, then re-run everything and prove idempotency and operator
 * edit survival.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateArchDocs } from "../../src/core/brain/architect/generate.ts";
import { mineCommitDecisions } from "../../src/core/brain/git/decisions.ts";
import { ingestGitHistory } from "../../src/core/brain/git/ingest.ts";
import { gitStoreDir, listGitCommits } from "../../src/core/brain/git/store.ts";

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
  tmp = mkdtempSync(join(tmpdir(), "o2b-e2e-history-"));
  repo = join(tmp, "demo-service");
  mkdirSync(repo, { recursive: true });
  git("init", "-q", "-b", "main");
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("ingest -> find -> mine -> architect -> re-run: one coherent project memory", () => {
  // ── A project with structure, releases, and one decision commit ──
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "demo-service" }));
  commitFile("src/api/server.ts", "// api\n", "feat: bootstrap api server");
  commitFile("src/store/db.ts", "// db v1\n", "feat: sqlite-backed store");
  git("tag", "v1.0.0");
  commitFile(
    "src/store/db.ts",
    "// db v2\n",
    "feat!: migrate to jsonl store\n\nBREAKING CHANGE: sqlite file no longer read. " +
      "We decided to adopt JSONL instead of SQLite for portability.",
  );

  // ── Ingest ──
  const ingest = ingestGitHistory(vault, repo);
  expect(ingest.mode).toBe("initial");
  expect(ingest.newCommits).toBe(3);
  expect(ingest.newTags).toBe(1);

  // ── Find: why did db.ts change? Store-only, no live git. ──
  const dbHistory = listGitCommits(vault, ingest.repoKey, { file: "src/store/db.ts" });
  expect(dbHistory).toHaveLength(2);
  expect(dbHistory[0]!.release).toBe("v1.0.0");
  expect(dbHistory[1]!.release).toBeNull();
  expect(dbHistory[1]!.subject).toBe("feat!: migrate to jsonl store");

  // ── Mine: the breaking migration surfaces as an ADR candidate. ──
  const mined = mineCommitDecisions(vault, ingest.repoKey);
  expect(mined.created).toBe(1);
  const candidate = readFileSync(mined.notes[0]!, "utf8");
  expect(candidate).toContain("conventional_breaking");
  expect(candidate).toContain("breaking_change_footer");
  expect(candidate).toContain("migrate to jsonl store");

  // ── Architect: structural notes for the same project. ──
  const arch = generateArchDocs(vault, repo);
  expect(arch.repoKey).toBe(ingest.repoKey); // one repo-key namespace
  const overview = readFileSync(arch.overviewPath, "utf8");
  expect(overview).toContain("api");
  expect(overview).toContain("store");

  // ── Operator curates: edits the candidate and annotates the overview. ──
  writeFileSync(mined.notes[0]!, candidate + "\nOperator: accepted as ADR-1.\n");
  writeFileSync(arch.overviewPath, overview + "\nOperator: api owns all ingress.\n");

  // ── New work lands; everything re-runs. ──
  commitFile("src/api/routes.ts", "// routes\n", "feat: route table");
  const second = ingestGitHistory(vault, repo);
  expect(second.mode).toBe("incremental");
  expect(second.newCommits).toBe(1);
  expect(listGitCommits(vault, ingest.repoKey)).toHaveLength(4); // no duplicates

  const remined = mineCommitDecisions(vault, ingest.repoKey);
  expect(remined.created).toBe(0);
  expect(remined.skippedExisting).toBe(1);
  expect(readFileSync(mined.notes[0]!, "utf8")).toContain("Operator: accepted as ADR-1.");

  const rearch = generateArchDocs(vault, repo);
  const refreshed = readFileSync(rearch.overviewPath, "utf8");
  expect(refreshed).toContain("Operator: api owns all ingress.");

  // ── The digest reflects the full store after the second ingest. ──
  const digest = readFileSync(join(gitStoreDir(vault, ingest.repoKey), "digest.md"), "utf8");
  expect(digest).toContain("feat: route table");
  expect(digest).toContain("v1.0.0");

  // ── Idle re-runs are no-ops. ──
  const idle = ingestGitHistory(vault, repo);
  expect(idle.newCommits).toBe(0);
  const idleArch = generateArchDocs(vault, repo);
  expect(idleArch.created).toBe(0);
  expect(idleArch.updated).toBe(0);
});
