/**
 * Exact-declared-first entity ranking (write-honesty-egress-consent,
 * F3 / C3).
 *
 * Declared-form matches keep the existing entity boost lane unchanged;
 * derived person-variant matches get a strictly smaller capped lane in
 * their own right. Both layers are re-ranking only - the candidate set
 * is never widened here - and both are omitted from reasons and
 * breakdown when they do not fire, so a vault where no derived form
 * exists ranks byte-identically.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { indexVault, search } from "../../../src/core/search/index.ts";
import { makeConfig, createTempVault } from "../../helpers/search-fixtures.ts";
import { PERSON_NICKNAMES_ARTIFACT_REL } from "../../../src/core/search/entity-alias.ts";
import { rankResults } from "../../../src/core/search/ranker.ts";
import { upsertEntity } from "../../../src/core/brain/entities/registry.ts";
import type { KeywordHit, HydratedChunk } from "../../../src/core/search/store.ts";

const NOW = 1_750_000_000_000;

function hyd(chunkId: number, docId: number): HydratedChunk {
  return Object.freeze({
    chunkId,
    documentId: docId,
    path: `doc${docId}.md`,
    title: `Doc ${docId}`,
    content: `chunk ${chunkId}`,
    startLine: 1,
    endLine: 1,
    mtime: 0,
  });
}

function baseInputs() {
  return {
    keyword: [
      { chunkId: 1, documentId: 10, bm25: -5 },
      { chunkId: 2, documentId: 11, bm25: -5 },
      { chunkId: 3, documentId: 12, bm25: -5 },
    ] as KeywordHit[],
    semantic: [],
    hydrated: new Map([
      [1, hyd(1, 10)],
      [2, hyd(2, 11)],
      [3, hyd(3, 12)],
    ]),
    inboundLinkSources: new Map(),
    tagsByDoc: new Map(),
  };
}

const RANK_OPTS = { keywordWeight: 0.6, semanticWeight: 0.4, limit: 10, nowMs: NOW };

describe("derived entity ranking lane (unit)", () => {
  test("a declared-form match outranks an equal derived-variant match", () => {
    const ranked = rankResults(
      {
        ...baseInputs(),
        entityMatchByChunk: new Map([[1, 1]]),
        derivedEntityMatchByChunk: new Map([[2, 1]]),
      },
      RANK_OPTS,
    );
    const declared = ranked.find((r) => r.chunkId === 1)!;
    const derived = ranked.find((r) => r.chunkId === 2)!;
    expect(declared.score).toBeGreaterThan(derived.score);
    expect(declared.breakdown!.entity).toBe(0.02);
    expect(derived.breakdown!.entity).toBe(0);
    expect(derived.breakdown!.entityDerived).toBe(0.01);
    expect(derived.reasons).toContain("entity_variant: 0.010");
  });

  test("declared, neutral and derived-only candidates sort transitively", () => {
    // Three lanes, three scores: the composite score orders every pair
    // on its own, so the sort is a total order - the same for every
    // input permutation - with the declared/derived tier reserved for
    // exact ties.
    const inputsFor = (ids: number[]) => {
      const bm25 = new Map([
        [1, -1],
        [2, -9],
        [3, -5],
      ]);
      return {
        ...baseInputs(),
        keyword: ids.map(
          (id) => ({ chunkId: id, documentId: id * 10, bm25: bm25.get(id)! }) as KeywordHit,
        ),
        hydrated: new Map(ids.map((id) => [id, hyd(id, id * 10)])),
        entityMatchByChunk: new Map([[1, 1]]),
        derivedEntityMatchByChunk: new Map([[2, 1]]),
      };
    };
    const idsOf = (ranked: ReadonlyArray<{ chunkId: number }>) => ranked.map((r) => r.chunkId);
    const forward = idsOf(rankResults(inputsFor([1, 2, 3]), RANK_OPTS));
    const backward = idsOf(rankResults(inputsFor([3, 2, 1]), RANK_OPTS));
    expect(forward).toEqual(backward);
    // The derived-only chunk carries the best bm25, the neutral chunk
    // the middle one, and the declared chunk - whose boost cannot
    // rescue a much weaker base - the worst.
    expect(forward).toEqual([2, 3, 1]);
  });

  test("a derived-only chunk with the highest score stays first, and a low-scoring declared chunk does not jump ahead", () => {
    // The regression the tier-before-score comparator made inevitable on
    // both ends: the derived-only hit the feature exists for was sunk
    // below every neutral chunk (and off the limit cut), while any
    // single declared match floated above every higher-scoring chunk.
    const ranked = rankResults(
      {
        ...baseInputs(),
        keyword: [
          { chunkId: 1, documentId: 10, bm25: -9 },
          { chunkId: 2, documentId: 11, bm25: -5 },
          { chunkId: 3, documentId: 12, bm25: -1 },
        ] as KeywordHit[],
        hydrated: new Map([
          [1, hyd(1, 10)],
          [2, hyd(2, 11)],
          [3, hyd(3, 12)],
        ]),
        entityMatchByChunk: new Map([[3, 1]]),
        derivedEntityMatchByChunk: new Map([[1, 1]]),
      },
      RANK_OPTS,
    );
    // Score order end to end: the derived-only best match, then the
    // neutral middle, then the declared chunk whose weak base its boost
    // cannot lift.
    expect(ranked.map((r) => r.chunkId)).toEqual([1, 2, 3]);
  });

  test("the derived lane is capped strictly below the declared cap", () => {
    const ranked = rankResults(
      {
        ...baseInputs(),
        entityMatchByChunk: new Map([[1, 50]]),
        derivedEntityMatchByChunk: new Map([[2, 50]]),
      },
      RANK_OPTS,
    );
    const declared = ranked.find((r) => r.chunkId === 1)!;
    const derived = ranked.find((r) => r.chunkId === 2)!;
    expect(declared.breakdown!.entity).toBe(0.04);
    expect(derived.breakdown!.entityDerived).toBe(0.02);
    expect(derived.breakdown!.entityDerived).toBeLessThan(declared.breakdown!.entity);
  });

  test("a chunk matching both a declared and a derived form outranks either alone", () => {
    const ranked = rankResults(
      {
        ...baseInputs(),
        entityMatchByChunk: new Map([[1, 1]]),
        derivedEntityMatchByChunk: new Map([[1, 1]]),
      },
      RANK_OPTS,
    );
    const both = ranked.find((r) => r.chunkId === 1)!;
    expect(both.breakdown!.entity).toBe(0.02);
    expect(both.breakdown!.entityDerived).toBe(0.01);
  });

  test("a zero derived match omits the layer from breakdown and reasons", () => {
    const ranked = rankResults(
      {
        ...baseInputs(),
        entityMatchByChunk: new Map([[1, 1]]),
        derivedEntityMatchByChunk: new Map<number, number>(),
      },
      RANK_OPTS,
    );
    const one = ranked.find((r) => r.chunkId === 1)!;
    const other = ranked.find((r) => r.chunkId === 2)!;
    expect(one.breakdown).not.toHaveProperty("entityDerived");
    expect(other.breakdown).not.toHaveProperty("entityDerived");
    expect(one.reasons.some((x) => x.startsWith("entity_variant"))).toBe(false);
  });

  test("an absent derived map ranks byte-identically to a run without one", () => {
    const without = rankResults(
      { ...baseInputs(), entityMatchByChunk: new Map([[1, 2]]) },
      RANK_OPTS,
    );
    const withEmpty = rankResults(
      {
        ...baseInputs(),
        entityMatchByChunk: new Map([[1, 2]]),
        derivedEntityMatchByChunk: undefined,
      },
      RANK_OPTS,
    );
    expect(withEmpty.map((r) => r.score)).toEqual(without.map((r) => r.score));
  });

  test("one declared match against three derived matches: the score decides, the tier only breaks an exact tie", () => {
    // Identical base scores for both chunks. At entityMul 2 the declared
    // cap (0.04) tops the derived cap (0.02): declared first by score. At
    // entityMul 1 both lanes land on 0.02 - an exact tie the tier
    // break resolves toward declared. At entityMul 0.5 the three derived
    // matches (0.015) outweigh the one declared match (0.01): the
    // derived chunk is simply the higher-scoring one.
    for (const [entityMul, firstId] of [
      [2.0, 1],
      [1.0, 1],
      [0.5, 2],
    ] as const) {
      const ranked = rankResults(
        {
          ...baseInputs(),
          entityMatchByChunk: new Map([[1, 1]]),
          derivedEntityMatchByChunk: new Map([[2, 3]]),
        },
        {
          ...RANK_OPTS,
          weightProfile: { keywordMul: 1, semanticMul: 1, recencyMul: 1, entityMul },
        },
      );
      expect(ranked[0]!.chunkId).toBe(firstId);
    }
  });

  test("an exact score tie between a declared and a derived-only chunk resolves toward declared", () => {
    // One declared match and two derived matches both land on 0.02: an
    // exact tie the tier break is the only thing left to separate, and
    // it separates declared first.
    const inputs = {
      ...baseInputs(),
      entityMatchByChunk: new Map([[1, 1]]),
      derivedEntityMatchByChunk: new Map([[2, 2]]),
    };
    const ranked = rankResults(inputs, RANK_OPTS);
    expect(ranked[0]!.chunkId).toBe(1);
    expect(ranked[0]!.score).toBeCloseTo(ranked[1]!.score, 12);
  });
});

let tmp: ReturnType<typeof createTempVault>;

beforeEach(() => {
  tmp = createTempVault("entity-variant-rank");
});

afterEach(() => {
  tmp.cleanup();
});

describe("declared-before-derived ranking (end to end)", () => {
  test("a declared-form note outranks a derived-variant note for otherwise-equal candidates", async () => {
    upsertEntity(tmp.vault, {
      category: "people",
      name: "Robert Smith",
      agent: "claude-dev-agent",
      now: new Date("2026-06-02T12:00:00Z"),
    });
    mkdirSync(join(tmp.vault, "Brain", "entities"), { recursive: true });
    writeFileSync(
      join(tmp.vault, PERSON_NICKNAMES_ARTIFACT_REL),
      JSON.stringify({ bob: ["Robert Smith"] }),
    );
    mkdirSync(join(tmp.vault, "notes"), { recursive: true });
    // All three notes carry identical query-term frequencies and word
    // counts (13 words, each query token once), so BM25 ties exactly;
    // only the entity lanes separate them.
    writeFileSync(
      join(tmp.vault, "notes", "declared.md"),
      "---\ntitle: Declared\n---\n\nThe payment flow Bob runs through Robert Smith to pay more memory costs.\n",
    );
    writeFileSync(
      join(tmp.vault, "notes", "derived.md"),
      "---\ntitle: Derived\n---\n\nThe payment flow Bob runs through Smith Robert to pay more memory costs.\n",
    );
    writeFileSync(
      join(tmp.vault, "notes", "plain.md"),
      "---\ntitle: Plain\n---\n\nThe payment flow Bob runs through other second things to pay memory costs.\n",
    );
    // mmrLambda 1 disables diversity reordering, so the final array
    // order is the ranking's order.
    const config = makeConfig({ vault: tmp.vault, dbPath: tmp.dbPath, maxHops: 0, mmrLambda: 1 });
    await indexVault(config, {});

    const out = await search(config, { query: "payment pay memory Bob", limit: 10 });
    const at = (name: string): number =>
      out.results.findIndex((r) => r.path === `notes/${name}.md`);
    const declared = at("declared");
    const derived = at("derived");
    const plain = at("plain");
    expect(declared).toBeGreaterThanOrEqual(0);
    expect(derived).toBeGreaterThanOrEqual(0);
    expect(plain).toBeGreaterThanOrEqual(0);
    // Declared-form match first, derived-variant match second.
    expect(declared).toBeLessThan(derived);
    expect(derived).toBeLessThan(plain);
    // The derived note discloses both lanes; the declared note keeps its
    // unchanged single lane; the plain note reports no variant layer.
    const derivedRow = out.results[derived]!;
    expect(derivedRow.breakdown?.entity).toBe(0.02);
    expect(derivedRow.breakdown?.entityDerived).toBe(0.01);
    expect(derivedRow.reasons).toContain("entity_variant: 0.010");
    const declaredRow = out.results[declared]!;
    expect(declaredRow.breakdown?.entity).toBe(0.04);
    expect(declaredRow.breakdown).not.toHaveProperty("entityDerived");
    const plainRow = out.results[plain]!;
    expect(plainRow.breakdown).not.toHaveProperty("entityDerived");
    expect(plainRow.reasons.some((x) => x.startsWith("entity_variant"))).toBe(false);
  });
});
