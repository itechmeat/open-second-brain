/**
 * Relation-aware recall (recall-trust-suite, Feature A).
 *
 * Typed relation edges get recall polarity: `superseded_by` demotes the
 * matched predecessor and pulls in / boosts its successor, `contradicts`
 * surfaces with a warning-style reason and no score change, and the
 * positive relations (`related` / `extends` / `depends_on` / `refines`)
 * grant a small bounded boost between co-retrieved candidates. The pure
 * pass lives in `relation-polarity.ts`; `search.ts` wires it over the
 * assembled pool before the final slice.
 */

import { test, expect, beforeEach, afterEach, describe } from "bun:test";

import {
  applyRelationPolarity,
  RELATION_BOOST_CAP,
  SUPERSEDED_DEMOTION,
  SUCCESSOR_CARRY,
  type RelationEdge,
} from "../../../src/core/search/relation-polarity.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import type { BrainSearchResult } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

// ── unit: pure polarity pass ─────────────────────────────────────────────────

function result(over: Partial<BrainSearchResult> & { documentId: number }): BrainSearchResult {
  return Object.freeze({
    chunkId: over.documentId * 10,
    path: `doc-${over.documentId}.md`,
    title: null,
    content: "body",
    startLine: 1,
    endLine: 1,
    score: 0.5,
    keywordScore: 0.5,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "keyword" as const,
    reasons: Object.freeze(["fts5_bm25: 0.500"]),
    ...over,
  });
}

function edge(over: Partial<RelationEdge> & { sourceDocumentId: number }): RelationEdge {
  return {
    relation: "related",
    target: "x",
    targetDocumentId: null,
    ...over,
  };
}

describe("applyRelationPolarity (pure)", () => {
  test("no edges → identical results back", () => {
    const pool = [result({ documentId: 1, score: 0.9 }), result({ documentId: 2, score: 0.4 })];
    const out = applyRelationPolarity({ ranked: pool, edges: [], successorDoc: () => null }, {});
    expect(out).toEqual(pool);
  });

  test("superseded_by demotes the predecessor and boosts a co-retrieved successor", () => {
    const pool = [
      result({ documentId: 1, score: 0.9, path: "old.md" }),
      result({ documentId: 2, score: 0.3, path: "new.md" }),
    ];
    const edges = [
      edge({
        sourceDocumentId: 1,
        relation: "superseded_by",
        target: "new",
        targetDocumentId: 2,
      }),
    ];
    const out = applyRelationPolarity({ ranked: pool, edges, successorDoc: () => null }, {});
    const oldHit = out.find((r) => r.path === "old.md")!;
    const newHit = out.find((r) => r.path === "new.md")!;
    expect(oldHit.score).toBeCloseTo(0.9 * SUPERSEDED_DEMOTION, 5);
    expect(oldHit.reasons).toContain("superseded_by: new");
    expect(newHit.score).toBeCloseTo(0.9 * SUCCESSOR_CARRY, 5);
    expect(newHit.reasons).toContain("supersedes_matched: old.md");
    // Successor outranks the demoted predecessor.
    expect(out.findIndex((r) => r.path === "new.md")).toBeLessThan(
      out.findIndex((r) => r.path === "old.md"),
    );
  });

  test("superseded_by pulls in an absent successor via successorDoc", () => {
    const pool = [result({ documentId: 1, score: 0.8, path: "old.md" })];
    const edges = [
      edge({
        sourceDocumentId: 1,
        relation: "superseded_by",
        target: "new",
        targetDocumentId: 7,
      }),
    ];
    const out = applyRelationPolarity(
      {
        ranked: pool,
        edges,
        successorDoc: (docId) =>
          docId === 7
            ? {
                documentId: 7,
                chunkId: 70,
                path: "new.md",
                title: "New",
                content: "successor body",
                startLine: 1,
                endLine: 1,
              }
            : null,
      },
      {},
    );
    const pulled = out.find((r) => r.path === "new.md");
    expect(pulled).toBeDefined();
    expect(pulled!.searchType).toBe("link");
    expect(pulled!.score).toBeCloseTo(0.8 * SUCCESSOR_CARRY, 5);
    expect(pulled!.reasons).toContain("supersedes_matched: old.md");
  });

  test("includeSuperseded keeps the predecessor undemoted and skips pull-in", () => {
    const pool = [result({ documentId: 1, score: 0.9, path: "old.md" })];
    const edges = [
      edge({
        sourceDocumentId: 1,
        relation: "superseded_by",
        target: "new",
        targetDocumentId: 7,
      }),
    ];
    const out = applyRelationPolarity(
      { ranked: pool, edges, successorDoc: () => null },
      { includeSuperseded: true },
    );
    expect(out).toHaveLength(1);
    expect(out[0]!.score).toBeCloseTo(0.9, 5);
    // The informational reason still lands.
    expect(out[0]!.reasons).toContain("superseded_by: new");
  });

  test("an unresolved superseded_by target is inert: reason only, no demotion", () => {
    const pool = [result({ documentId: 1, score: 0.9, path: "old.md" })];
    const edges = [
      edge({
        sourceDocumentId: 1,
        relation: "superseded_by",
        target: "ghost",
        targetDocumentId: null,
      }),
    ];
    const out = applyRelationPolarity({ ranked: pool, edges, successorDoc: () => null }, {});
    expect(out[0]!.score).toBeCloseTo(0.9, 5);
    expect(out[0]!.reasons).toContain("superseded_by: ghost");
  });

  test("contradicts adds warning reasons on both endpoints and never changes scores", () => {
    const pool = [
      result({ documentId: 1, score: 0.9, path: "claim.md" }),
      result({ documentId: 2, score: 0.4, path: "counter.md" }),
    ];
    const edges = [
      edge({
        sourceDocumentId: 1,
        relation: "contradicts",
        target: "counter",
        targetDocumentId: 2,
      }),
    ];
    const out = applyRelationPolarity({ ranked: pool, edges, successorDoc: () => null }, {});
    const claim = out.find((r) => r.path === "claim.md")!;
    const counter = out.find((r) => r.path === "counter.md")!;
    expect(claim.score).toBeCloseTo(0.9, 5);
    expect(counter.score).toBeCloseTo(0.4, 5);
    expect(claim.reasons).toContain("contradicts: counter");
    expect(counter.reasons).toContain("contradicted_by: claim.md");
  });

  test("positive relations grant a bounded directional boost to a co-retrieved target", () => {
    const pool = [
      result({ documentId: 1, score: 0.9, path: "feature.md" }),
      result({ documentId: 2, score: 0.4, path: "base.md" }),
    ];
    const edges = [
      edge({ sourceDocumentId: 1, relation: "extends", target: "base", targetDocumentId: 2 }),
      edge({ sourceDocumentId: 1, relation: "depends_on", target: "base", targetDocumentId: 2 }),
      edge({ sourceDocumentId: 1, relation: "refines", target: "base", targetDocumentId: 2 }),
    ];
    const out = applyRelationPolarity({ ranked: pool, edges, successorDoc: () => null }, {});
    const base = out.find((r) => r.path === "base.md")!;
    // Three edges at 0.02 each would be 0.06; the cap holds it at RELATION_BOOST_CAP.
    expect(base.score).toBeCloseTo(0.4 + RELATION_BOOST_CAP, 5);
    expect(base.reasons.some((r) => r.startsWith("relation_boost: extends"))).toBe(true);
  });

  test("self-edges are ignored", () => {
    const pool = [result({ documentId: 1, score: 0.9, path: "self.md" })];
    const edges = [
      edge({ sourceDocumentId: 1, relation: "superseded_by", target: "self", targetDocumentId: 1 }),
    ];
    const out = applyRelationPolarity({ ranked: pool, edges, successorDoc: () => null }, {});
    expect(out[0]!.score).toBeCloseTo(0.9, 5);
  });
});

// ── integration: search() wiring ─────────────────────────────────────────────

/** Clock-stable projection of a result (drops the recency layer's drift). */
function stableProjection(r: BrainSearchResult) {
  return {
    path: r.path,
    searchType: r.searchType,
    keywordScore: r.keywordScore,
    reasons: r.reasons.filter((reason) => !reason.startsWith("recency:")),
  };
}

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("relation-polarity"));
});
afterEach(() => cleanup());

const OLD_PAGE = [
  "---",
  "title: Old deploy decision",
  'superseded_by: "[[new-deploy]]"',
  "---",
  "# Old deploy decision",
  "",
  "We deploy with the blue-green rollout strategy on fridays.",
].join("\n");

const NEW_PAGE = [
  "---",
  "title: New deploy decision",
  "---",
  "# New deploy decision",
  "",
  "Deployment notes for the canary path.",
].join("\n");

test("search surfaces the successor above the demoted predecessor", async () => {
  writeMd(vault, "old.md", OLD_PAGE);
  writeMd(vault, "new-deploy.md", NEW_PAGE);
  const cfg = makeConfig({ vault, dbPath });

  await indexVault(cfg);
  const out = await search(cfg, { query: "blue-green rollout strategy", limit: 5 });
  const oldIdx = out.results.findIndex((r) => r.path === "old.md");
  const newIdx = out.results.findIndex((r) => r.path === "new-deploy.md");
  expect(oldIdx).toBeGreaterThanOrEqual(0);
  expect(newIdx).toBeGreaterThanOrEqual(0);
  expect(newIdx).toBeLessThan(oldIdx);
  expect(out.results[oldIdx]!.reasons).toContain("superseded_by: new-deploy");
  expect(out.results[newIdx]!.reasons).toContain("supersedes_matched: old.md");
});

test("includeSuperseded restores the undemoted order", async () => {
  writeMd(vault, "old.md", OLD_PAGE);
  writeMd(vault, "new-deploy.md", NEW_PAGE);
  const cfg = makeConfig({ vault, dbPath });

  await indexVault(cfg);
  const out = await search(cfg, {
    query: "blue-green rollout strategy",
    limit: 5,
    includeSuperseded: true,
  });
  const oldIdx = out.results.findIndex((r) => r.path === "old.md");
  const newIdx = out.results.findIndex((r) => r.path === "new-deploy.md");
  expect(oldIdx).toBeGreaterThanOrEqual(0);
  // The predecessor stays on top: it is the direct text match.
  if (newIdx >= 0) expect(oldIdx).toBeLessThan(newIdx);
});

test("contradicts surfaces a warning reason without reordering", async () => {
  writeMd(
    vault,
    "claim.md",
    [
      "---",
      "title: Claim",
      'contradicts: "[[counter]]"',
      "---",
      "# Claim",
      "",
      "The retention window for kanban telemetry is thirty days.",
    ].join("\n"),
  );
  writeMd(
    vault,
    "counter.md",
    "# Counter\n\nThe retention window for kanban telemetry is ninety days.",
  );
  const cfg = makeConfig({ vault, dbPath });

  await indexVault(cfg);
  const out = await search(cfg, { query: "retention window kanban telemetry", limit: 5 });
  const claim = out.results.find((r) => r.path === "claim.md");
  const counter = out.results.find((r) => r.path === "counter.md");
  expect(claim).toBeDefined();
  expect(counter).toBeDefined();
  expect(claim!.reasons).toContain("contradicts: counter");
  expect(counter!.reasons).toContain("contradicted_by: claim.md");
});

test("a vault without typed relations ranks bit-identically with the pass on or off", async () => {
  writeMd(vault, "x.md", "# X\n\nplain note about orchard pruning in spring");
  writeMd(vault, "y.md", "# Y\n\nanother note about orchard irrigation [[x]]");
  const on = makeConfig({ vault, dbPath });
  const off = makeConfig({ vault, dbPath, relationPolarityEnabled: false });

  await indexVault(on);
  const a = await search(on, { query: "orchard pruning", limit: 5 });
  const b = await search(off, { query: "orchard pruning", limit: 5 });
  // Project away the recency layer's clock drift between the two calls;
  // order, paths, types, and reasons must match exactly.
  expect(a.results.map(stableProjection)).toEqual(b.results.map(stableProjection));
});

test("disabling relation polarity in config skips demotion entirely", async () => {
  writeMd(vault, "old.md", OLD_PAGE);
  writeMd(vault, "new-deploy.md", NEW_PAGE);
  const cfg = makeConfig({ vault, dbPath, relationPolarityEnabled: false });

  await indexVault(cfg);
  const out = await search(cfg, { query: "blue-green rollout strategy", limit: 5 });
  const oldHit = out.results.find((r) => r.path === "old.md")!;
  expect(oldHit.reasons.some((r) => r.startsWith("superseded_by:"))).toBe(false);
});
