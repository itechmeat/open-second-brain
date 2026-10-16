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

import {
  ENTITY_BRIDGES_CONFIG,
  ENTITY_BRIDGES_ENV,
  RELATIONAL_ARM_REFUSAL_REASON,
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

// ─── edge-level eligibility adjuster (session-mining-economy, t_05a0eaa4) ───
//
// Each walked node and its arriving edge are classified from the same
// controlled-vocabulary frontmatter signals the page gate reads, plus the
// validity window at query time and the relation-polarity vocabulary.
// Under enforce an ineligible edge is removed from the arm's contribution
// set; under shadow it is counted only. Refusals carry named structural
// reason tokens and are reported per lane into the receipts' refusal
// record - distinct from `excluded` and from the arm's identical-to-absent
// provenance convention: a refusal is counted, a provenance omission is
// not reported.

import { ENTITY_CONTAMINATION_FRONTMATTER_KEY } from "../../../src/core/brain/truth/contamination.ts";
import { RETRIEVAL_TRUST_REFUSAL_LANE } from "../../../src/core/brain/trust/retrieval-receipts.ts";
import type { RelationalArmOutcome } from "../../../src/core/search/pipeline/relational-arm.ts";

/** A config file naming the gate mode, at a path the arm can be handed. */
function modeConfigPath(mode: "shadow" | "enforce"): string {
  const path = join(vault, `arm-mode-${mode}.yaml`);
  writeFileSync(path, `search_trust_gate_mode: ${mode}\n`);
  return path;
}

function refusalPaths(outcome: RelationalArmOutcome): string[] {
  return (outcome.refusals ?? []).map((r) => r.path);
}

test("enforce removes an ineligible walked node from the arm's contribution set", () => {
  writeMd(vault, "seed.md", '---\nrelated: "[[dirty]]"\n---\n\nalpha topic seed document.');
  writeMd(
    vault,
    "dirty.md",
    `---\n${ENTITY_CONTAMINATION_FRONTMATTER_KEY}: true\n---\n\nbeta contaminated content.`,
  );
  const store = armFixtureStore({ docs: { seed: 1, dirty: 2 }, typed: [[1, "related", 2]] });
  const outcome = runRelationalArm(store, vault, "[[seed]] related", {
    configPath: modeConfigPath("enforce"),
  });
  // Removed from the contribution set: no chunk, no provenance.
  expect(outcome.rankedChunkIds).toEqual([]);
  expect(outcome.reachByChunk.size).toBe(0);
  // And counted, with the named structural reason, on the arm's lane.
  expect(outcome.refusals).toEqual([
    {
      document_id: 2,
      chunk_id: 2,
      path: "dirty.md",
      reasons: [`relational_arm:${RELATIONAL_ARM_REFUSAL_REASON.entityContamination}`],
      lane: RETRIEVAL_TRUST_REFUSAL_LANE.arm,
    },
  ]);
});

test("shadow counts the same refusal but keeps the contribution", () => {
  writeMd(vault, "seed.md", '---\nrelated: "[[dirty]]"\n---\n\nalpha topic seed document.');
  writeMd(
    vault,
    "dirty.md",
    `---\n${ENTITY_CONTAMINATION_FRONTMATTER_KEY}: true\n---\n\nbeta contaminated content.`,
  );
  const store = armFixtureStore({ docs: { seed: 1, dirty: 2 }, typed: [[1, "related", 2]] });
  const outcome = runRelationalArm(store, vault, "[[seed]] related", {
    configPath: modeConfigPath("shadow"),
  });
  expect(outcome.rankedChunkIds).toEqual([2]);
  expect(outcome.reachByChunk.get(2)?.via).toEqual(["related"]);
  expect(outcome.refusals).toEqual([
    {
      document_id: 2,
      chunk_id: 2,
      path: "dirty.md",
      reasons: [`relational_arm:${RELATIONAL_ARM_REFUSAL_REASON.entityContamination}`],
      lane: RETRIEVAL_TRUST_REFUSAL_LANE.arm,
    },
  ]);
});

test("mode off leaves the outcome shape byte-identical and reports nothing", () => {
  writeMd(vault, "seed.md", '---\nrelated: "[[dirty]]"\n---\n\nalpha topic seed document.');
  writeMd(
    vault,
    "dirty.md",
    `---\n${ENTITY_CONTAMINATION_FRONTMATTER_KEY}: true\n---\n\nbeta contaminated content.`,
  );
  const store = armFixtureStore({ docs: { seed: 1, dirty: 2 }, typed: [[1, "related", 2]] });
  const outcome = runRelationalArm(store, vault, "[[seed]] related", {});
  expect(outcome.rankedChunkIds).toEqual([2]);
  // No refusals key at all - not an empty placeholder - so the serialized
  // outcome is byte-identical to the pre-adjuster one.
  expect("refusals" in outcome).toBe(false);
  expect(JSON.stringify(outcome)).not.toContain("refusals");
});

test("a validity window not covering query time is refused with its own token", () => {
  writeMd(
    vault,
    "seed.md",
    '---\nrelated: "[[closed]]"\nextends: "[[pending]]"\n---\n\nalpha seed.',
  );
  writeMd(vault, "closed.md", '---\nvalid_until: "2000-01-01"\n---\n\nbeta closed-window content.');
  writeMd(
    vault,
    "pending.md",
    '---\nvalid_from: "2999-01-01"\n---\n\ngamma pending-window content.',
  );
  const store = armFixtureStore({
    docs: { seed: 1, closed: 2, pending: 3 },
    typed: [
      [1, "related", 2],
      [1, "extends", 3],
    ],
  });
  const outcome = runRelationalArm(store, vault, "[[seed]] related extends", {
    configPath: modeConfigPath("enforce"),
  });
  expect(outcome.rankedChunkIds).toEqual([]);
  expect(refusalPaths(outcome).toSorted()).toEqual(["closed.md", "pending.md"]);
  const byPath = new Map((outcome.refusals ?? []).map((r) => [r.path, r]));
  expect(byPath.get("closed.md")?.reasons).toEqual([
    `relational_arm:${RELATIONAL_ARM_REFUSAL_REASON.closedValidityWindow}`,
  ]);
  expect(byPath.get("pending.md")?.reasons).toEqual([
    `relational_arm:${RELATIONAL_ARM_REFUSAL_REASON.pendingValidityWindow}`,
  ]);
});

test("an unparseable declared window is refused where a current one passes", () => {
  const configPath = modeConfigPath("enforce");
  // A window whose inclusive end is still ahead covers query time: pass.
  writeMd(vault, "seed.md", '---\nrelated: "[[open]]"\n---\n\nalpha seed.');
  writeMd(vault, "open.md", '---\nvalid_until: "2999-01-01"\n---\n\nbeta still valid.');
  const openStore = armFixtureStore({ docs: { seed: 1, open: 2 }, typed: [[1, "related", 2]] });
  const current = runRelationalArm(openStore, vault, "[[seed]] related", { configPath });
  expect(current.rankedChunkIds).toEqual([2]);
  expect(current.refusals).toEqual([]);

  // A DECLARED value that cannot be parsed is a structural refusal, never
  // a silent pass: the window cannot be honored.
  writeMd(vault, "seed2.md", '---\nrelated: "[[garbled]]"\n---\n\nalpha seed two.');
  writeMd(vault, "garbled.md", "---\nvalid_until: not-a-date\n---\n\ngamma garbled window.");
  const garbledStore = armFixtureStore({
    docs: { seed2: 3, garbled: 4 },
    typed: [[3, "related", 4]],
  });
  const garbled = runRelationalArm(garbledStore, vault, "[[seed2]] related", { configPath });
  expect(refusalPaths(garbled)).toEqual(["garbled.md"]);
  expect(garbled.refusals?.[0]?.reasons).toEqual([
    `relational_arm:${RELATIONAL_ARM_REFUSAL_REASON.invalidValidityWindow}`,
  ]);
});

test("a contradicts edge the query named is answered, not refused", () => {
  // `[[seed]] contradicts` asks for exactly the contradicting pages:
  // counting the polarity against the relation the query named would
  // empty the answer under enforce and inflate every shadow measurement.
  writeMd(vault, "seed.md", '---\ncontradicts: "[[rival]]"\n---\n\nalpha seed.');
  writeMd(vault, "rival.md", "# Rival\n\nbeta contradictory content.");
  const store = armFixtureStore({ docs: { seed: 1, rival: 2 }, typed: [[1, "contradicts", 2]] });
  const outcome = runRelationalArm(store, vault, "[[seed]] contradicts", {
    configPath: modeConfigPath("enforce"),
  });
  expect(outcome.rankedChunkIds).toEqual([2]);
  expect(outcome.refusals).toEqual([]);
});

test("a chain through an ineligible node refuses the downstream arrival too", () => {
  writeMd(vault, "seed.md", '---\nrelated: "[[mid]]"\n---\n\nalpha topic seed document.');
  writeMd(
    vault,
    "mid.md",
    '---\nstatus: quarantine\nextends: "[[far]]"\n---\n\nbeta quarantined mid.',
  );
  writeMd(vault, "far.md", "# Far\n\ngamma downstream content.");
  const store = armFixtureStore({
    docs: { seed: 1, mid: 2, far: 3 },
    typed: [
      [1, "related", 2],
      [2, "extends", 3],
    ],
  });
  const outcome = runRelationalArm(store, vault, "[[seed]] related extends", {
    configPath: modeConfigPath("enforce"),
  });
  expect(outcome.rankedChunkIds).toEqual([]);
  expect(refusalPaths(outcome).toSorted()).toEqual(["far.md", "mid.md"]);
  // The far node's own frontmatter is clean: its refusal is the arrived
  // edge's source endpoint failing the same signals.
  const far = (outcome.refusals ?? []).find((r) => r.path === "far.md");
  expect(far?.reasons).toEqual(["relational_arm:self_approval_quarantine"]);
});

test("shadow counts a whole ineligible chain while the contributions stand", () => {
  writeMd(vault, "seed.md", '---\nrelated: "[[mid]]"\n---\n\nalpha topic seed document.');
  writeMd(
    vault,
    "mid.md",
    '---\nstatus: quarantine\nextends: "[[far]]"\n---\n\nbeta quarantined mid.',
  );
  writeMd(vault, "far.md", "# Far\n\ngamma downstream content.");
  const store = armFixtureStore({
    docs: { seed: 1, mid: 2, far: 3 },
    typed: [
      [1, "related", 2],
      [2, "extends", 3],
    ],
  });
  const outcome = runRelationalArm(store, vault, "[[seed]] related extends", {
    configPath: modeConfigPath("shadow"),
  });
  expect(outcome.rankedChunkIds.toSorted()).toEqual([2, 3]);
  expect(refusalPaths(outcome).toSorted()).toEqual(["far.md", "mid.md"]);
});

test("a provenance omission is not a refusal: reach gating stays identical-to-absent", () => {
  writeMd(vault, "seed.md", '---\nrelated: "[[mid]]"\n---\n\nalpha topic seed document.');
  writeMd(
    vault,
    "mid.md",
    '---\nvisibility: ["private"]\nextends: "[[far]]"\n---\n\nbeta private-but-clean mid.',
  );
  writeMd(vault, "far.md", "# Far\n\ngamma downstream content.");
  const store = armFixtureStore({
    docs: { seed: 1, mid: 2, far: 3 },
    typed: [
      [1, "related", 2],
      [2, "extends", 3],
    ],
  });
  const outcome = runRelationalArm(store, vault, "[[seed]] related extends", {
    configPath: modeConfigPath("enforce"),
    reach: TRANSPORT_REACH.remote,
  });
  // The walk still reaches both nodes - visibility gates the ordered
  // provenance path only - and the withheld step reports nothing.
  expect(outcome.rankedChunkIds.toSorted()).toEqual([2, 3]);
  expect(outcome.refusals).toEqual([]);
  const farReach = outcome.reachByChunk.get(3);
  expect(farReach).toBeDefined();
  // The far node's provenance path omits the unreadable-at-reach mid hop
  // without naming or counting it.
  expect(farReach!.path.some((step) => step.documentId === 2)).toBe(false);
});

test("a withheld quarantined arrival is receipted identically to its absence", () => {
  // The walked node is BOTH quarantined and reserved against remote
  // reads: the row-level filters withhold its row, so a refusal record
  // naming it would hand a caller the path, the ids and a structural
  // fact about a page it cannot read. The receipts must read exactly as
  // they would had the page never existed.
  writeMd(vault, "seed.md", '---\nrelated: "[[secret]]"\n---\n\nalpha topic seed document.');
  writeMd(
    vault,
    "secret.md",
    '---\nstatus: quarantine\nvisibility: ["private"]\n---\n\nbeta secret content.',
  );
  const store = armFixtureStore({ docs: { seed: 1, secret: 2 }, typed: [[1, "related", 2]] });
  const present = runRelationalArm(store, vault, "[[seed]] related", {
    configPath: modeConfigPath("shadow"),
    reach: TRANSPORT_REACH.remote,
  });
  expect(present.refusals).toEqual([]);
  expect(JSON.stringify(present)).not.toContain("secret.md");
  // The same walk over a store where the node does not exist refuses
  // nothing, and the refusal records are the same bytes.
  const absent = runRelationalArm(
    armFixtureStore({ docs: { seed: 1 }, typed: [] }),
    vault,
    "[[seed]] related",
    {
      configPath: modeConfigPath("shadow"),
      reach: TRANSPORT_REACH.remote,
    },
  );
  expect(JSON.stringify(present.refusals)).toBe(JSON.stringify(absent.refusals));
});

test("a withheld source page's signals ride no readable node's refusal", () => {
  // The far node's own frontmatter is clean; its refusal reasons come
  // entirely from the quarantined page the walk crossed - and that page
  // is reserved against the caller's reach. Naming far would disclose
  // mid's marker status, so mid contributes no reasons to any record.
  writeMd(vault, "seed.md", '---\nrelated: "[[mid]]"\n---\n\nalpha topic seed document.');
  writeMd(
    vault,
    "mid.md",
    '---\nstatus: quarantine\nvisibility: ["private"]\nextends: "[[far]]"\n---\n\nbeta hidden mid.',
  );
  writeMd(vault, "far.md", "# Far\n\ngamma downstream content.");
  const store = armFixtureStore({
    docs: { seed: 1, mid: 2, far: 3 },
    typed: [
      [1, "related", 2],
      [2, "extends", 3],
    ],
  });
  const shadow = runRelationalArm(store, vault, "[[seed]] related extends", {
    configPath: modeConfigPath("shadow"),
    reach: TRANSPORT_REACH.remote,
  });
  // Seeds are not walked nodes; both reached nodes still contribute under
  // shadow, and no refusal names anything about the withheld page.
  expect(shadow.rankedChunkIds.toSorted()).toEqual([2, 3]);
  expect(refusalPaths(shadow)).toEqual([]);
  // Enforce keeps the full excluding verdict - the drops stay, only the
  // records disappear.
  const enforced = runRelationalArm(store, vault, "[[seed]] related extends", {
    configPath: modeConfigPath("enforce"),
    reach: TRANSPORT_REACH.remote,
  });
  expect(enforced.rankedChunkIds).toEqual([]);
  expect(refusalPaths(enforced)).toEqual([]);
});

test("a malformed mode value fails only the relational query the gate governs", () => {
  writeMd(vault, "seed.md", '---\nrelated: "[[near]]"\n---\n\nalpha topic seed document.');
  writeMd(vault, "near.md", "# Near\n\nbeta content.");
  const store = armFixtureStore({ docs: { seed: 1, near: 2 }, typed: [[1, "related", 2]] });
  const configPath = join(vault, "arm-mode-bad.yaml");
  writeFileSync(configPath, "search_trust_gate_mode: measure\n");
  expect(() => runRelationalArm(store, vault, "alpha topic", { configPath })).not.toThrow();
  let message = "";
  try {
    runRelationalArm(store, vault, "[[seed]] related", { configPath });
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain("search_trust_gate_mode");
});

test("the eligibility gate does not run when the arm does not walk", () => {
  // Non-relational query: no walk, no knob resolution, no refusals.
  writeMd(vault, "seed.md", "# Seed\n\nalpha topic.");
  const store = armFixtureStore({ docs: { seed: 1 }, typed: [] });
  const outcome = runRelationalArm(store, vault, "alpha topic", {
    configPath: modeConfigPath("enforce"),
  });
  expect(outcome.rankedChunkIds).toEqual([]);
  expect("refusals" in outcome).toBe(false);
});

test("the effective config's trust-gate mode reaches the arm, not a fresh machine-config read", async () => {
  // The arm's only route to `stale.md` is the walk: its body shares no
  // keyword terms with the query. Its closed validity window is a reason
  // only the edge gate reads, so the page gate cannot stand in for it.
  // The machine config says off; the effective config (as a bench pin
  // would override it) names the mode, and the arm must follow it.
  writeMd(vault, "seed.md", '---\nrelated: "[[stale]]"\n---\n\nalpha topic seed document.');
  writeMd(vault, "stale.md", "---\nvalid_until: 2000-01-01\n---\n\nbeta divergent content.");
  await indexVault(makeConfig({ vault, dbPath }));
  const configPath = join(vault, "arm-gate.yaml");
  writeFileSync(configPath, "search_trust_gate_mode: off\n");
  const cfgFor = (mode: "shadow" | "enforce") => ({
    ...makeConfig({
      vault,
      dbPath,
      fusionMode: "rrf",
      relationalArmEnabled: true,
      searchTrustGateMode: mode,
    }),
    configPath,
  });

  const enforced = await search(cfgFor("enforce"), { query: "alpha [[seed]] related" });
  expect(enforced.results.some((r) => r.path === "stale.md")).toBe(false);

  const shadowed = await search(cfgFor("shadow"), { query: "alpha [[seed]] related" });
  const stale = shadowed.results.find((r) => r.path === "stale.md");
  expect(stale).toBeDefined();
  expect(stale!.reasons.some((x) => x.startsWith("relational:"))).toBe(true);
});
