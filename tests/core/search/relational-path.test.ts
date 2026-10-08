/**
 * Ordered path provenance with per-node reach gating
 * (truth-correctable-time-aware): the fan-out records the ordered
 * `{ documentId, relation }` steps that reached each node; the arm gates
 * every path node at the caller's transport reach (unreadable nodes are
 * omitted and counted), annotates a readable non-tip superseded
 * predecessor with a closed validity window, and attribution renders the
 * withheld count beside the hop distance.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { relationalFanout } from "../../../src/core/search/relational-fanout.ts";
import { Store } from "../../../src/core/search/store.ts";
import { runRelationalArm } from "../../../src/core/search/pipeline/relational-arm.ts";
import { decorateFinalResults } from "../../../src/core/search/pipeline/attribution.ts";
import {
  buildRetrievalTrail,
  retrievalTrailEnvelope,
  RETRIEVAL_RELATIONAL_PATH_CODE,
} from "../../../src/core/search/retrieval-trail.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("relational-path");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

// ─── the fanout records the ordered path ─────────────────────────────────────

test("a reached node carries the ordered steps that first reached it", () => {
  const store = {
    typedRelationEdgesForDocuments(ids: ReadonlyArray<number>) {
      const set = new Set(ids);
      return [
        { sourceDocumentId: 1, relation: "related", target: "b", targetDocumentId: 2 },
        { sourceDocumentId: 1, relation: "related", target: "d", targetDocumentId: 4 },
        { sourceDocumentId: 2, relation: "extends", target: "c", targetDocumentId: 3 },
        { sourceDocumentId: 4, relation: "related", target: "c", targetDocumentId: 3 },
      ].filter((e) => set.has(e.sourceDocumentId));
    },
  };
  const byId = new Map(relationalFanout(store, [1], { maxDepth: 2 }).map((n) => [n.documentId, n]));
  // Node 3 is reachable at the same depth two ways; the path is the one
  // that reached it FIRST in deterministic frontier order (node 2 expanded
  // before node 4). Later arrivals never rewrite it.
  expect(byId.get(2)!.path).toEqual([{ documentId: 2, relation: "related" }]);
  expect(byId.get(3)!.path).toEqual([
    { documentId: 2, relation: "related" },
    { documentId: 3, relation: "extends" },
  ]);
});

test("a bridge step carries the entity relation in the path", () => {
  const store = {
    typedRelationEdgesForDocuments() {
      return [];
    },
    entityBridgesForDocuments() {
      return [{ sourceDocumentId: 1, targetDocumentId: 2 }];
    },
  };
  const nodes = relationalFanout(store, [1], { maxDepth: 1 });
  expect(nodes.map((n) => n.path)).toEqual([[{ documentId: 2, relation: "entity" }]]);
});

// ─── per-node reach gating in the arm ────────────────────────────────────────

/** seed --related--> mid --extends--> far, indexed for real. */
async function buildPathVault(): Promise<void> {
  writeMd(
    vault,
    "seed.md",
    '---\nrelated: "[[mid]]"\n---\n\nalpha seed document for the path walk.',
  );
  writeMd(vault, "mid.md", '---\nextends: "[[far]]"\n---\n\nbeta mid document for the path walk.');
  writeMd(vault, "far.md", "# Far\n\ngamma far document for the path walk.");
  await indexVault(makeConfig({ vault, dbPath }));
}

test("path nodes unreadable at the caller's reach are omitted and counted", async () => {
  await buildPathVault();
  writeMd(vault, "mid.md", '---\nvisibility: ["private"]\nextends: "[[far]]"\n---\n\nbeta mid.');
  await indexVault(makeConfig({ vault, dbPath }));
  const store = await Store.open(makeConfig({ vault, dbPath }), { mode: "write", loadVec: false });
  try {
    const remote = runRelationalArm(store, vault, "[[seed]] related extends", {
      reach: TRANSPORT_REACH.remote,
    });
    const farEntry = [...remote.reachByChunk].find(([, reach]) => reach.hops === 2);
    expect(farEntry).toBeDefined();
    // The withheld middle node is omitted from the ordered path and
    // counted; the far node itself is readable and keeps its own step.
    expect(farEntry![1].path).toEqual([{ documentId: farEntry![0], relation: "extends" }]);
    expect(farEntry![1].withheld).toBe(1);
    // At local reach the same walk keeps the whole path.
    const local = runRelationalArm(store, vault, "[[seed]] related extends", {});
    const farLocal = [...local.reachByChunk].find(([, reach]) => reach.hops === 2);
    expect(farLocal![1].withheld).toBe(0);
    expect(farLocal![1].path.map((step) => step.relation)).toEqual(["related", "extends"]);
  } finally {
    store.close();
  }
});

test("a readable non-tip predecessor with a closed window is annotated from frontmatter", async () => {
  // Every write and index completes before a store is opened: an open
  // write-mode store holds the writer lock the indexer needs.
  await buildPathVault();
  writeMd(
    vault,
    "mid.md",
    '---\nextends: "[[far]]"\nsuperseded_by: "[[far]]"\nvalid_until: "2020-01-01"\n---\n\nbeta mid.',
  );
  await indexVault(makeConfig({ vault, dbPath }));
  const closed = await Store.open(makeConfig({ vault, dbPath }), { mode: "write", loadVec: false });
  try {
    const outcome = runRelationalArm(closed, vault, "[[seed]] related extends", {});
    const farEntry = [...outcome.reachByChunk].find(([, reach]) => reach.hops === 2);
    // The frontmatter pointer names the tip; the window is already past.
    expect(farEntry![1].supersededBy).toBe("far");
  } finally {
    closed.close();
  }
  // An open window is not a closed one: the same pointer with a future
  // validity end stays unannotated.
  writeMd(
    vault,
    "mid.md",
    '---\nextends: "[[far]]"\nsuperseded_by: "[[far]]"\nvalid_until: "2099-12-31"\n---\n\nbeta mid.',
  );
  await indexVault(makeConfig({ vault, dbPath }));
  const open = await Store.open(makeConfig({ vault, dbPath }), { mode: "write", loadVec: false });
  try {
    const openOutcome = runRelationalArm(open, vault, "[[seed]] related extends", {});
    const openFar = [...openOutcome.reachByChunk].find(([, reach]) => reach.hops === 2);
    expect(openFar![1].supersededBy).toBeUndefined();
  } finally {
    open.close();
  }
});

// ─── attribution renders the withheld count and the annotation ───────────────

test("the attribution reason renders hops, the withheld count and the annotation", () => {
  const base = {
    documentId: 1,
    chunkId: 11,
    path: "a.md",
    title: null,
    content: "body",
    startLine: 1,
    endLine: 1,
    score: 1,
    keywordScore: 0,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "link" as const,
    reasons: [],
    breakdown: undefined,
  };
  const reach = new Map([
    [
      11,
      {
        via: ["extends"],
        hops: 2,
        withheld: 1,
        path: [{ documentId: 3, relation: "extends" }],
      },
    ],
    [
      12,
      {
        via: ["related"],
        hops: 1,
        withheld: 0,
        path: [{ documentId: 2, relation: "related" }],
        supersededBy: "tip",
      },
    ],
  ]);
  const decorated = decorateFinalResults({
    store: {
      typedRelationsForDocuments: () => new Map(),
    } as never,
    results: [
      { ...base, chunkId: 11, documentId: 3 },
      { ...base, chunkId: 12, documentId: 2 },
    ],
    structured: undefined,
    activeLearned: null,
    canonicalSourceIds: [],
    secondPass: undefined,
    targetedChunkIds: new Set(),
    relationalReach: reach,
  });
  const reasons = decorated.map((r) => r.reasons);
  expect(reasons[0]).toEqual(["relational: via extends (2 hops, 1 node withheld)"]);
  expect(reasons[1]).toEqual([
    "relational: via related (1 hop, 0 nodes withheld)",
    "superseded_by: tip",
  ]);
});

// ─── the ordered path lands in the retrieval trail as a typed code ───────────

test("the trail carries the relational path with readable ids and the withheld count", () => {
  const trail = buildRetrievalTrail({
    retrieved: 1,
    pool: 3,
    degraded: [],
    relationalPaths: [{ code: RETRIEVAL_RELATIONAL_PATH_CODE, path: [2, 3], withheld: 1 }],
  });
  expect(trail?.relationalPaths).toEqual([{ code: "relational-path", path: [2, 3], withheld: 1 }]);
  const envelope = retrievalTrailEnvelope({ retrievalTrail: trail });
  expect(envelope.retrieval_trail).toMatchObject({
    relational_paths: [{ code: "relational-path", path: [2, 3], withheld: 1 }],
  });
  // Absent paths keep the envelope byte-identical to the pre-change shape.
  const plain = buildRetrievalTrail({
    retrieved: 1,
    pool: 3,
    degraded: [{ code: "index-stale" }],
  });
  expect(plain?.relationalPaths).toBeUndefined();
  expect(
    "relational_paths" in
      (retrievalTrailEnvelope({ retrievalTrail: plain }).retrieval_trail as object),
  ).toBe(false);
});
