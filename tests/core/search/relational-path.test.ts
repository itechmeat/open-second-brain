/**
 * Ordered path provenance with per-node reach gating
 * (truth-correctable-time-aware): the fan-out records the ordered
 * `{ documentId, relation }` steps that reached each node; the arm gates
 * every path node at the caller's transport reach and owner scope
 * (unreadable or out-of-scope nodes are omitted, never named and never
 * counted), annotates a readable non-tip superseded predecessor with a
 * closed validity window, and attribution renders the hop distance.
 */

import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { relationalFanout } from "../../../src/core/search/relational-fanout.ts";
import { Store } from "../../../src/core/search/store.ts";
import { runRelationalArm } from "../../../src/core/search/pipeline/relational-arm.ts";
import { decorateFinalResults } from "../../../src/core/search/pipeline/attribution.ts";
import {
  buildRetrievalTrail,
  retrievalTrailEnvelope,
  RETRIEVAL_RELATIONAL_PATH_CODE,
  type RelationalPathTrailEntry,
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

test("path nodes unreadable at the caller's reach are omitted, never named and never counted", async () => {
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
    // The withheld middle node is omitted from the ordered path; the far
    // node itself is readable and keeps its own step.
    expect(farEntry![1].path).toEqual([{ documentId: farEntry![0], relation: "extends" }]);
    // Nothing counts it: a withheld node is dropped under the views'
    // identical-to-absent convention, so the provenance answer is the
    // same whether the walk crossed an unreadable document or not.
    expect("withheld" in farEntry![1]).toBe(false);
    // At an explicitly local reach the same walk keeps the whole path.
    const local = runRelationalArm(store, vault, "[[seed]] related extends", {
      reach: TRANSPORT_REACH.local,
    });
    const farLocal = [...local.reachByChunk].find(([, reach]) => reach.hops === 2);
    expect(farLocal![1].path.map((step) => step.relation)).toEqual(["related", "extends"]);
  } finally {
    await store.close();
  }
});

test("an absent reach behaves like remote: provenance never names a page the row gate withholds", async () => {
  // The row-level filters resolve an absent reach to remote
  // (`resolvedTransportReach`), so the arm's per-node provenance gate
  // must answer the same question with the same answer: a page the
  // remote row gate withholds is never named in an ordered path and
  // never contributes its supersession tip - a library caller passing no
  // reach must not learn more from provenance than the rows show.
  await buildPathVault();
  writeMd(
    vault,
    "mid.md",
    '---\nvisibility: ["private"]\nextends: "[[far]]"\nsuperseded_by: "[[far]]"\nvalid_until: "2020-01-01"\n---\n\nbeta mid.',
  );
  await indexVault(makeConfig({ vault, dbPath }));
  const store = await Store.open(makeConfig({ vault, dbPath }), { mode: "write", loadVec: false });
  try {
    const midId = store.getDocumentIdByPath("mid.md");
    expect(midId).not.toBeNull();
    const midChunk = store.representativeChunks([midId!]).get(midId!)!;
    const absent = runRelationalArm(store, vault, "[[seed]] related extends", {});
    const absentEntry = absent.reachByChunk.get(midChunk.chunkId);
    expect(absentEntry).toBeDefined();
    // The withheld middle page's id is never named and its closed-window
    // tip never announced: provenance reads the same as the row gate.
    expect(absentEntry!.path).toEqual([]);
    expect(absentEntry!.supersededBy).toBeUndefined();
    // An explicitly local reach keeps the wide walk: the local caller
    // sees the whole path and the annotation.
    const local = runRelationalArm(store, vault, "[[seed]] related extends", {
      reach: TRANSPORT_REACH.local,
    });
    const localEntry = local.reachByChunk.get(midChunk.chunkId);
    expect(localEntry).toBeDefined();
    expect(localEntry!.path).toEqual([{ documentId: midId!, relation: "related" }]);
    expect(localEntry!.supersededBy).toBe("far");
  } finally {
    await store.close();
  }
});

test("path nodes outside the caller's owner scope are omitted, never named and never counted", async () => {
  // Owner scope is the same isolation the row-level filters apply: a
  // path node that is reach-readable but owned by another agent must be
  // withheld from the provenance exactly like an unreadable one, or its
  // document id would ride along in the trail as an existence signal the
  // content rows never give.
  await buildPathVault();
  writeMd(vault, "mid.md", '---\nowner: agent-a\nextends: "[[far]]"\n---\n\nbeta mid.');
  await indexVault(makeConfig({ vault, dbPath }));
  const store = await Store.open(makeConfig({ vault, dbPath }), { mode: "write", loadVec: false });
  try {
    const scoped = runRelationalArm(store, vault, "[[seed]] related extends", {
      agentScope: "agent-b",
    });
    const farScoped = [...scoped.reachByChunk].find(([, reach]) => reach.hops === 2);
    expect(farScoped).toBeDefined();
    // The owner-hidden middle node is omitted from the ordered path; the
    // far node keeps only its own step, and nothing counts the omission.
    expect(farScoped![1].path).toEqual([{ documentId: farScoped![0], relation: "extends" }]);
    expect("withheld" in farScoped![1]).toBe(false);
    // No step anywhere names the hidden node's document id.
    const hiddenId = store.getDocumentIdByPath("mid.md");
    for (const [, reach] of scoped.reachByChunk) {
      for (const step of reach.path) {
        expect(step.documentId).not.toBe(hiddenId);
      }
    }
    // Without a requested scope the same walk keeps the whole path: the
    // ownership gate is opt-in isolation, never a default narrowing.
    const unscoped = runRelationalArm(store, vault, "[[seed]] related extends", {});
    const farUnscoped = [...unscoped.reachByChunk].find(([, reach]) => reach.hops === 2);
    expect(farUnscoped![1].path.map((step) => step.relation)).toEqual(["related", "extends"]);
  } finally {
    await store.close();
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
    await closed.close();
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
    await open.close();
  }
});

test("the closed-window annotation reads the grammar's inclusive end as still inside the window", async () => {
  // The shared frontmatter grammar (src/core/search/validity.ts) snaps a
  // bare `valid_until` date to its whole final day - the end is
  // inclusive - so at the boundary instant itself the window is still
  // open and the page is not yet a closed predecessor. One millisecond
  // past the end, the annotation appears.
  await buildPathVault();
  writeMd(
    vault,
    "mid.md",
    '---\nextends: "[[far]]"\nsuperseded_by: "[[far]]"\nvalid_until: "2099-12-31"\n---\n\nbeta mid.',
  );
  await indexVault(makeConfig({ vault, dbPath }));
  const store = await Store.open(makeConfig({ vault, dbPath }), { mode: "write", loadVec: false });
  // The grammar's day-end edge: the last millisecond of 2099-12-31.
  const dayEndMs = Date.UTC(2099, 11, 31) + 24 * 60 * 60 * 1000 - 1;
  const clockAt = (ms: number): (() => void) => {
    const spy = spyOn(Date, "now").mockReturnValue(ms);
    return () => spy.mockRestore();
  };
  try {
    const restoreAtBoundary = clockAt(dayEndMs);
    try {
      const atBoundary = runRelationalArm(store, vault, "[[seed]] related extends", {});
      const farEntry = [...atBoundary.reachByChunk].find(([, reach]) => reach.hops === 2);
      expect(farEntry).toBeDefined();
      expect(farEntry![1].supersededBy).toBeUndefined();
    } finally {
      restoreAtBoundary();
    }
    const restorePastBoundary = clockAt(dayEndMs + 1);
    try {
      const pastBoundary = runRelationalArm(store, vault, "[[seed]] related extends", {});
      const farPast = [...pastBoundary.reachByChunk].find(([, reach]) => reach.hops === 2);
      expect(farPast).toBeDefined();
      expect(farPast![1].supersededBy).toBe("far");
    } finally {
      restorePastBoundary();
    }
  } finally {
    await store.close();
  }
});

// ─── attribution renders the hop distance and the annotation ─────────────────

test("the attribution reason renders hops and the annotation, never a withheld count", () => {
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
        path: [{ documentId: 3, relation: "extends" }],
      },
    ],
    [
      12,
      {
        via: ["related"],
        hops: 1,
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
    canonicalMatchByChunk: undefined,
    canonicalSourceIds: [],
    secondPass: undefined,
    targetedChunkIds: new Set(),
    relationalReach: reach,
  });
  const reasons = decorated.map((r) => r.reasons);
  expect(reasons[0]).toEqual(["relational: via extends (2 hops)"]);
  expect(reasons[1]).toEqual(["relational: via related (1 hop)", "superseded_by: tip"]);
  // No reason string states how many path nodes were withheld: the
  // omitted steps are already absent from the path, and a count would
  // tell the caller a node it may not see exists.
  for (const row of reasons) {
    for (const reason of row) expect(reason).not.toContain("withheld");
  }
});

// ─── the ordered path lands in the retrieval trail as a typed code ───────────

test("the trail carries the relational path with readable ids, and never a withheld count", () => {
  const trail = buildRetrievalTrail({
    retrieved: 1,
    pool: 3,
    degraded: [],
    relationalPaths: [{ code: RETRIEVAL_RELATIONAL_PATH_CODE, path: [2, 3] }],
  });
  expect(trail?.relationalPaths).toEqual([{ code: "relational-path", path: [2, 3] }]);
  const envelope = retrievalTrailEnvelope({ retrievalTrail: trail });
  expect(envelope.retrieval_trail).toMatchObject({
    relational_paths: [{ code: "relational-path", path: [2, 3] }],
  });
  expect(JSON.stringify(envelope)).not.toContain("withheld");
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

// ─── the outcome builder passes the paths to the trail (integrator wiring) ───

import { buildSearchOutcome, withIndexStale } from "../../../src/core/search/pipeline/outcome.ts";
import type { BrainSearchResult, SearchOutcome } from "../../../src/core/search/types.ts";

/** A minimal result row the outcome builder and attribution both accept. */
function row(chunkId: number, documentId: number): BrainSearchResult {
  return {
    documentId,
    chunkId,
    path: `doc-${documentId}.md`,
    title: null,
    content: "body",
    startLine: 1,
    endLine: 1,
    score: 1,
    keywordScore: 0,
    semanticScore: 0,
    linkBoost: 0,
    recencyBoost: 0,
    searchType: "link",
    reasons: [],
    breakdown: undefined,
  };
}

test("the outcome builder projects surfaced relational rows into the trail, ranked order", async () => {
  await buildPathVault();
  const config = makeConfig({ vault, dbPath });
  const store = await Store.open(config, { mode: "write", loadVec: false });
  try {
    const baseInput = {
      store,
      config,
      opts: { query: "alpha seed document" },
      query: "alpha seed document",
      pathPrefix: undefined,
      results: [row(11, 3), row(12, 2)],
      warnings: [],
      secondPass: undefined,
      routedSurface: "default" as const,
      trustReceipts: null,
      frontmatterCache: new Map(),
      poolSize: 3,
      degraded: [],
      corpus: null,
    };
    const reach = new Map([
      [
        12,
        {
          via: ["related"],
          hops: 1,
          path: [{ documentId: 2, relation: "related" }],
        },
      ],
      [
        11,
        {
          via: ["extends"],
          hops: 2,
          path: [{ documentId: 3, relation: "extends" }],
        },
      ],
    ]);
    const outcome = buildSearchOutcome({ ...baseInput, relationalReach: reach });
    // One entry per surfaced relational row, in ranked order, carrying the
    // readable document ids. A walked-but-unreadable node contributes no
    // entry and no count: the answer reads the same as a walk that never
    // crossed it.
    expect(outcome.retrievalTrail?.relationalPaths).toEqual([
      { code: "relational-path", path: [3] },
      { code: "relational-path", path: [2] },
    ]);
    // The arm-off shape: no reach map, no trail at all on a healthy answer.
    const off = buildSearchOutcome(baseInput);
    expect(off.retrievalTrail).toBeUndefined();
    // Reach entries for rows that did not surface project to nothing.
    const sunk = buildSearchOutcome({
      ...baseInput,
      results: [row(99, 9)],
      poolSize: 1,
      relationalReach: reach,
    });
    expect(sunk.retrievalTrail).toBeUndefined();
  } finally {
    await store.close();
  }
});

test("the stale-index rebuild carries the arm's paths and stays byte-identical without them", () => {
  const paths: RelationalPathTrailEntry[] = [
    { code: RETRIEVAL_RELATIONAL_PATH_CODE, path: [2, 3] },
  ];
  const withPaths = {
    results: [],
    warnings: [],
    total: 3,
    idfWeightedCoverage: 0,
    retrievalTrail: { retrieved: 1, pool: 3, degraded: [], relationalPaths: paths },
  } as unknown as SearchOutcome;
  const stale = withIndexStale(withPaths, 100_000);
  expect(stale.retrievalTrail?.degraded.map((d) => d.code)).toEqual(["index-stale"]);
  // Provenance is not a degradation statement: it survives the rebuild.
  expect(stale.retrievalTrail?.relationalPaths).toEqual(paths);
  // Without paths the rebuilt trail is exactly the pre-change shape.
  const plain = {
    results: [],
    warnings: [],
    total: 3,
    idfWeightedCoverage: 0,
    retrievalTrail: { retrieved: 1, pool: 3, degraded: [] },
  } as unknown as SearchOutcome;
  const stalePlain = withIndexStale(plain, 100_000);
  expect(stalePlain.retrievalTrail).toEqual({
    retrieved: 1,
    pool: 3,
    degraded: [{ code: "index-stale", detail: { ageSeconds: 100_000 } }],
  });
  expect("relationalPaths" in (stalePlain.retrievalTrail ?? {})).toBe(false);
});
