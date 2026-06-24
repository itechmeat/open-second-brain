import { expect, test } from "bun:test";

import { buildEvidencePack } from "../../../src/core/search/evidence-pack.ts";
import type { BrainSearchResult } from "../../../src/core/search/types.ts";

function result(
  path: string,
  content: string,
  reasons: string[] = ["fts5_bm25: 1.000"],
): BrainSearchResult {
  return Object.freeze({
    documentId: path === "active.md" ? 1 : 2,
    chunkId: path === "active.md" ? 1 : 2,
    path,
    title: path,
    content,
    startLine: 1,
    endLine: 1,
    score: 1,
    keywordScore: 1,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "keyword",
    reasons: Object.freeze(reasons),
  });
}

test("buildEvidencePack reports matched and missing significant terms", () => {
  const pack = buildEvidencePack("alpha gamma", [result("active.md", "alpha beta")]);

  expect(pack.significantTerms).toEqual(["alpha", "gamma"]);
  expect(pack.matchedTerms).toEqual(["alpha"]);
  expect(pack.missingTerms).toEqual(["gamma"]);
  expect(pack.abstention).toContain("gamma");
  expect(pack.records[0]?.whyRetrieved).toEqual(["fts5_bm25: 1.000"]);
});

test("buildEvidencePack marks terminal-state records from the terminal path set", () => {
  // Terminality is structural (declared frontmatter `status:`), handed in
  // as the terminal-path set - never inferred from the note's prose.
  const terminalPaths = new Set(["done.md"]);
  const pack = buildEvidencePack(
    "alpha",
    [result("done.md", "alpha and more")],
    undefined,
    terminalPaths,
  );

  expect(pack.records[0]?.terminalState).toBe(true);
  expect(pack.records[0]?.droppedCandidateReasons).toEqual([]);
});

test("buildEvidencePack does not infer terminal state from prose", () => {
  // "superseded" / "done" in the body must NOT make a record terminal
  // when no terminal path set is supplied (the old regex false-fired here).
  const pack = buildEvidencePack("alpha", [result("notes.md", "alpha superseded by another note")]);

  expect(pack.records[0]?.terminalState).toBe(false);
});

test("buildEvidencePack reports terminal downrank only when applied", () => {
  const pack = buildEvidencePack(
    "alpha",
    [result("done.md", "alpha and more", ["fts5_bm25: 1.000", "evidence_terminal_downrank: true"])],
    undefined,
    new Set(["done.md"]),
  );

  expect(pack.records[0]?.droppedCandidateReasons).toContain("terminal_state_downranked");
});

test("buildEvidencePack carries a single-line linePointer for a one-line chunk", () => {
  const pack = buildEvidencePack("alpha", [result("active.md", "alpha beta")]);

  expect(pack.records[0]?.linePointer).toBe("active.md:L1");
});

test("buildEvidencePack carries a line-range linePointer from the chunk span", () => {
  const multiLine: BrainSearchResult = Object.freeze({
    ...result("notes.md", "alpha"),
    startLine: 5,
    endLine: 12,
  });
  const pack = buildEvidencePack("alpha", [multiLine]);

  expect(pack.records[0]?.linePointer).toBe("notes.md:L5-L12");
});
