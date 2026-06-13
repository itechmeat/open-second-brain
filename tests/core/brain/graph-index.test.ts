/**
 * Precomputed link-graph side-index (Unit 4 of the Vault Integrity &
 * Trust suite).
 *
 * detectCommunities and the graph stats surface both rebuilt the resolved
 * undirected adjacency from scratch on every call (an O(n) SQL + map
 * build). getGraphSnapshot computes that structure once and memoizes it
 * on the Store, keyed on the monotonic index revision, so repeat reads
 * are O(1) and a reindex correctly invalidates the cache.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { getGraphSnapshot, graphStats } from "../../../src/core/brain/link-graph/graph-index.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { makeConfig } from "../../helpers/search-fixtures.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";

let vault: string;
let config: ResolvedSearchConfig;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-graph-index-"));
  mkdirSync(join(vault, "Brain"), { recursive: true });
  config = makeConfig({ vault, dbPath: join(vault, "index.sqlite") });
});
afterEach(() => {
  rmSync(vault, { recursive: true, force: true });
});

const link = (targets: string[]) => targets.map((t) => `[[${t}]]`).join(" and ");

/** One 4-clique (a,b,c,d) plus an isolated note with no links. */
function writeClique(): void {
  const clique = ["a", "b", "c", "d"];
  for (const name of clique) {
    const others = clique.filter((g) => g !== name);
    writeFileSync(join(vault, `${name}.md`), `# ${name}\n\nSee ${link(others)}.\n`);
  }
  writeFileSync(join(vault, "loner.md"), "# Loner\n\nNo links.\n");
}

describe("getGraphSnapshot", () => {
  test("builds the undirected adjacency of the resolved link graph", async () => {
    writeClique();
    await indexVault(config);
    const store = await Store.open(config, { mode: "read" });
    try {
      const snap = getGraphSnapshot(store);
      // 5 documents total, 4 of them in the link graph (loner excluded).
      expect(snap.pathById.size).toBe(5);
      expect(snap.nodesSorted.length).toBe(4);
      // Every clique member links to the other three.
      for (const id of snap.nodesSorted) {
        expect(snap.degree.get(id)).toBe(3);
      }
      // A 4-clique has 6 undirected edges.
      expect(snap.edgeCount).toBe(6);
      // adjacency is symmetric.
      for (const [node, neighbours] of snap.adjacency) {
        for (const n of neighbours) {
          expect(snap.adjacency.get(n)?.has(node)).toBe(true);
        }
      }
    } finally {
      await store.close();
    }
  });

  test("memoizes: same store + same revision returns the identical object", async () => {
    writeClique();
    await indexVault(config);
    const store = await Store.open(config, { mode: "read" });
    try {
      const a = getGraphSnapshot(store);
      const b = getGraphSnapshot(store);
      expect(b).toBe(a); // reference identity - not rebuilt
    } finally {
      await store.close();
    }
  });

  test("invalidates when the index revision changes", async () => {
    writeClique();
    await indexVault(config);
    const store = await Store.open(config, { mode: "write" });
    try {
      const before = getGraphSnapshot(store);
      store.bumpIndexRevision();
      const after = getGraphSnapshot(store);
      expect(after).not.toBe(before); // rebuilt against the new revision
      expect(after.revision).toBe(before.revision + 1);
    } finally {
      await store.close();
    }
  });
});

describe("graphStats", () => {
  test("reports node/edge counts and top-degree nodes from the snapshot", async () => {
    writeClique();
    await indexVault(config);
    const store = await Store.open(config, { mode: "read" });
    try {
      const stats = graphStats(store, { top: 2 });
      expect(stats.documentCount).toBe(5);
      expect(stats.nodeCount).toBe(4); // nodes with >= 1 edge
      expect(stats.edgeCount).toBe(6);
      expect(stats.topByDegree).toHaveLength(2);
      for (const entry of stats.topByDegree) {
        expect(entry.degree).toBe(3);
      }
      // deterministic order: degree desc, then path asc
      expect(stats.topByDegree[0]!.path <= stats.topByDegree[1]!.path).toBe(true);
    } finally {
      await store.close();
    }
  });
});
