/**
 * Deep vault synthesis (Workspace Insight Suite, t_04e94382): a
 * deterministic topic dossier - matched notes, agreements (positive
 * typed relations), contradictions, stale claims, knowledge gaps
 * (dangling wikilink targets) - assembled as evidence for an external
 * synthesizer, convertible into trigger candidates.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { rmSync, utimesSync } from "node:fs";
import { join } from "node:path";

import {
  deepSynthesis,
  hasEvidenceIdentity,
  synthesisCandidates,
} from "../../../src/core/brain/deep-synthesis.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;
const NOW = new Date("2026-06-03T10:00:00Z");

beforeEach(async () => {
  ({ vault, dbPath, cleanup } = createTempVault("deep-synthesis"));
  writeMd(
    vault,
    "Brain/notes/claim.md",
    [
      "---",
      "title: Claim",
      "contradicts: [[counter]]",
      "---",
      "# Claim",
      "",
      "Manticores hunt at dawn. See [[missing-study]] for details.",
    ].join("\n"),
  );
  writeMd(
    vault,
    "Brain/notes/counter.md",
    "---\ntitle: Counter\n---\n# Counter\n\nManticores hunt strictly at night.",
  );
  writeMd(
    vault,
    "Brain/notes/support.md",
    [
      "---",
      "title: Support",
      "related: [[claim]]",
      "---",
      "# Support",
      "",
      "Field observations of manticores corroborate the dawn pattern.",
    ].join("\n"),
  );
  const old = writeMd(
    vault,
    "Brain/notes/ancient.md",
    "# Ancient\n\nA very old taxonomy entry about manticores.",
  );
  const past = new Date("2025-01-01T00:00:00Z");
  utimesSync(old, past, past);
  await indexVault(makeConfig({ vault, dbPath }));
});

afterEach(() => {
  cleanup();
});

test("the dossier reports notes, agreements, contradictions, stale claims, and gaps", async () => {
  const report = await deepSynthesis(makeConfig({ vault, dbPath }), "manticores", { now: NOW });
  expect(report.topic).toBe("manticores");
  expect(report.checked).toEqual([
    "matched_notes",
    "agreements",
    "contradictions",
    "stale_claims",
    "knowledge_gaps",
    "strongest_objection",
  ]);
  expect(report.notes.length).toBeGreaterThanOrEqual(3);

  expect(report.contradictions).toHaveLength(1);
  expect(report.contradictions[0]!.path).toBe("Brain/notes/claim.md");
  expect(report.contradictions[0]!.target).toBe("counter");

  expect(report.agreements.some((a) => a.path === "Brain/notes/support.md")).toBe(true);

  expect(report.staleClaims.some((s) => s.path === "Brain/notes/ancient.md")).toBe(true);

  expect(report.gaps).toHaveLength(1);
  expect(report.gaps[0]!.target).toBe("missing-study");
  expect(report.gaps[0]!.sources).toContain("Brain/notes/claim.md");

  // A direct contradiction is the sharpest objection and wins the
  // priority order over the stale claim and the knowledge gap.
  expect(report.strongestObjection).not.toBeNull();
  expect(report.strongestObjection!.basis).toBe("contradiction");
  expect(report.strongestObjection!.statement).toContain("Brain/notes/claim.md");
  expect(report.strongestObjection!.statement).toContain("counter");
  expect(report.strongestObjection!.sourceArtifacts).toContain("[[counter]]");
});

test("a stale topic with no contradiction objects on staleness", async () => {
  // "ancient" only matches the aged note — no contradiction, no gap —
  // so the objection falls through to the stale-claim basis.
  const report = await deepSynthesis(makeConfig({ vault, dbPath }), "taxonomy", { now: NOW });
  expect(report.contradictions).toHaveLength(0);
  expect(report.strongestObjection).not.toBeNull();
  expect(report.strongestObjection!.basis).toBe("stale");
  expect(report.strongestObjection!.sourceArtifacts).toContain("Brain/notes/ancient.md");
});

test("an empty topic yields an empty but interpretable dossier", async () => {
  const report = await deepSynthesis(makeConfig({ vault, dbPath }), "zeppelins", { now: NOW });
  expect(report.notes).toHaveLength(0);
  expect(report.contradictions).toHaveLength(0);
  expect(report.gaps).toHaveLength(0);
  expect(report.checked).toHaveLength(6);
  // No notes means there is nothing to object to.
  expect(report.strongestObjection).toBeNull();
});

test("contradiction and gap findings convert to trigger candidates", async () => {
  const report = await deepSynthesis(makeConfig({ vault, dbPath }), "manticores", { now: NOW });
  const candidates = synthesisCandidates(report);
  const keys = candidates.map((c) => c.cooldownKey);
  expect(keys).toContain("contradiction:Brain/notes/claim.md:counter");
  expect(keys).toContain("knowledge_gap:missing-study");
  for (const c of candidates) {
    expect(c.sourceArtifacts.length).toBeGreaterThan(0);
    expect(c.reason.length).toBeGreaterThan(0);
  }
});

// ----- t_40fa4e8d: causal context, decomposed confidence, evidence gate -----

test("every matched readable note becomes a finding with identity, causal context, and confidence", async () => {
  const report = await deepSynthesis(makeConfig({ vault, dbPath }), "manticores", { now: NOW });
  expect(report.findings.length).toBeGreaterThanOrEqual(3);

  const claim = report.findings.find((f) => f.evidence.path === "Brain/notes/claim.md");
  expect(claim).toBeDefined();
  // Evidence identity is a concrete, retrievable artifact.
  expect(hasEvidenceIdentity(claim!.evidence)).toBe(true);
  expect(claim!.evidence.kind).toBe("note");
  expect(claim!.evidence.contentHash).toMatch(/^[0-9a-f]{64}$/);

  // Decomposed confidence, each deterministic from data already in the pass.
  expect(claim!.confidence.support).toBeGreaterThanOrEqual(1); // support.md relates -> claim
  expect(claim!.confidence.opposition).toBeGreaterThanOrEqual(1); // claim contradicts counter
  expect(claim!.confidence.freshness).toBeGreaterThan(0); // recently touched
  expect(claim!.confidence.coverage).toBeGreaterThanOrEqual(1); // resolves [[counter]]

  // Causal context records the dangling load-bearing citation ([[missing-study]]).
  expect(claim!.causalContext.danglingCitations).toBeGreaterThanOrEqual(1);
  expect(claim!.causalContext.relations.some((r) => r.relation === "contradicts")).toBe(true);
});

test("freshness decays to zero for an aged finding", async () => {
  const report = await deepSynthesis(makeConfig({ vault, dbPath }), "taxonomy", { now: NOW });
  const ancient = report.findings.find((f) => f.evidence.path === "Brain/notes/ancient.md");
  expect(ancient).toBeDefined();
  expect(ancient!.confidence.freshness).toBe(0);
});

test("a matched note with no retrievable content is excluded with a reason, never silently dropped", async () => {
  writeMd(vault, "Brain/notes/ghost.md", "# Ghost\n\nManticores were sighted at this ridge.");
  await indexVault(makeConfig({ vault, dbPath }));
  // Delete after indexing: the index still surfaces it, but its bytes are gone.
  rmSync(join(vault, "Brain/notes/ghost.md"));

  const report = await deepSynthesis(makeConfig({ vault, dbPath }), "manticores", { now: NOW });
  // Still a matched note (existing field, unchanged).
  expect(report.notes.some((n) => n.path === "Brain/notes/ghost.md")).toBe(true);
  // But never a finding - it has no evidence identity.
  expect(report.findings.some((f) => f.evidence.path === "Brain/notes/ghost.md")).toBe(false);

  const excluded = report.excludedFindings.find((e) => e.path === "Brain/notes/ghost.md");
  expect(excluded).toBeDefined();
  expect(excluded!.reason).toBe("unreadable");
  expect(report.excludedFindingCount).toBe(report.excludedFindings.length);
  expect(report.excludedFindingCount).toBeGreaterThanOrEqual(1);
});

test("hasEvidenceIdentity rejects incomplete identities", () => {
  expect(hasEvidenceIdentity(null)).toBe(false);
  expect(hasEvidenceIdentity(undefined)).toBe(false);
  expect(hasEvidenceIdentity({ path: "", kind: "note", contentHash: "h" })).toBe(false);
  expect(hasEvidenceIdentity({ path: "a", kind: "", contentHash: "h" })).toBe(false);
  expect(hasEvidenceIdentity({ path: "a", kind: "note", contentHash: "" })).toBe(false);
  expect(hasEvidenceIdentity({ path: "a", kind: "note", contentHash: "h" })).toBe(true);
});

test("the additive fields do not disturb the prior report shape", async () => {
  const report = await deepSynthesis(makeConfig({ vault, dbPath }), "manticores", { now: NOW });
  // Prior dimensions unchanged (regression on prior output shape).
  expect(report.checked).toEqual([
    "matched_notes",
    "agreements",
    "contradictions",
    "stale_claims",
    "knowledge_gaps",
    "strongest_objection",
  ]);
  // New fields are present and additive.
  expect(Array.isArray(report.findings)).toBe(true);
  expect(Array.isArray(report.excludedFindings)).toBe(true);
  expect(typeof report.excludedFindingCount).toBe("number");
});
