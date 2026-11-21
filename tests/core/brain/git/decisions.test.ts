/**
 * Commit-decision miner: decision-shaped commits become ADR candidate
 * notes (Project History Suite, t_93d299bb).
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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

test("detectDecisionSignals matches only structural commit-protocol shapes", () => {
  expect(detectDecisionSignals("feat!: drop legacy index format", "")).toContain(
    "conventional_breaking",
  );
  expect(detectDecisionSignals("feat(core)!: switch storage", "")).toContain(
    "conventional_breaking",
  );
  expect(detectDecisionSignals("feat: new api", "BREAKING CHANGE: payload renamed")).toContain(
    "breaking_change_footer",
  );
  expect(detectDecisionSignals('Revert "feat: bad idea"', "")).toContain("revert");
  // Plain work is NOT decision-shaped.
  expect(detectDecisionSignals("fix: off-by-one in pager", "small fix")).toEqual([]);
  // Language-agnostic by construction: prose words ("decided", "adopt",
  // "migrate to") are NOT decision signals - they only ever fired on
  // English commit histories. Only structural protocol markers count.
  expect(detectDecisionSignals("chore: migrate to bun test runner", "")).toEqual([]);
  expect(
    detectDecisionSignals("docs: explain choice", "We decided to adopt JSONL instead of SQLite."),
  ).toEqual([]);
});

// ── mining ──────────────────────────────────────────────────────────────────

test("mineCommitDecisions writes candidates for decision commits only, with provenance", () => {
  appendGitRecords(vault, KEY, [
    commit("a".repeat(40), "feat!: drop legacy index format", "BREAKING CHANGE: rebuild needed"),
    commit("b".repeat(40), "fix: typo"),
    commit("c".repeat(40), 'Revert "feat: half-baked migration"'),
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

test("a non-Latin subject keeps its words in the candidate path", () => {
  // The Latin-only slug dropped every non-Latin letter: a Cyrillic subject
  // kept only its Latin words, a CJK one became `decision`.
  appendGitRecords(vault, KEY, [
    commit("e".repeat(40), "feat!: Перейти на Postgres"),
    commit("f".repeat(40), "feat!: 切换到新的存储格式"),
  ]);
  const res = mineCommitDecisions(vault, KEY);
  expect(res.notes.map((n) => n.slice(n.lastIndexOf("adr-")))).toEqual([
    `adr-${"e".repeat(12)}-feat-перейти-на-postgres.md`,
    `adr-${"f".repeat(12)}-feat-切换到新的存储格式.md`,
  ]);
});

test("a candidate stored under its old Latin-only slug is matched by its sha prefix", () => {
  // An older release wrote these candidates under the Latin-only slug. The
  // sha prefix is the identity, so a re-run must find them and never write
  // a second candidate for the same commit under the new slug.
  const dir = join(vault, "Brain", "decisions", "candidates");
  mkdirSync(dir, { recursive: true });
  const ru = join(dir, `adr-${"e".repeat(12)}-feat-postgres.md`);
  const cjk = join(dir, `adr-${"f".repeat(12)}-feat.md`);
  writeFileSync(ru, "curated\n", "utf8");
  writeFileSync(cjk, "curated\n", "utf8");
  appendGitRecords(vault, KEY, [
    commit("e".repeat(40), "feat!: Перейти на Postgres"),
    commit("f".repeat(40), "feat!: 切换到新的存储格式"),
  ]);
  const res = mineCommitDecisions(vault, KEY);
  expect(res.created).toBe(0);
  expect(res.skippedExisting).toBe(2);
  expect(res.notes).toEqual([ru, cjk]);
  expect(readdirSync(dir).toSorted()).toEqual(
    [`adr-${"e".repeat(12)}-feat-postgres.md`, `adr-${"f".repeat(12)}-feat.md`].toSorted(),
  );
});

test("an ASCII subject keeps its old candidate name, fallback-shaped and device names included", () => {
  appendGitRecords(vault, KEY, [
    commit("1".repeat(40), "unnamed-deadbeef", "BREAKING CHANGE: the index moved"),
    commit("2".repeat(40), "feat!: CON"),
    commit("3".repeat(40), "feat!: ---"),
  ]);
  const res = mineCommitDecisions(vault, KEY);
  expect(res.notes.map((n) => n.slice(n.lastIndexOf("adr-")))).toEqual([
    `adr-${"1".repeat(12)}-unnamed-deadbeef.md`,
    `adr-${"2".repeat(12)}-feat-con.md`,
    `adr-${"3".repeat(12)}-feat.md`,
  ]);
});

test("an ASCII subject's candidate is found by its name, not by a sha listing", () => {
  // The name is the one every release gave it, so the run checks that name
  // alone: another file sharing the sha prefix is not consulted.
  const dir = join(vault, "Brain", "decisions", "candidates");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `adr-${"4".repeat(12)}-a-hand-made-note.md`), "hand\n", "utf8");
  appendGitRecords(vault, KEY, [commit("4".repeat(40), "feat!: change storage")]);
  const res = mineCommitDecisions(vault, KEY);
  expect(res.notes.map((n) => n.slice(n.lastIndexOf("adr-")))).toEqual([
    `adr-${"4".repeat(12)}-feat-change-storage.md`,
  ]);
});

test("a long subject is cut between characters, never inside one", () => {
  // "क्षि" is one character of four code units; a cut by code point at the
  // 40-unit limit would leave its base letter without its marks.
  const subject = `feat!: ${"क्षि".repeat(12)}`;
  appendGitRecords(vault, KEY, [commit("5".repeat(40), subject)]);
  const name = mineCommitDecisions(vault, KEY).notes[0]!;
  const slug = name.slice(name.lastIndexOf("adr-") + 4 + 13, -".md".length);
  expect(slug).toBe(`feat-${"क्षि".repeat(8)}`);
  expect(slug.length).toBeLessThanOrEqual(40);
});
