import { test, expect } from "bun:test";

import {
  relationalFanout,
  type RelationalFanoutStore,
} from "../../../src/core/search/relational-fanout.ts";

type Edge = {
  sourceDocumentId: number;
  relation: string;
  target: string;
  targetDocumentId: number | null;
};

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
