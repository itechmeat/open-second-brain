/**
 * Typed-edge relational retrieval arm (t_09b7ccea): a relationship-shaped
 * query surfaces related nodes via a bounded typed-edge fan-out when the arm
 * is enabled in rrf fusion; the arm is byte-identical when off (default).
 */

import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const project = (o: Awaited<ReturnType<typeof search>>) =>
  o.results.map((r) => ({ path: r.path, score: r.score, reasons: r.reasons }));

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("relational-arm");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

async function build() {
  // seed --related--> neighbor --extends--> far
  writeMd(vault, "seed.md", '---\nrelated: "[[neighbor]]"\n---\n\nalpha topic seed document.');
  writeMd(vault, "neighbor.md", '---\nextends: "[[far]]"\n---\n\nbeta divergent content.');
  writeMd(vault, "far.md", "# Far\n\ngamma distant content.");
  writeMd(vault, "noise.md", "# Noise\n\ndelta irrelevant content.");
  await indexVault(makeConfig({ vault, dbPath }));
}

test("relationship query surfaces the related node with attribution (arm on, rrf)", async () => {
  await build();
  const cfg = makeConfig({ vault, dbPath, fusionMode: "rrf", relationalArmEnabled: true });
  const outcome = await search(cfg, { query: "alpha [[seed]] related" });
  const neighbor = outcome.results.find((r) => r.path === "neighbor.md");
  expect(neighbor).toBeDefined();
  expect(neighbor!.reasons.some((x) => x.startsWith("relational:"))).toBe(true);
});

test("depth-2 fan-out reaches a two-hop node when its edge type is named", async () => {
  await build();
  const cfg = makeConfig({ vault, dbPath, fusionMode: "rrf", relationalArmEnabled: true });
  const outcome = await search(cfg, { query: "alpha [[seed]] related extends" });
  expect(outcome.results.some((r) => r.path === "far.md")).toBe(true);
});

test("arm off (default) does not surface the related node (byte-identical)", async () => {
  await build();
  const cfgOff = makeConfig({ vault, dbPath, fusionMode: "rrf" });
  const outcome = await search(cfgOff, { query: "alpha [[seed]] related" });
  expect(outcome.results.some((r) => r.path === "neighbor.md")).toBe(false);
});

test("arm off (default) is byte-identical to arm on (rrf) except arm-attributable entries", async () => {
  await build();
  const cfgOff = makeConfig({ vault, dbPath, fusionMode: "rrf" });
  const cfgOn = makeConfig({ vault, dbPath, fusionMode: "rrf", relationalArmEnabled: true });
  // Freeze the clock across both calls: recency decay is a continuous
  // function of wall-clock time, so two real Date.now() reads even a
  // millisecond apart would perturb the low-order digits of `score` for
  // reasons that have nothing to do with the relational arm under test.
  const nowMs = Date.now();
  const dateNowSpy = spyOn(Date, "now").mockReturnValue(nowMs);
  try {
    const off = await search(cfgOff, { query: "alpha [[seed]] related" });
    const on = await search(cfgOn, { query: "alpha [[seed]] related" });
    // Strip out only the entries the arm itself attributes (its "relational:"
    // reason), then require the FULL projection of what remains - paths,
    // scores, reasons, and order - to equal the arm-off run exactly.
    const onMinusArm = on.results
      .filter((r) => !r.reasons.some((x) => x.startsWith("relational:")))
      .map((r) => ({ path: r.path, score: r.score, reasons: r.reasons }));
    expect(onMinusArm).toEqual(project(off));
  } finally {
    dateNowSpy.mockRestore();
  }
});

test("relationalArmEnabled under a non-rrf fusion mode is byte-identical to flag-off (gate requires rrf)", async () => {
  await build();
  const cfgOff = makeConfig({ vault, dbPath, fusionMode: "linear" });
  const cfgOnLinear = makeConfig({
    vault,
    dbPath,
    fusionMode: "linear",
    relationalArmEnabled: true,
  });
  const nowMs = Date.now();
  const dateNowSpy = spyOn(Date, "now").mockReturnValue(nowMs);
  try {
    const off = await search(cfgOff, { query: "alpha [[seed]] related" });
    const onLinear = await search(cfgOnLinear, { query: "alpha [[seed]] related" });
    expect(project(onLinear)).toEqual(project(off));
  } finally {
    dateNowSpy.mockRestore();
  }
});

test("a non-relational query is byte-identical between arm on and off (rrf)", async () => {
  await build();
  const cfgOff = makeConfig({ vault, dbPath, fusionMode: "rrf" });
  const cfgOn = makeConfig({ vault, dbPath, fusionMode: "rrf", relationalArmEnabled: true });
  const off = await search(cfgOff, { query: "alpha topic" });
  const on = await search(cfgOn, { query: "alpha topic" });
  expect(project(on)).toEqual(project(off));
});

// ─── entity bridges and arm runtime options (truth-correctable-time-aware) ───

import { Database } from "bun:sqlite";

import {
  ENTITY_BRIDGES_CONFIG,
  ENTITY_BRIDGES_ENV,
  resolveEntityBridgesEnabled,
  runRelationalArm,
} from "../../../src/core/search/pipeline/relational-arm.ts";
import { SearchError } from "../../../src/core/search/search-error.ts";
import type { TraversalBudgets } from "../../../src/core/search/relational-fanout.ts";

test("entity bridges resolve on by default and follow env over config", () => {
  expect(resolveEntityBridgesEnabled({ env: {} })).toBe(true);
  expect(
    resolveEntityBridgesEnabled({ env: {}, config: { [ENTITY_BRIDGES_CONFIG]: "false" } }),
  ).toBe(false);
  expect(
    resolveEntityBridgesEnabled({
      env: { [ENTITY_BRIDGES_ENV]: "true" },
      config: { [ENTITY_BRIDGES_CONFIG]: "false" },
    }),
  ).toBe(true);
  expect(() => resolveEntityBridgesEnabled({ env: { [ENTITY_BRIDGES_ENV]: "maybe" } })).toThrow(
    SearchError,
  );
  expect(() => resolveEntityBridgesEnabled({ env: { [ENTITY_BRIDGES_ENV]: "maybe" } })).toThrow(
    new RegExp(ENTITY_BRIDGES_ENV),
  );
});

/** The slice of Store the arm needs, with typed edges plus optional bridges. */
function armFixtureStore(opts: {
  docs: Record<string, number>;
  typed: Array<[from: number, relation: string, to: number]>;
  bridges?: Map<number, number[]>;
  withReader?: boolean;
}): Store {
  const byId = new Map(Object.entries(opts.docs).map(([name, id]) => [id, `${name}.md`]));
  return {
    getDocumentIdByPath(path: string) {
      for (const [id, p] of byId) if (p === path) return id;
      return null;
    },
    documentTitles() {
      return new Map([...byId].map(([id, path]) => [id, { path, title: null }]));
    },
    typedRelationEdgesForDocuments(ids: ReadonlyArray<number>) {
      const set = new Set(ids);
      return opts.typed
        .filter(([from]) => set.has(from))
        .map(([from, relation, to]) => ({
          sourceDocumentId: from,
          relation,
          target: byId.get(to) ?? "",
          targetDocumentId: to,
        }));
    },
    ...(opts.withReader
      ? {
          entityBridgesForDocuments(ids: ReadonlyArray<number>) {
            const out: Array<{ sourceDocumentId: number; targetDocumentId: number }> = [];
            for (const id of ids) {
              for (const target of opts.bridges?.get(id) ?? []) {
                out.push({ sourceDocumentId: id, targetDocumentId: target });
              }
            }
            return out;
          },
        }
      : {}),
    representativeChunks(ids: ReadonlyArray<number>) {
      const out = new Map();
      for (const id of ids) {
        const path = byId.get(id);
        if (path === undefined) continue;
        out.set(id, {
          chunkId: id,
          documentId: id,
          path,
          title: null,
          content: "",
          startLine: 1,
          endLine: 1,
          mtime: 0,
        });
      }
      return out;
    },
  } as unknown as Store;
}

test("the arm walks entity bridges only when the flag is on", () => {
  // The per-test vault from beforeEach; the arm's own vocabulary falls
  // back to the default relation vocabulary for an unreadable schema pack.
  // seed --related--> typed ; seed ~entity~> bridged
  const shared = { seed: 1, typed: 2, bridged: 3 };
  const store = armFixtureStore({
    docs: shared,
    typed: [[1, "related", 2]],
    bridges: new Map([[1, [3]]]),
    withReader: true,
  });
  const on = runRelationalArm(store, vault, "[[seed]] related", { entityBridges: true });
  expect(on.reachByChunk.get(3)?.via).toEqual(["entity"]);
  const off = runRelationalArm(store, vault, "[[seed]] related", { entityBridges: false });
  expect(off.reachByChunk.has(3)).toBe(false);
  // Flag off is byte-identical to a store with no bridge reader at all.
  const bare = armFixtureStore({ docs: shared, typed: [[1, "related", 2]] });
  const bareRun = runRelationalArm(bare, vault, "[[seed]] related", {});
  expect(JSON.stringify(off)).toBe(JSON.stringify(bareRun));
});

test("the arm threads the traversal budgets and the deadline into the walk", () => {
  const store = armFixtureStore({
    docs: { seed: 1, near: 2, far: 3 },
    typed: [
      [1, "related", 2],
      [2, "related", 3],
    ],
  });
  const budgets: TraversalBudgets = {
    maxSeeds: 8,
    maxExpansionPerNode: 4,
    maxTotalNodes: 1,
    hubDegreeThreshold: 12,
  };
  const capped = runRelationalArm(store, vault, "[[seed]] related", { budgets });
  expect([...capped.reachByChunk.keys()]).toEqual([2]);
  const expired = runRelationalArm(store, vault, "[[seed]] related", { isExpired: () => true });
  expect(expired.rankedChunkIds).toEqual([]);
});
