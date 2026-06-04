/**
 * Commit-decision miner: decision-shaped commits become ADR candidate
 * notes (Project History Suite, t_93d299bb).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  detectDecisionSignals,
  mineCommitDecisions,
} from "../../../../src/core/brain/git/decisions.ts";
import { appendGitRecords } from "../../../../src/core/brain/git/store.ts";
import type { GitCommitRecord } from "../../../../src/core/brain/git/store.ts";

let tmp: string;
let vault: string;

const KEY = "fixture-repo-abcd1234";

function commit(sha: string, subject: string, body = ""): GitCommitRecord {
  return {
    kind: "commit",
    sha,
    authorName: "Fixture Author",
    authorEmail: "fixture@example.com",
    committedAt: "2026-06-01T10:00:00+00:00",
    subject,
    body,
    files: ["src/a.ts"],
    release: null,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-git-decisions-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// ── signal detection ────────────────────────────────────────────────────────

test("detectDecisionSignals matches deterministic decision shapes", () => {
  expect(detectDecisionSignals("feat!: drop legacy index format", "")).toContain(
    "conventional_breaking",
  );
  expect(detectDecisionSignals("feat(core)!: switch storage", "")).toContain(
    "conventional_breaking",
  );
  expect(detectDecisionSignals("feat: new api", "BREAKING CHANGE: payload renamed")).toContain(
    "breaking_change_footer",
  );
  expect(detectDecisionSignals("chore: migrate to bun test runner", "")).toContain(
    "decision_keyword:migrate to",
  );
  expect(
    detectDecisionSignals("docs: explain choice", "We decided to adopt JSONL instead of SQLite."),
  ).toEqual(expect.arrayContaining(["decision_keyword:decided", "decision_keyword:adopt"]));
  expect(detectDecisionSignals('Revert "feat: bad idea"', "")).toContain("revert");
  // Plain work is NOT decision-shaped.
  expect(detectDecisionSignals("fix: off-by-one in pager", "small fix")).toEqual([]);
  // Substrings inside words do not match (no false 'adopt' in 'adoption-rate.ts').
  expect(detectDecisionSignals("chore: update adoption-rate metrics", "")).toEqual([]);
});

// ── mining ──────────────────────────────────────────────────────────────────

test("mineCommitDecisions writes candidates for decision commits only, with provenance", () => {
  appendGitRecords(vault, KEY, [
    commit("a".repeat(40), "feat!: drop legacy index format", "BREAKING CHANGE: rebuild needed"),
    commit("b".repeat(40), "fix: typo"),
    commit("c".repeat(40), "chore: migrate to bun test runner"),
  ]);
  const res = mineCommitDecisions(vault, KEY);
  expect(res.scanned).toBe(3);
  expect(res.created).toBe(2);
  expect(res.skippedExisting).toBe(0);
  expect(res.notes).toHaveLength(2);

  const first = res.notes.find((n) => n.includes("aaaaaaa"))!;
  expect(existsSync(first)).toBe(true);
  const content = readFileSync(first, "utf8");
  expect(content).toContain("kind: adr-candidate");
  expect(content).toContain("status: candidate");
  expect(content).toContain(`sha: ${"a".repeat(40)}`);
  expect(content).toContain("conventional_breaking");
  expect(content).toContain("feat!: drop legacy index format");
  expect(content).toContain(`repo_key: ${KEY}`);
});

test("re-runs never duplicate and never clobber operator-edited candidates", () => {
  appendGitRecords(vault, KEY, [commit("a".repeat(40), "feat!: drop legacy index format")]);
  const first = mineCommitDecisions(vault, KEY);
  expect(first.created).toBe(1);
  const note = first.notes[0]!;
  writeFileSync(note, readFileSync(note, "utf8") + "\nOperator: accepted, see ADR-7.\n");

  const second = mineCommitDecisions(vault, KEY);
  expect(second.created).toBe(0);
  expect(second.skippedExisting).toBe(1);
  expect(readFileSync(note, "utf8")).toContain("Operator: accepted, see ADR-7.");
});

test("empty history is a clean no-op", () => {
  const res = mineCommitDecisions(vault, KEY);
  expect(res.scanned).toBe(0);
  expect(res.created).toBe(0);
  expect(res.notes).toEqual([]);
});

test("candidate paths are stable, 12-hex-prefixed, and slugged from the subject", () => {
  appendGitRecords(vault, KEY, [
    commit("d".repeat(40), "feat!: Switch to Postgres (was: SQLite)!!"),
  ]);
  const res = mineCommitDecisions(vault, KEY);
  expect(res.notes[0]).toContain(join("Brain", "decisions", "candidates"));
  // 12 hex chars of sha (git's large-repo abbreviation length), then slug.
  expect(res.notes[0]).toMatch(/adr-d{12}-feat-switch-to-postgres[a-z-]*\.md$/);
});
