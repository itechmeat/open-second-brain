import { test, expect } from "bun:test";

import {
  relationalFanout,
  resolveTraversalBudgets,
  TRAVERSAL_HUB_DEGREE_THRESHOLD,
  TRAVERSAL_HUB_DEGREE_THRESHOLD_ENV,
  TRAVERSAL_MAX_EXPANSION_PER_NODE,
  TRAVERSAL_MAX_EXPANSION_PER_NODE_ENV,
  TRAVERSAL_MAX_SEEDS,
  TRAVERSAL_MAX_SEEDS_ENV,
  TRAVERSAL_MAX_TOTAL_NODES,
  TRAVERSAL_MAX_TOTAL_NODES_ENV,
  type RelationalFanoutStore,
} from "../../../src/core/search/relational-fanout.ts";
import { SearchError } from "../../../src/core/search/search-error.ts";
import {
  TRAVERSAL_HUB_DEGREE_THRESHOLD as HUB_FROM_BARREL,
  TRAVERSAL_MAX_EXPANSION_PER_NODE as EXPANSION_FROM_BARREL,
  TRAVERSAL_MAX_SEEDS as SEEDS_FROM_BARREL,
  TRAVERSAL_MAX_TOTAL_NODES as TOTAL_FROM_BARREL,
  resolveTraversalBudgets as resolveFromBarrel,
} from "../../../src/core/search/index.ts";

type Edge = {
  sourceDocumentId: number;
  relation: string;
  target: string;
  targetDocumentId: number | null;
};

/** Index a node list by document id. */
function byIdOf<T extends { documentId: number }>(nodes: T[]): Map<number, T> {
  return new Map(nodes.map((n) => [n.documentId, n]));
}

/** A fake store whose typed edges are a fixed adjacency list. */
function fakeStore(edges: Edge[]): RelationalFanoutStore {
  return {
    typedRelationEdgesForDocuments(ids) {
      const set = new Set(ids);
      return edges.filter((e) => set.has(e.sourceDocumentId));
    },
  };
}

test("fans out to depth 2 with hop counts and via-link-types", () => {
  // 1 -related-> 2 -extends-> 3 ; 1 -depends_on-> 4
  const store = fakeStore([
    { sourceDocumentId: 1, relation: "related", target: "b", targetDocumentId: 2 },
    { sourceDocumentId: 2, relation: "extends", target: "c", targetDocumentId: 3 },
    { sourceDocumentId: 1, relation: "depends_on", target: "d", targetDocumentId: 4 },
  ]);
  const nodes = relationalFanout(store, [1], { maxDepth: 2 });
  const byId = new Map(nodes.map((n) => [n.documentId, n]));
  expect(byId.get(2)!.hops).toBe(1);
  expect(byId.get(4)!.hops).toBe(1);
  expect(byId.get(3)!.hops).toBe(2);
  expect(byId.get(3)!.viaLinkTypes).toEqual(["extends"]);
  // Nearer nodes rank ahead of farther ones.
  expect(nodes[nodes.length - 1]!.documentId).toBe(3);
});

test("depth bound stops the walk (hop-3 nodes are not reached)", () => {
  const store = fakeStore([
    { sourceDocumentId: 1, relation: "related", target: "b", targetDocumentId: 2 },
    { sourceDocumentId: 2, relation: "related", target: "c", targetDocumentId: 3 },
    { sourceDocumentId: 3, relation: "related", target: "d", targetDocumentId: 4 },
  ]);
  const ids = relationalFanout(store, [1], { maxDepth: 2 }).map((n) => n.documentId);
  expect(ids).toEqual([2, 3]);
  expect(ids).not.toContain(4);
});

test("edge-type restriction traverses only the named relations", () => {
  const store = fakeStore([
    { sourceDocumentId: 1, relation: "related", target: "b", targetDocumentId: 2 },
    { sourceDocumentId: 1, relation: "contradicts", target: "c", targetDocumentId: 3 },
  ]);
  const ids = relationalFanout(store, [1], { edgeTypes: ["contradicts"] }).map((n) => n.documentId);
  expect(ids).toEqual([3]);
});

test("richness aggregates multiple edges reaching one node; seeds are excluded", () => {
  const store = fakeStore([
    { sourceDocumentId: 1, relation: "related", target: "c", targetDocumentId: 3 },
    { sourceDocumentId: 2, relation: "extends", target: "c", targetDocumentId: 3 },
  ]);
  const nodes = relationalFanout(store, [1, 2], { maxDepth: 1 });
  expect(nodes).toHaveLength(1);
  expect(nodes[0]!.documentId).toBe(3);
  expect(nodes[0]!.edgeRichness).toBe(2);
  expect(nodes[0]!.viaLinkTypes).toEqual(["extends", "related"]);
});

// ─── traversal budgets, hub skipping, deadline (truth-correctable-time-aware) ─

/** One typed edge `from -> to`, with the relation defaulting to `related`. */
function edge(from: number, to: number, relation = "related"): Edge {
  return { sourceDocumentId: from, relation, target: `doc-${to}`, targetDocumentId: to };
}

test("traversal budgets ship the planned defaults", () => {
  expect(TRAVERSAL_MAX_SEEDS).toBe(8);
  expect(TRAVERSAL_MAX_EXPANSION_PER_NODE).toBe(4);
  expect(TRAVERSAL_MAX_TOTAL_NODES).toBe(16);
  expect(TRAVERSAL_HUB_DEGREE_THRESHOLD).toBe(12);
});

test("the public search surface exposes the traversal budgets", () => {
  // The config/documentation surface names the knobs through the same
  // barrel every CLI and MCP consumer already imports - never a private
  // deep import into the search internals.
  expect(SEEDS_FROM_BARREL).toBe(TRAVERSAL_MAX_SEEDS);
  expect(EXPANSION_FROM_BARREL).toBe(TRAVERSAL_MAX_EXPANSION_PER_NODE);
  expect(TOTAL_FROM_BARREL).toBe(TRAVERSAL_MAX_TOTAL_NODES);
  expect(HUB_FROM_BARREL).toBe(TRAVERSAL_HUB_DEGREE_THRESHOLD);
  expect(resolveFromBarrel({ env: {} })).toEqual(resolveTraversalBudgets({ env: {} }));
});

test("resolveTraversalBudgets defaults to the shipped constants", () => {
  expect(resolveTraversalBudgets({ env: {} })).toEqual({
    maxSeeds: TRAVERSAL_MAX_SEEDS,
    maxExpansionPerNode: TRAVERSAL_MAX_EXPANSION_PER_NODE,
    maxTotalNodes: TRAVERSAL_MAX_TOTAL_NODES,
    hubDegreeThreshold: TRAVERSAL_HUB_DEGREE_THRESHOLD,
  });
});

test("resolveTraversalBudgets overrides from config and prefers env", () => {
  const config = {
    search_traversal_max_seeds: "3",
    search_traversal_max_expansion_per_node: "2",
    search_traversal_max_total_nodes: "9",
    search_traversal_hub_degree_threshold: "5",
  };
  expect(resolveTraversalBudgets({ env: {}, config })).toEqual({
    maxSeeds: 3,
    maxExpansionPerNode: 2,
    maxTotalNodes: 9,
    hubDegreeThreshold: 5,
  });
  const env = {
    [TRAVERSAL_MAX_SEEDS_ENV]: "5",
    [TRAVERSAL_MAX_EXPANSION_PER_NODE_ENV]: "1",
    [TRAVERSAL_MAX_TOTAL_NODES_ENV]: "7",
    [TRAVERSAL_HUB_DEGREE_THRESHOLD_ENV]: "20",
  };
  expect(resolveTraversalBudgets({ env, config })).toEqual({
    maxSeeds: 5,
    maxExpansionPerNode: 1,
    maxTotalNodes: 7,
    hubDegreeThreshold: 20,
  });
});

test("resolveTraversalBudgets refuses an out-of-range or non-integer override by name", () => {
  expect(() => resolveTraversalBudgets({ env: { [TRAVERSAL_MAX_SEEDS_ENV]: "0" } })).toThrow(
    SearchError,
  );
  expect(() => resolveTraversalBudgets({ env: { [TRAVERSAL_MAX_SEEDS_ENV]: "two" } })).toThrow(
    /OPEN_SECOND_BRAIN_SEARCH_TRAVERSAL_MAX_SEEDS/,
  );
  expect(() =>
    resolveTraversalBudgets({ config: { search_traversal_max_total_nodes: "-1" } }),
  ).toThrow(/search_traversal_max_total_nodes/);
});

test("the seed cap bounds the walk to the first TRAVERSAL_MAX_SEEDS seeds", () => {
  // Ten isolated seeds, each with one private neighbour below every cap.
  const edges: Edge[] = [];
  for (let s = 1; s <= 10; s++) edges.push(edge(s, 100 + s));
  const nodes = relationalFanout(fakeStore(edges), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], {
    maxDepth: 1,
  });
  expect(nodes.map((n) => n.documentId).toSorted((a, b) => a - b)).toEqual([
    101, 102, 103, 104, 105, 106, 107, 108,
  ]);
});

test("the per-node cap bounds expansion to the first edges of each node", () => {
  // Seed 1 declares six edges; only the first four may be followed.
  const edges = [1, 2, 3, 4, 5, 6].map((to) => edge(1, to));
  const nodes = relationalFanout(fakeStore(edges), [1], { maxDepth: 1 });
  expect(nodes.map((n) => n.documentId).toSorted((a, b) => a - b)).toEqual([1, 2, 3, 4]);
});

test("the total-node cap bounds the reached set", () => {
  // A per-node override lets one seed declare twenty children; the walk
  // still keeps only the first TRAVERSAL_MAX_TOTAL_NODES of them.
  const edges = Array.from({ length: 20 }, (_, i) => edge(1, i + 1));
  const nodes = relationalFanout(fakeStore(edges), [1], {
    maxDepth: 1,
    maxExpansionPerNode: 32,
  });
  expect(nodes).toHaveLength(TRAVERSAL_MAX_TOTAL_NODES);
  expect(nodes.map((n) => n.documentId)).toEqual([
    1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
  ]);
});

test("a node past the hub degree threshold is reached but not expanded", () => {
  // Seed 1 -> hub (13 edges, over the threshold) and -> plain (12 edges,
  // exactly at it). The hub's children stay unreached; the plain node's
  // are walked.
  const hub = 2;
  const plain = 3;
  const edges: Edge[] = [edge(1, hub), edge(1, plain)];
  for (let c = 0; c < 13; c++) edges.push(edge(hub, 100 + c));
  for (let c = 0; c < 12; c++) edges.push(edge(plain, 200 + c));
  const byId = new Map(
    relationalFanout(fakeStore(edges), [1], { maxDepth: 2 }).map((n) => [n.documentId, n]),
  );
  expect(byId.get(hub)!.hops).toBe(1);
  expect(byId.has(100)).toBe(false);
  expect(byId.has(200)).toBe(true);
});

test("a fired deadline abandons the frontier keeping the nodes already reached", () => {
  // 1 -> 2 -> 3, depth 2. The clock fires before the second round, so
  // the depth-1 node stays and the depth-2 node never appears.
  const store = fakeStore([edge(1, 2), edge(2, 3)]);
  let checks = 0;
  const nodes = relationalFanout(store, [1], {
    maxDepth: 2,
    isExpired: () => {
      checks += 1;
      return checks > 1;
    },
  });
  expect(nodes.map((n) => n.documentId)).toEqual([2]);
});

test("a deadline that is already fired abandons the walk before any expansion", () => {
  const store = fakeStore([edge(1, 2), edge(2, 3)]);
  const nodes = relationalFanout(store, [1], { maxDepth: 2, isExpired: () => true });
  expect(nodes).toEqual([]);
});

test("the walk is deterministic across repeated runs under the caps", () => {
  const edges: Edge[] = [];
  for (let s = 1; s <= 10; s++) {
    edges.push(edge(s, 100 + s));
    edges.push(edge(s, 200 + s, "extends"));
  }
  const store = fakeStore(edges);
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  const first = relationalFanout(store, seeds, { maxDepth: 2 });
  const second = relationalFanout(store, seeds, { maxDepth: 2 });
  expect(JSON.stringify(second)).toBe(JSON.stringify(first));
});

// ─── entity bridges from chunk_entities (truth-correctable-time-aware) ───────

/**
 * A fake store with typed edges plus an entity-bridge adjacency list.
 * `bridges` maps a source document id to the targets its entity set
 * bridges to, in the order the real reader returns them (target id asc).
 */
function bridgedStore(edges: Edge[], bridges: Map<number, number[]>): RelationalFanoutStore {
  return {
    typedRelationEdgesForDocuments(ids) {
      const set = new Set(ids);
      return edges.filter((e) => set.has(e.sourceDocumentId));
    },
    entityBridgesForDocuments(ids) {
      const out: Array<{ sourceDocumentId: number; targetDocumentId: number }> = [];
      for (const id of [...ids].toSorted((a, b) => a - b)) {
        for (const target of bridges.get(id) ?? [])
          out.push({ sourceDocumentId: id, targetDocumentId: target });
      }
      return out;
    },
  };
}

test("entity bridges walk as entity-labeled edges beside the typed edges", () => {
  // Seed 1: one typed edge to 2, one entity bridge to 3. Both are reached
  // at hop 1; the bridge node's link type is the `entity` label.
  const store = bridgedStore([edge(1, 2, "related")], new Map([[1, [3]]]));
  const byId = new Map(relationalFanout(store, [1], { maxDepth: 1 }).map((n) => [n.documentId, n]));
  expect(byId.get(2)!.viaLinkTypes).toEqual(["related"]);
  expect(byId.get(3)!.viaLinkTypes).toEqual(["entity"]);
  expect(byId.get(3)!.hops).toBe(1);
});

test("bridge edges count toward hub degree and consume the expansion budget", () => {
  // Node 2 is reached by one typed edge and carries 12 typed children plus
  // one bridge child: walked degree 13 exceeds the threshold, so none of
  // its children - bridge child included - are reached. Node 3 carries 12
  // typed children only, exactly at the threshold, and expands.
  const edges: Edge[] = [edge(1, 2), edge(1, 3)];
  for (let c = 0; c < 12; c++) edges.push(edge(2, 100 + c));
  for (let c = 0; c < 12; c++) edges.push(edge(3, 200 + c));
  const store = bridgedStore(edges, new Map([[2, [300]]]));
  const byId = new Map(relationalFanout(store, [1], { maxDepth: 2 }).map((n) => [n.documentId, n]));
  expect(byId.has(300)).toBe(false);
  expect(byId.has(200)).toBe(true);
  // The expansion cap spans both edge kinds: seed 1 has two typed edges
  // and two bridges with a per-node cap of 3, so only the first bridge
  // target is reached.
  const capped = bridgedStore([edge(1, 2), edge(1, 3)], new Map([[1, [4, 5]]]));
  const ids = relationalFanout(capped, [1], { maxDepth: 1, maxExpansionPerNode: 3 })
    .map((n) => n.documentId)
    .toSorted((a, b) => a - b);
  expect(ids).toEqual([2, 3, 4]);
});

test("bridge targets spend the total-node cap and a bridge may reach a seed id", () => {
  // Seed 1 with one typed edge (target 2) and bridges to 1..20: the total
  // cap admits the first TRAVERSAL_MAX_TOTAL_NODES walked targets in edge
  // order, and a bridge pointing back at the seed reaches it like any
  // target (the walk is over reached ids, seeds are entry points only).
  const store = bridgedStore([edge(1, 2)], new Map([[1, [1, 2, 3]]]));
  const nodes = relationalFanout(store, [1], { maxDepth: 1, maxExpansionPerNode: 32 });
  // Node 2 is reached twice (typed edge plus bridge) and outranks the
  // once-reached pair; the seed id 1 - reached only through the bridge -
  // surfaces among them.
  expect(nodes.map((n) => n.documentId)).toEqual([2, 1, 3]);
  expect(byIdOf(nodes).get(1)!.viaLinkTypes).toEqual(["entity"]);
});

test("an absent bridge reader leaves the walk byte-identical to the typed-only walk", () => {
  // The same typed fixture, walked once by a store without the reader and
  // once by a store whose reader answers empty: identical output, so the
  // pre-bridge walk is a strict special case.
  const edges: Edge[] = [edge(1, 2, "related"), edge(2, 3, "extends")];
  const without = relationalFanout(fakeStore(edges), [1], { maxDepth: 2 });
  const withEmpty = relationalFanout(bridgedStore(edges, new Map()), [1], { maxDepth: 2 });
  expect(JSON.stringify(withEmpty)).toBe(JSON.stringify(without));
});

// ─── the chunk_entities bridge reader (truth-correctable-time-aware) ─────────

import { Database } from "bun:sqlite";

import { entityBridgesForDocuments } from "../../../src/core/search/store/entity-bridges.ts";

/** Minimal `chunks` + `chunk_entities` fixture with the reader's join columns. */
function bridgeDb(): Database {
  const db = new Database(":memory:");
  db.run("CREATE TABLE chunks (id INTEGER PRIMARY KEY, document_id INTEGER NOT NULL)");
  db.run(
    "CREATE TABLE chunk_entities (" +
      "chunk_id INTEGER NOT NULL REFERENCES chunks(id) ON DELETE CASCADE, " +
      "entity TEXT NOT NULL, PRIMARY KEY (chunk_id, entity))",
  );
  return db;
}

function bridgeFixtures(db: Database, rows: Array<[chunkId: number, documentId: number]>): void {
  for (const [chunkId, documentId] of rows) {
    db.run("INSERT INTO chunks (id, document_id) VALUES (?, ?)", [chunkId, documentId]);
  }
}

function addEntities(db: Database, chunkId: number, entities: ReadonlyArray<string>): void {
  for (const e of entities)
    db.run("INSERT INTO chunk_entities (chunk_id, entity) VALUES (?, ?)", [chunkId, e]);
}

test("the bridge reader joins chunk_entities into deduplicated ordered pairs", () => {
  using db = bridgeDb();
  bridgeFixtures(db, [
    [1, 10],
    [2, 20],
    [3, 30],
    [4, 40],
  ]);
  // Docs 10 and 20 share TWO entities; doc 30 shares one with 10; doc 40
  // shares nothing.
  addEntities(db, 1, ["alpha", "beta"]);
  addEntities(db, 2, ["alpha", "beta"]);
  addEntities(db, 3, ["beta"]);
  addEntities(db, 4, ["gamma"]);
  expect(entityBridgesForDocuments(db, [10])).toEqual([
    { sourceDocumentId: 10, targetDocumentId: 20 },
    { sourceDocumentId: 10, targetDocumentId: 30 },
  ]);
  // Asking for both sources keeps the same per-source ordering.
  expect(entityBridgesForDocuments(db, [10, 20])).toEqual([
    { sourceDocumentId: 10, targetDocumentId: 20 },
    { sourceDocumentId: 10, targetDocumentId: 30 },
    { sourceDocumentId: 20, targetDocumentId: 10 },
    { sourceDocumentId: 20, targetDocumentId: 30 },
  ]);
});

test("the bridge reader excludes self pairs and answers empty input with empty", () => {
  using db = bridgeDb();
  bridgeFixtures(db, [
    [1, 10],
    [2, 10],
  ]);
  // Both chunks of document 10 carry the entity; no self pair may appear.
  addEntities(db, 1, ["alpha"]);
  addEntities(db, 2, ["alpha"]);
  expect(entityBridgesForDocuments(db, [10])).toEqual([]);
  expect(entityBridgesForDocuments(db, [])).toEqual([]);
});
