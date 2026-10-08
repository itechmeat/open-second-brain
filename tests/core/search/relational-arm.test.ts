/**
 * Typed-edge relational retrieval arm (t_09b7ccea): a relationship-shaped
 * query surfaces related nodes via a bounded typed-edge fan-out when the arm
 * is enabled in rrf fusion; the arm is byte-identical when off (default).
 */

import { test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

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
import { TRAVERSAL_MAX_SEEDS_ENV } from "../../../src/core/search/relational-fanout.ts";

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
  // The refusal names the key ACTUALLY in force: a machine-config value
  // gone bad names the config key, never the env key that lost the
  // precedence race.
  let configRefusal = "";
  try {
    resolveEntityBridgesEnabled({ env: {}, config: { [ENTITY_BRIDGES_CONFIG]: "maybe" } });
  } catch (e) {
    configRefusal = (e as Error).message;
  }
  expect(configRefusal).toContain(ENTITY_BRIDGES_CONFIG);
  expect(configRefusal).not.toContain(ENTITY_BRIDGES_ENV);
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

test("a malformed traversal knob value does not fail a non-relational query", () => {
  // The config-file re-read and the budget/bridge resolution run only
  // once the arm knows it will walk: a non-relational query pays no knob
  // resolution, so a malformed knob value fails no search the knob
  // cannot affect - and still refuses the relational query it governs.
  const store = armFixtureStore({ docs: { seed: 1, near: 2 }, typed: [[1, "related", 2]] });
  const prior = process.env[TRAVERSAL_MAX_SEEDS_ENV];
  process.env[TRAVERSAL_MAX_SEEDS_ENV] = "maybe";
  try {
    expect(() => runRelationalArm(store, vault, "alpha topic", {})).not.toThrow();
    expect(() => runRelationalArm(store, vault, "[[seed]] related", {})).toThrow(SearchError);
  } finally {
    if (prior === undefined) delete process.env[TRAVERSAL_MAX_SEEDS_ENV];
    else process.env[TRAVERSAL_MAX_SEEDS_ENV] = prior;
  }
});

// ─── the search call site threads the arm's runtime options (wiring) ─────────
//
// The integrator's pins: the composite recall deadline and the caller's
// transport reach actually reach the arm in production, the real Store
// carries the bridge reader the arm's flag enables, and the arm's gated
// paths land in the retrieval trail. Every pin holds an arm-off mirror so
// the off shape stays byte-identical.

import { Store } from "../../../src/core/search/store.ts";
import { TRANSPORT_REACH } from "../../../src/core/graph/transport-reach.ts";
import { RETRIEVAL_DEGRADATION } from "../../../src/core/search/retrieval-trail.ts";
import { startFakeHttp, type FakeRequest, type FakeResponseSpec } from "../../helpers/fake-http.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";

test("the search call site gates the arm's ordered paths at the caller's reach", async () => {
  await build();
  // The middle node reserves itself against remote reads; the far node is
  // readable there. Only a call site that hands the reach to the arm can
  // withhold the middle hop from the far row's provenance.
  writeMd(
    vault,
    "neighbor.md",
    '---\nvisibility: ["private"]\nextends: "[[far]]"\n---\n\nbeta divergent content.',
  );
  await indexVault(makeConfig({ vault, dbPath }));
  const cfg = makeConfig({ vault, dbPath, fusionMode: "rrf", relationalArmEnabled: true });
  const remote = await search(cfg, {
    query: "alpha [[seed]] related extends",
    transportReach: TRANSPORT_REACH.remote,
  });
  const far = remote.results.find((r) => r.path === "far.md");
  expect(far).toBeDefined();
  // The relational reason names the walk but never a withheld count: the
  // unreadable middle hop is already absent from the provenance path.
  expect(far!.reasons.some((x) => x.startsWith("relational: via "))).toBe(true);
  expect(far!.reasons.some((x) => x.includes("withheld"))).toBe(false);
  // Local reach reads every hop: the same walk withholds nothing, and
  // the reason shape is the same either way.
  const local = await search(cfg, { query: "alpha [[seed]] related extends" });
  const farLocal = local.results.find((r) => r.path === "far.md");
  expect(farLocal).toBeDefined();
  expect(farLocal!.reasons.some((x) => x.startsWith("relational: via "))).toBe(true);
  expect(farLocal!.reasons.some((x) => x.includes("withheld"))).toBe(false);
});

test("the arm's ordered paths land in the retrieval trail and stay absent when the arm is off", async () => {
  await build();
  const cfgOn = makeConfig({ vault, dbPath, fusionMode: "rrf", relationalArmEnabled: true });
  const on = await search(cfgOn, { query: "alpha [[seed]] related" });
  const entries = on.retrievalTrail?.relationalPaths;
  expect(entries).toBeDefined();
  expect(entries!.length).toBeGreaterThan(0);
  for (const entry of entries!) {
    expect(entry.code).toBe("relational-path");
    expect("withheld" in entry).toBe(false);
    expect(entry.path.length).toBeGreaterThan(0);
  }
  // Arm off: no paths on the trail, whatever else the answer carries -
  // the pre-change trail shape, byte for byte.
  const cfgOff = makeConfig({ vault, dbPath, fusionMode: "rrf" });
  const off = await search(cfgOff, { query: "alpha [[seed]] related" });
  expect(off.retrievalTrail?.relationalPaths).toBeUndefined();
  expect("relationalPaths" in (off.retrievalTrail ?? {})).toBe(false);
});

test("the search call site threads the composite deadline into the arm's walk", async () => {
  if (!sqliteVecLoadable()) return;
  await build();
  const server = await startFakeHttp();
  try {
    const cfg = {
      ...makeConfig({
        vault,
        dbPath,
        fusionMode: "rrf",
        relationalArmEnabled: true,
        semantic: {
          enabled: true,
          provider: "openai-compat",
          baseUrl: server.url,
          model: "fake-model",
          apiKey: FAKE_PROVIDER_KEY,
          dimension: 4,
          timeoutMs: 5_000,
          concurrency: 2,
          batchSize: 8,
          costGateUsd: 0,
          maxRetries: 1,
        },
      }),
      hybridDeadlineMs: 300,
    };
    await indexVault(cfg, { embeddings: true });
    // A semantic lane that never answers: the composite clock fires on its
    // timer at the budget, deterministically before the arm runs, so the
    // arm's first clock check sees a fired deadline and abandons the walk.
    server.setHandler(() => new Promise<never>(() => {}));
    const cut = await search(cfg, { query: "alpha [[seed]] related extends", semantic: true });
    const codes = cut.retrievalTrail?.degraded.map((d) => d.code) ?? [];
    expect(codes).toContain(RETRIEVAL_DEGRADATION.hybridDeadlineExceeded);
    expect(cut.results.some((r) => r.path === "far.md")).toBe(false);
    // The same query with the deadline off (0) runs the walk: the two-hop
    // node the fired clock withheld is surfaced. The handler answers the
    // embed request with the same deterministic vectors the helper's
    // default serves, so only the clock differs between the two runs.
    server.setHandler((req: FakeRequest): FakeResponseSpec => {
      if (req.path.endsWith("/embeddings") && req.method === "POST") {
        const body = (req.body ?? {}) as { input?: string[]; model?: string };
        const inputs = Array.isArray(body.input) ? body.input : [];
        return {
          status: 200,
          body: {
            data: inputs.map((text, index) => ({
              object: "embedding",
              embedding: [text.split(/\s+/).filter(Boolean).length, index, text.length, 1],
              index,
            })),
            model: body.model ?? "fake-model",
          },
        };
      }
      return { status: 404, body: { error: "not_found" } };
    });
    const unbounded = await search(
      { ...cfg, hybridDeadlineMs: 0 },
      {
        query: "alpha [[seed]] related extends",
        semantic: true,
      },
    );
    expect(unbounded.results.some((r) => r.path === "far.md")).toBe(true);
  } finally {
    await server.close();
  }
});

test("the real store carries the bridge reader and the arm walks it live", async () => {
  await build();
  const store = await Store.open(makeConfig({ vault, dbPath }), { mode: "write", loadVec: false });
  try {
    const seedId = store.getDocumentIdByPath("seed.md");
    const noiseId = store.getDocumentIdByPath("noise.md");
    expect(seedId).not.toBeNull();
    expect(noiseId).not.toBeNull();
    const seedChunk = store.representativeChunks([seedId!]).get(seedId!)!;
    const noiseChunk = store.representativeChunks([noiseId!]).get(noiseId!)!;
    store.replaceEntities(seedChunk.chunkId, ["shared-entity"]);
    store.replaceEntities(noiseChunk.chunkId, ["shared-entity"]);
    // The typed surface answers the deduplicated ordered pair, and the
    // arm's store view picks the reader up from it: bridges on walks the
    // co-occurrence edge beside the typed one; bridges off never reaches
    // the bridged document.
    expect(store.entityBridgesForDocuments([seedId!])).toEqual([
      { sourceDocumentId: seedId!, targetDocumentId: noiseId! },
    ]);
    const on = runRelationalArm(store, vault, "[[seed]] related", { entityBridges: true });
    expect(on.reachByChunk.get(noiseChunk.chunkId)?.via).toEqual(["entity"]);
    const off = runRelationalArm(store, vault, "[[seed]] related", { entityBridges: false });
    expect(off.reachByChunk.has(noiseChunk.chunkId)).toBe(false);
  } finally {
    await store.close();
  }
});

test("the arm's knobs resolve from the caller's config path, not the default file", async () => {
  await build();
  // A config file at a non-default path turning bridges off: the arm
  // must consult the path its caller threaded (the resolved search
  // config carries it), and consult no file at all when none is
  // threaded - never a fresh read of the default config path.
  const configPath = join(vault, "arm-config.yaml");
  writeFileSync(configPath, "search_entity_bridges_enabled: false\n");
  const store = await Store.open(makeConfig({ vault, dbPath }), { mode: "write", loadVec: false });
  try {
    const seedId = store.getDocumentIdByPath("seed.md");
    const noiseId = store.getDocumentIdByPath("noise.md");
    const seedChunk = store.representativeChunks([seedId!]).get(seedId!)!;
    const noiseChunk = store.representativeChunks([noiseId!]).get(noiseId!)!;
    store.replaceEntities(seedChunk.chunkId, ["shared-entity"]);
    store.replaceEntities(noiseChunk.chunkId, ["shared-entity"]);
    // The threaded path's off switch governs the walk.
    const threaded = runRelationalArm(store, vault, "[[seed]] related", { configPath });
    expect(threaded.reachByChunk.has(noiseChunk.chunkId)).toBe(false);
    // No threaded path resolves env-only: the file is not consulted and
    // the bridges default (on) applies.
    const unthreaded = runRelationalArm(store, vault, "[[seed]] related", {});
    expect(unthreaded.reachByChunk.get(noiseChunk.chunkId)?.via).toEqual(["entity"]);
  } finally {
    await store.close();
  }
});
