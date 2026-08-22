/**
 * Skill drafts from mature vault pages (salience-lifecycle-enrichment,
 * unit 4, t_abaec26b). Claims pinned here:
 *
 *  1. The maturity gate admits a page only when all three page-meta
 *     dimensions hold - core tier, non-stale lifecycle, high confidence -
 *     and each rejection is NAMED per page, never a silent absence.
 *  2. Observed reuse is the evidence floor: a page nothing has reused is
 *     skipped by name even with a perfect trio.
 *  3. An installed skill already covering a page skips it by name.
 *  4. Exactly one spine envelope is built per ADMITTED page, and none for
 *     a skipped one.
 *  5. A draft payload is refused structurally (blank fields) and
 *     semantically (a name that is not a valid skill directory name).
 *  6. A validated draft is staged as a PENDING proposal inside the vault
 *     under the new `mature_page` pattern kind, and nothing is written
 *     outside the vault before accept.
 *  7. Accept materializes a well-formed SKILL.md under the configured
 *     skills root through the WAL-protected accept path.
 *  8. Rejection is sticky: a rejected page does not resurface as a draft.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { appendContinuityRecord } from "../../../src/core/brain/continuity/store.ts";
import { writeSkillAcceptJournal } from "../../../src/core/brain/skill-accept-journal.ts";
import { NEEDS_LLM_STEP } from "../../../src/core/brain/llm-step.ts";
import { ResponseCheckError } from "../../../src/core/brain/response-checks.ts";
import { ResponseShapeError } from "../../../src/core/brain/response-shape.ts";
import {
  commitSkillPageDraft,
  MATURE_PAGE_REUSE_FLOOR,
  planSkillPageDrafts,
  SKILL_PAGE_SKIP_REASON,
} from "../../../src/core/brain/skill-page-drafts.ts";
import {
  acceptSkillProposal,
  listPendingSkillProposals,
  MATURE_PAGE_PATTERN_KIND,
  recoverSkillProposalAccepts,
  rejectSkillProposal,
} from "../../../src/core/brain/skill-proposals.ts";

let vault: string;
let skillsRoot: string;
const NOW = new Date("2026-08-22T10:00:00Z");
const FRESH = "2026-08-01T00:00:00Z";
const ANCIENT = "2020-01-01T00:00:00Z";

const MATURE_PAGE = "notes/release-ritual.md";

function writePage(
  rel: string,
  meta: { title: string; tier?: string; lifecycle?: string; confidence?: string; created?: string },
): void {
  const abs = join(vault, rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(
    abs,
    [
      "---",
      `title: ${meta.title}`,
      `tier: ${meta.tier ?? "core"}`,
      `_lifecycle: ${meta.lifecycle ?? "verified"}`,
      `_confidence: ${meta.confidence ?? "high"}`,
      `created_at: ${meta.created ?? FRESH}`,
      "---",
      "",
      "# Release ritual",
      "",
      "Name the theme, cut the branch, run the gates, tag the commit.",
      "",
    ].join("\n"),
  );
}

/** Record `used` verdicts for `path` so it clears the reuse floor. */
function recordReuse(path: string, used: number): void {
  appendContinuityRecord(vault, {
    kind: "recall_observed_use",
    createdAt: NOW.toISOString(),
    sourceRefs: [{ id: `reuse:${path}:${used}` }],
    payload: {
      session_id: "sess-reuse",
      entries: Array.from({ length: used }, () => ({ path, verdict: "USED" })),
    },
  });
}

function plan() {
  return planSkillPageDrafts(vault, { now: NOW, skillsDir: skillsRoot });
}

function skipReasonFor(rel: string): string | undefined {
  return plan().skipped.find((s) => s.path === rel)?.reason;
}

const DRAFT = {
  name: "release-ritual",
  description: "Cut a release the way this vault says releases are cut.",
  triggers: ["release", "tag", "changelog"],
  body: "1. Name the theme.\n2. Cut the branch.\n3. Run the gates.\n4. Tag the commit.",
};

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-skill-pages-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  skillsRoot = join(vault, "..", `skills-${Math.random().toString(36).slice(2)}`);
  mkdirSync(skillsRoot, { recursive: true });
  writePage(MATURE_PAGE, { title: "Release ritual" });
  recordReuse(MATURE_PAGE, 4);
});

afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
  rmSync(skillsRoot, { recursive: true, force: true });
});

test("a page clearing the trio and the reuse floor is admitted with one envelope", () => {
  const report = plan();
  expect(report.admitted.map((a) => a.path)).toEqual([MATURE_PAGE]);
  const candidate = report.admitted[0]!;
  expect(candidate.llmStep.status).toBe(NEEDS_LLM_STEP);
  expect(candidate.llmStep.prompt).toContain("Name the theme, cut the branch");
  expect(candidate.llmStep.schema_hints.length).toBeGreaterThan(0);
  expect(candidate.reuseScore).toBeGreaterThanOrEqual(MATURE_PAGE_REUSE_FLOOR);
});

test("each trio dimension rejects by name, and no envelope is built for it", () => {
  writePage("notes/low-tier.md", { title: "Low tier", tier: "supporting" });
  writePage("notes/stale.md", { title: "Stale", lifecycle: "stable", created: ANCIENT });
  writePage("notes/unsure.md", { title: "Unsure", confidence: "medium" });
  for (const rel of ["notes/low-tier.md", "notes/stale.md", "notes/unsure.md"]) recordReuse(rel, 4);

  expect(skipReasonFor("notes/low-tier.md")).toBe(SKILL_PAGE_SKIP_REASON.tier);
  expect(skipReasonFor("notes/stale.md")).toBe(SKILL_PAGE_SKIP_REASON.lifecycle);
  expect(skipReasonFor("notes/unsure.md")).toBe(SKILL_PAGE_SKIP_REASON.confidence);
  expect(plan().admitted.map((a) => a.path)).toEqual([MATURE_PAGE]);
});

test("a page nothing has reused is skipped by the evidence floor", () => {
  writePage("notes/unused.md", { title: "Unused" });
  expect(skipReasonFor("notes/unused.md")).toBe(SKILL_PAGE_SKIP_REASON.reuse);
});

test("a page an installed skill already covers is skipped, and the skip is named", () => {
  mkdirSync(join(skillsRoot, "release-ritual"), { recursive: true });
  writeFileSync(
    join(skillsRoot, "release-ritual", "SKILL.md"),
    ["---", "name: release-ritual", "description: Already installed.", "---", "", "Body.", ""].join(
      "\n",
    ),
  );
  const report = plan();
  expect(report.admitted).toEqual([]);
  const skip = report.skipped.find((s) => s.path === MATURE_PAGE);
  expect(skip?.reason).toBe(SKILL_PAGE_SKIP_REASON.covered);
  expect(skip?.detail).toContain("release-ritual");
});

test("a blank draft field is refused by the shape layer and stages nothing", () => {
  expect(() =>
    commitSkillPageDraft(vault, MATURE_PAGE, { ...DRAFT, description: "   " }, { now: NOW }),
  ).toThrow(ResponseShapeError);
  expect(listPendingSkillProposals(vault)).toEqual([]);
});

test("a name that is not a valid skill directory name is refused by the semantic check", () => {
  let caught: unknown;
  try {
    commitSkillPageDraft(vault, MATURE_PAGE, { ...DRAFT, name: "Release Ritual!" }, { now: NOW });
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(ResponseCheckError);
  expect((caught as Error).message).toContain("Release Ritual!");
  expect(listPendingSkillProposals(vault)).toEqual([]);
});

test("a validated draft stages a pending mature_page proposal inside the vault", () => {
  const before = readdirSync(skillsRoot);
  const res = commitSkillPageDraft(vault, MATURE_PAGE, DRAFT, { now: NOW });
  expect(res.outcome).toBe("created");
  expect(res.path.startsWith(join(vault, "Brain"))).toBe(true);
  const pending = listPendingSkillProposals(vault);
  expect(pending.map((p) => p.patternKind)).toEqual([MATURE_PAGE_PATTERN_KIND]);
  // Nothing outside the vault moved before accept.
  expect(readdirSync(skillsRoot)).toEqual(before);
});

test("accept materializes a well-formed SKILL.md under the skills root", () => {
  const res = commitSkillPageDraft(vault, MATURE_PAGE, DRAFT, { now: NOW });
  const accepted = acceptSkillProposal(vault, res.slug, { now: NOW, skillsRoot });
  expect(accepted.status).toBe("accepted");
  const skillFile = join(skillsRoot, DRAFT.name, "SKILL.md");
  expect(accepted.skillPath).toBe(skillFile);
  expect(existsSync(skillFile)).toBe(true);
  const body = readFileSync(skillFile, "utf8");
  expect(body).toContain(`name: ${DRAFT.name}`);
  expect(body).toContain(DRAFT.description);
  expect(body).toContain("triggers:");
  expect(body).toContain("Cut the branch.");
  // The pending copy is gone and the accepted archive is in the vault.
  expect(listPendingSkillProposals(vault)).toEqual([]);
  expect(accepted.proposalPath.startsWith(join(vault, "Brain"))).toBe(true);
});

test("rejection is sticky: a rejected page does not resurface as a draft", () => {
  const res = commitSkillPageDraft(vault, MATURE_PAGE, DRAFT, { now: NOW });
  rejectSkillProposal(vault, res.slug, { note: "not a skill" });
  const again = commitSkillPageDraft(vault, MATURE_PAGE, DRAFT, { now: NOW });
  expect(again.outcome).toBe("suppressed");
  expect(listPendingSkillProposals(vault)).toEqual([]);
});

test("the accept journal records the SKILL.md path, so a rollback removes exactly it", () => {
  const res = commitSkillPageDraft(vault, MATURE_PAGE, DRAFT, { now: NOW });
  const skillDir = join(skillsRoot, DRAFT.name);
  const skillFile = join(skillDir, "SKILL.md");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(skillFile, "half-written\n");

  // A crash between the two writes leaves a journal naming the target the
  // sequence was about to create; the resolver has to follow that path,
  // not re-derive a procedure path from the slug.
  writeSkillAcceptJournal(vault, {
    slug: res.slug,
    id: res.id,
    phase: "materialize",
    startedAt: NOW.toISOString(),
    acceptedExisted: false,
    materializedExisted: false,
    materializedPath: skillFile,
  });
  const recovered = recoverSkillProposalAccepts(vault);

  expect(recovered).toEqual([{ slug: res.slug, action: "rolled_back" }]);
  expect(existsSync(skillFile)).toBe(false);
  // The now-empty directory the sequence created goes with it.
  expect(existsSync(skillDir)).toBe(false);
  // The pending draft survives untouched - nothing was committed.
  expect(listPendingSkillProposals(vault).map((p) => p.slug)).toEqual([res.slug]);
});
