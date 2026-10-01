/**
 * Metadata-boost lexical-vote gate (t_d9f863e9): the opt-in
 * `search_metadata_boost_gate` config key makes every additive
 * metadata/structural boost layer contribute exactly ZERO when the keyword
 * lane returned no hits for the query - the BM25 result set is empty before
 * boosts, so no lexical vote was cast and a vector-only answer must not be
 * floated by layers calibrated over a lexical candidate set.
 *
 * Pinned here:
 *   - the gate is a PRE-boost predicate over `inputs.keyword` (the pre-boost
 *     keyword input the ranker already receives): zero hits = no vote;
 *   - gated layers contribute exactly zero (not damped), and the receipts
 *     say so - a `gated: no lexical vote` reason entry and a structured
 *     `gate` breakdown naming the layers actually suppressed;
 *   - the pinned layer is NOT gated: it is a bounded signal over explicit
 *     operator state, always-on by its own design decision;
 *   - a query with at least one keyword hit leaves every boost fully
 *     intact, and the gate off keeps today's behavior byte-identical;
 *   - both guard keys resolve off by default through `resolveSearchConfig`.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { rankResults } from "../../../src/core/search/ranker.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import type { HydratedChunk, SemanticHit } from "../../../src/core/search/store.ts";
import type { RankerInputs, RankerOptions } from "../../../src/core/search/ranker.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Ranker layer
// ─────────────────────────────────────────────────────────────────────────────

const NOW = 1_750_000_000_000; // ms
const FRESH_MTIME = NOW / 1000 - 60; // inside the decay band → full recency amplitude
const OLD_MTIME = NOW / 1000 - 365 * 24 * 3600; // past the decay band → exactly 0 recency

function hyd(chunkId: number, docId: number, mtime: number): HydratedChunk {
  return Object.freeze({
    chunkId,
    documentId: docId,
    path: `doc${docId}.md`,
    title: `Doc ${docId}`,
    content: `chunk ${chunkId}`,
    startLine: 1,
    endLine: 1,
    mtime,
  });
}

/**
 * Two vector-only candidates (empty keyword lane) wired with EVERY gated
 * metadata layer: a fresh mtime (recency), an in-pool inbound link, a
 * shared-tag-free link companion, two query-entity matches, activation, a
 * co-access companion in the pool, observed reuse, and a declared temporal
 * window under a dedicated test. With the gate off these fire exactly as
 * today; with the gate on and no lexical vote, every one of them must
 * contribute zero.
 */
function vectorOnlyInputs(): RankerInputs {
  const semantic: SemanticHit[] = [
    { chunkId: 1, documentId: 10, distance: 0.2 },
    { chunkId: 2, documentId: 99, distance: 0.3 },
  ];
  return {
    keyword: [],
    semantic,
    hydrated: new Map<number, HydratedChunk>([
      [1, hyd(1, 10, FRESH_MTIME)],
      [2, hyd(2, 99, OLD_MTIME)],
    ]),
    inboundLinkSources: new Map<number, ReadonlySet<number>>([[1, new Set([99])]]),
    tagsByDoc: new Map<number, ReadonlySet<string>>([[1, new Set(["ops"])]]),
    entityMatchByChunk: new Map<number, number>([[1, 2]]),
    activationByChunk: new Map<number, number>([[1, 1]]),
    coAccessByChunk: new Map<number, ReadonlyMap<number, number>>([
      [1, new Map<number, number>([[99, 4]])],
    ]),
    reuseRateByChunk: new Map<number, number>([[1, 1]]),
    eventTimeMsByChunk: new Map<number, number>([[1, NOW - 86_400_000]]),
  };
}

const BASE_OPTS: RankerOptions = {
  keywordWeight: 0.6,
  semanticWeight: 0.4,
  limit: 10,
  nowMs: NOW,
};

test("gate off (default) leaves every boost intact and writes no gate receipt", () => {
  // The option ABSENT is the off state: the layers fire at full amplitude
  // and no gate breakdown appears. The gate's byte-identity when a vote IS
  // cast is owned by the one-keyword-hit test below.
  const ungated = rankResults(vectorOnlyInputs(), BASE_OPTS);
  expect(ungated[0]!.breakdown!.gate).toBeUndefined();
  // The metadata layers actually fired: the gated runs have something to gate.
  expect(ungated[0]!.breakdown!.recency).toBeGreaterThan(0);
  expect(ungated[0]!.breakdown!.entity).toBeGreaterThan(0);
});

test("gate on + no lexical vote: every gated layer contributes exactly zero", () => {
  const gated = rankResults(vectorOnlyInputs(), { ...BASE_OPTS, metadataBoostGate: true });
  const b = gated[0]!.breakdown!;
  expect(b.keyword).toBe(0);
  expect(b.link).toBe(0);
  expect(b.recency).toBe(0);
  expect(b.entity).toBe(0);
  expect(b.activation).toBe(0);
  expect(b.coAccess).toBe(0);
  expect(b.reuse).toBe(0);
  expect(b.sessionFocus).toBe(0);
  // The semantic relevance term is untouched - only the boost layers gate.
  expect(b.semantic).toBeGreaterThan(0);
});

test("a gated query that declared a window reports the temporal layer as zero", () => {
  const gated = rankResults(vectorOnlyInputs(), {
    ...BASE_OPTS,
    metadataBoostGate: true,
    temporalIntent: {
      range: { sinceMs: NOW - 86_400_000, untilMs: NOW },
      historical: false,
      recencyDamping: 1,
      signature: "test-window",
    },
  });
  const b = gated[0]!.breakdown!;
  // The query declared a window, so the layer is present - gated to zero,
  // not absent: absence is the no-window statement.
  expect(b.temporal).toBe(0);
  expect(b.recency).toBe(0);
  expect(b.gate!.suppressedLayers).toContain("temporal");
});

test("gate on + no lexical vote: the receipts say why", () => {
  const gated = rankResults(vectorOnlyInputs(), { ...BASE_OPTS, metadataBoostGate: true });
  const gate = gated[0]!.breakdown!.gate!;
  expect(gate.active).toBe(true);
  expect(gate.lexicalVote).toBe(false);
  // Every layer whose raw contribution was nonzero is named as suppressed.
  // The temporal layer needs a declared window; a dedicated test covers it.
  expect(gate.suppressedLayers).toContain("link");
  expect(gate.suppressedLayers).toContain("recency");
  expect(gate.suppressedLayers).toContain("entity");
  expect(gate.suppressedLayers).toContain("activation");
  expect(gate.suppressedLayers).toContain("coAccess");
  expect(gate.suppressedLayers).toContain("reuse");
  expect(gated[0]!.reasons.some((r) => r.startsWith("gated: no lexical vote"))).toBe(true);
});

test("a gated vector-only query ranks identically to boost-free ranking", () => {
  const gated = rankResults(vectorOnlyInputs(), { ...BASE_OPTS, metadataBoostGate: true });
  // Boost-free: the same relevance inputs with every signal map removed
  // and an mtime past the decay band, where the freshness prior floors to
  // exactly zero - the score the semantic term alone produces.
  const bare = rankResults(
    {
      keyword: [],
      semantic: [{ chunkId: 1, documentId: 10, distance: 0.2 }],
      hydrated: new Map<number, HydratedChunk>([[1, hyd(1, 10, OLD_MTIME)]]),
      inboundLinkSources: new Map(),
      tagsByDoc: new Map(),
    },
    BASE_OPTS,
  );
  expect(gated[0]!.score).toBeCloseTo(bare[0]!.score, 12);
});

test("the pinned layer is not gated", () => {
  const inputs = {
    ...vectorOnlyInputs(),
    pinnedDocIds: new Set<number>([10]),
  };
  const gated = rankResults(inputs, { ...BASE_OPTS, metadataBoostGate: true });
  const b = gated[0]!.breakdown!;
  expect(b.pinned).toBeGreaterThan(0);
  expect(b.gate!.suppressedLayers).not.toContain("pinned");
});

test("one keyword hit leaves every boost fully intact", () => {
  const inputs: RankerInputs = {
    ...vectorOnlyInputs(),
    keyword: [{ chunkId: 1, documentId: 10, bm25: -2 }],
  };
  const gateOn = rankResults(inputs, { ...BASE_OPTS, metadataBoostGate: true });
  const gateOff = rankResults(inputs, BASE_OPTS);
  expect(gateOn.map((r) => r.score)).toEqual(gateOff.map((r) => r.score));
  expect(gateOn[0]!.reasons).toEqual(gateOff[0]!.reasons);
  const gate = gateOn[0]!.breakdown!.gate!;
  expect(gate.active).toBe(false);
  expect(gate.lexicalVote).toBe(true);
  expect(gate.suppressedLayers).toEqual([]);
  // The boost layers actually fired under the cast vote.
  expect(gateOn[0]!.breakdown!.recency).toBeGreaterThan(0);
});

// ─────────────────────────────────────────────────────────────────────────────
// Config resolution (default off; the key follows search_relational_arm_enabled)
// ─────────────────────────────────────────────────────────────────────────────

let tmp: string;
let configPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-boost-gate-"));
  configPath = join(tmp, "config.yaml");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("search_metadata_boost_gate resolves, default off", () => {
  writeFileSync(configPath, `vault: ${tmp}\n`);
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.recall.metadataBoostGateEnabled).toBe(false);
});

test("search_metadata_boost_gate: true resolves onto the recall config", () => {
  writeFileSync(configPath, `vault: ${tmp}\nsearch_metadata_boost_gate: true\n`);
  const cfg = resolveSearchConfig({ vault: tmp, configPath });
  expect(cfg.recall.metadataBoostGateEnabled).toBe(true);
});
