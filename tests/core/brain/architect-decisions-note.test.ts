/**
 * The architect key-decisions note
 * (salience-lifecycle-enrichment, unit 6 / t_041c571f).
 *
 * Claims pinned here:
 *  1. Every architect run plans a key-decisions note beside the overview,
 *     with its own frontmatter kind, and counts it in the run tally.
 *  2. The note lists the repo's ADR candidates - title, sha, and the
 *     matched signals - from `Brain/decisions/candidates/`.
 *  3. Candidates stamped with another `repo_key` are filtered out. The
 *     candidate store is vault-global; the note is repo-scoped.
 *  4. A repo with no candidates gets an explicit empty-state line, not a
 *     missing note and not an empty region.
 *  5. Entries are ordered codepoint-stably, so the note does not shuffle
 *     between runs or between hosts.
 *  6. A candidate whose frontmatter carries no sha is listed and says so.
 *     A malformed draft is reported, never silently dropped.
 *  7. Unchanged project AND unchanged vault regenerate byte-identically;
 *     a new candidate moves the decisions note and nothing else. That is
 *     the declared byte-identity exception, scoped.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { generateArchDocs } from "../../../src/core/brain/architect/generate.ts";

let tmp: string;
let project: string;
let vault: string;
let candidates: string;

function seed(relPath: string, content = "// x\n"): void {
  const abs = join(project, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

interface CandidateSeed {
  readonly file: string;
  readonly repoKey: string;
  readonly sha?: string;
  readonly signals?: ReadonlyArray<string>;
  readonly title: string;
}

function seedCandidate(seedInput: CandidateSeed): void {
  mkdirSync(candidates, { recursive: true });
  const lines = [
    "---",
    "kind: adr-candidate",
    "status: candidate",
    `repo_key: ${seedInput.repoKey}`,
    ...(seedInput.sha === undefined ? [] : [`sha: ${seedInput.sha}`]),
    `signals: [${(seedInput.signals ?? ["conventional_breaking"]).join(", ")}]`,
    "---",
    "",
    `# ADR candidate: ${seedInput.title}`,
    "",
    "## Decision",
    "",
    "Draft pending operator review.",
    "",
  ];
  writeFileSync(join(candidates, seedInput.file), lines.join("\n"));
}

/** The body of one sentinel region, without its sentinel lines. */
function regionBody(text: string, id: string): string {
  const begin = `<!-- o2b:begin ${id} -->\n`;
  const end = `\n<!-- o2b:end ${id} -->`;
  const from = text.indexOf(begin);
  expect(from).toBeGreaterThanOrEqual(0);
  const to = text.indexOf(end, from);
  expect(to).toBeGreaterThan(from);
  return text.slice(from + begin.length, to);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-architect-decisions-"));
  project = join(tmp, "demo-app");
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "demo-app" }));
  seed("src/core/engine.ts");
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  candidates = join(vault, "Brain", "decisions", "candidates");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("a run plans a key-decisions note beside the overview", () => {
  const res = generateArchDocs(vault, project);

  expect(res.decisionsPath).toBe(join(res.dir, "decisions.md"));
  const note = readFileSync(res.decisionsPath, "utf8");
  expect(note).toContain("kind: arch-decisions");
  expect(note).toContain(`repo_key: ${res.repoKey}`);
  expect(note).toContain("<!-- o2b:begin decisions -->");
  // Overview + decisions + one module.
  expect(res.created).toBe(3);
});

test("a repo with no candidates gets an explicit empty-state line", () => {
  const res = generateArchDocs(vault, project);
  const body = regionBody(readFileSync(res.decisionsPath, "utf8"), "decisions");

  expect(body).toContain("No decision candidates recorded for this repository.");
});

test("candidates for this repo are listed with title, sha and signals", () => {
  const key = generateArchDocs(vault, project).repoKey;
  seedCandidate({
    file: "adr-abc123def456-migrate-to-jsonl-store.md",
    repoKey: key,
    sha: "abc123def456789",
    signals: ["conventional_breaking", "breaking_change_footer"],
    title: "migrate to jsonl store",
  });

  const res = generateArchDocs(vault, project);
  const body = regionBody(readFileSync(res.decisionsPath, "utf8"), "decisions");

  expect(body).toContain("ADR candidate: migrate to jsonl store");
  expect(body).toContain("abc123def456789");
  expect(body).toContain("conventional_breaking, breaking_change_footer");
  expect(body).toContain("Brain/decisions/candidates/adr-abc123def456-migrate-to-jsonl-store");
  expect(body).not.toContain("No decision candidates recorded");
});

test("a candidate stamped with another repo_key is not listed", () => {
  const key = generateArchDocs(vault, project).repoKey;
  seedCandidate({
    file: "adr-000000000001-ours.md",
    repoKey: key,
    sha: "000000000001",
    title: "ours",
  });
  seedCandidate({
    file: "adr-000000000002-theirs.md",
    repoKey: "some-other-repo-deadbeef",
    sha: "000000000002",
    title: "theirs",
  });

  const res = generateArchDocs(vault, project);
  const body = regionBody(readFileSync(res.decisionsPath, "utf8"), "decisions");

  expect(body).toContain("ours");
  expect(body).not.toContain("theirs");
});

test("entries are ordered codepoint-stably", () => {
  const key = generateArchDocs(vault, project).repoKey;
  for (const [file, title] of [
    ["adr-000000000003-charlie.md", "charlie"],
    ["adr-000000000001-alpha.md", "alpha"],
    ["adr-000000000002-Bravo.md", "Bravo"],
  ] as const) {
    seedCandidate({ file, repoKey: key, sha: file.slice(4, 16), title });
  }

  const res = generateArchDocs(vault, project);
  const body = regionBody(readFileSync(res.decisionsPath, "utf8"), "decisions");
  const order = body
    .split("\n")
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(line.lastIndexOf("|") + 1, line.indexOf("]]")));

  expect(order).toEqual(["ADR candidate: alpha", "ADR candidate: Bravo", "ADR candidate: charlie"]);
});

test("a candidate with no recorded sha is listed and says so", () => {
  const key = generateArchDocs(vault, project).repoKey;
  seedCandidate({ file: "adr-nosha-orphan.md", repoKey: key, title: "orphan draft" });

  const res = generateArchDocs(vault, project);
  const body = regionBody(readFileSync(res.decisionsPath, "utf8"), "decisions");

  expect(body).toContain("orphan draft");
  expect(body).toContain("sha unrecorded");
});

test("an unchanged project and an unchanged vault regenerate byte-identically", () => {
  const key = generateArchDocs(vault, project).repoKey;
  seedCandidate({
    file: "adr-000000000001-first.md",
    repoKey: key,
    sha: "000000000001",
    title: "first",
  });

  const first = generateArchDocs(vault, project);
  const overviewBefore = readFileSync(first.overviewPath, "utf8");
  const decisionsBefore = readFileSync(first.decisionsPath, "utf8");

  const second = generateArchDocs(vault, project);
  expect(second.created).toBe(0);
  expect(second.updated).toBe(0);
  expect(readFileSync(second.overviewPath, "utf8")).toBe(overviewBefore);
  expect(readFileSync(second.decisionsPath, "utf8")).toBe(decisionsBefore);

  // The declared exception, scoped: a new candidate is a vault change, so
  // the decisions note moves and every other note stands still.
  seedCandidate({
    file: "adr-000000000002-second.md",
    repoKey: key,
    sha: "000000000002",
    title: "second",
  });
  const third = generateArchDocs(vault, project);
  expect(third.updated).toBe(1);
  expect(readFileSync(third.overviewPath, "utf8")).toBe(overviewBefore);
  expect(readFileSync(third.decisionsPath, "utf8")).not.toBe(decisionsBefore);
});

test("operator prose in the decisions note survives regeneration", () => {
  const first = generateArchDocs(vault, project);
  const prose = "\nOperator: ADR-1 supersedes the second entry.\n";
  writeFileSync(first.decisionsPath, readFileSync(first.decisionsPath, "utf8") + prose);

  seedCandidate({
    file: "adr-000000000001-first.md",
    repoKey: first.repoKey,
    sha: "000000000001",
    title: "first",
  });
  const second = generateArchDocs(vault, project);
  const after = readFileSync(second.decisionsPath, "utf8");

  expect(after).toContain("Operator: ADR-1 supersedes the second entry.");
  expect(after).toContain("first");
});
