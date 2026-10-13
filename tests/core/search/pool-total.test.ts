/**
 * `SearchOutcome.total` is the pre-truncation ranked pool size
 * (what-the-index-already-knew, task F).
 *
 * Before this unit `total` was assigned the length of the returned array,
 * so it carried no information at all: a caller could not tell "the vault
 * holds three matches" from "the vault holds thirty and you were handed
 * three". The pool the final `limit` slice cuts from is a property of the
 * answer, not a diagnostic, so it is reported inline on every outcome.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { Store } from "../../../src/core/search/store.ts";
import { assembleRankedResults } from "../../../src/core/search/pipeline/assemble.ts";
import { collectCandidateSignals } from "../../../src/core/search/pipeline/candidate-signals.ts";
import {
  RETRIEVAL_DEGRADATION,
  type RetrievalDegradation,
} from "../../../src/core/search/retrieval-trail.ts";
import type { ResolvedRecallConfig, ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import type { KeywordHit } from "../../../src/core/search/store.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

/** Matching notes, comfortably above the `limit` the queries below use. */
const MATCHING_NOTES = 12;
const LIMIT = 3;

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(async () => {
  ({ vault, dbPath, cleanup } = createTempVault("pool-total"));
  for (let i = 0; i < MATCHING_NOTES; i += 1) {
    writeMd(
      vault,
      `notes/note-${i}.md`,
      `---\ntitle: Note ${i}\n---\n\n# Note ${i}\n\nThe widget calibration routine number ${i}.\n`,
    );
  }
  await indexVault(makeConfig({ vault, dbPath, maxHops: 0 }), {});
});

afterEach(() => cleanup());

function config() {
  return makeConfig({ vault, dbPath, maxHops: 0 });
}

test("total is the ranked pool the limit slice cut from, not the row count", async () => {
  const out = await search(config(), { query: "widget calibration", limit: LIMIT });

  expect(out.results.length).toBe(LIMIT);
  expect(out.total).toBeGreaterThan(out.results.length);
  // The pool is the candidate set retrieval actually ranked, which is
  // widened past `limit` but still bounded by the lane fetch - so it is a
  // lower bound on the corpus matches, never an over-count.
  expect(out.total).toBeLessThanOrEqual(MATCHING_NOTES);
});

test("a limit wider than the pool reports the pool, so total never exceeds the corpus", async () => {
  const out = await search(config(), { query: "widget calibration", limit: MATCHING_NOTES + 5 });

  expect(out.results.length).toBe(MATCHING_NOTES);
  expect(out.total).toBe(MATCHING_NOTES);
});

test("cards disclosure reports the same pool as the full path", async () => {
  const full = await search(config(), { query: "widget calibration", limit: LIMIT });
  const cards = await search(config(), {
    query: "widget calibration",
    limit: LIMIT,
    disclosure: "cards",
  });

  expect(cards.cards!.length).toBe(LIMIT);
  expect(cards.total).toBe(full.total);
  expect(cards.total).toBeGreaterThan(cards.cards!.length);
});

test("a query with no candidates still reports zero", async () => {
  const out = await search(config(), { query: "zzzznonexistentterm", limit: LIMIT });

  expect(out.results).toEqual([]);
  expect(out.total).toBe(0);
});

// ── per-source-session pool cap (t_bb6ce095) ─────────────────────────────────

/** One recall patch over the harness config, the way trail tests patch it. */
function withRecall(
  base: ResolvedSearchConfig,
  patch: Partial<ResolvedRecallConfig>,
): ResolvedSearchConfig {
  return Object.freeze({ ...base, recall: Object.freeze({ ...base.recall, ...patch }) });
}

/** The crowded fixture: six hot notes in one source session, three elsewhere. */
const CROWDED_HOT_NOTES = 6;
const CROWDED_QUERY = "widget calibration";

function writeCrowdedVault(vaultDir: string): void {
  for (let i = 0; i < CROWDED_HOT_NOTES; i += 1) {
    writeMd(
      vaultDir,
      `a-${i}.md`,
      `---\ntitle: Crowded ${i}\nsession_ref: sess-a\n---\n\n# Crowded ${i}\n\n` +
        `The widget calibration routine number ${i}. Widget calibration is repeated here. ` +
        `Widget calibration matters to this note.\n`,
    );
  }
  for (const session of ["b", "c", "d"]) {
    writeMd(
      vaultDir,
      `${session}.md`,
      `---\ntitle: Other ${session}\nsession_ref: sess-${session}\n---\n\n# Other ${session}\n\n` +
        `The widget calibration routine of session ${session}.\n`,
    );
  }
}

/** A clock-free fixture config: the recency layer is amplitude zero. */
async function indexedCrowdedVault() {
  const v = createTempVault("pool-cap-crowded");
  writeCrowdedVault(v.vault);
  const cold = withRecall(
    makeConfig({ vault: v.vault, dbPath: v.dbPath, maxHops: 0, mmrLambda: 1 }),
    {
      recencyAmplitude: 0,
    },
  );
  await indexVault(cold, {});
  return { ...v, cold };
}

function degradationOf(
  out: { readonly retrievalTrail?: { readonly degraded: ReadonlyArray<RetrievalDegradation> } },
  code: string,
): RetrievalDegradation | undefined {
  return out.retrievalTrail?.degraded.find((d) => d.code === code);
}

test("the cap off returns today's crowded order byte-for-byte", async () => {
  const v = await indexedCrowdedVault();
  try {
    const off = await search(v.cold, { query: CROWDED_QUERY, limit: LIMIT });
    const explicitOff = await search(withRecall(v.cold, { poolMaxPerSession: 0 }), {
      query: CROWDED_QUERY,
      limit: LIMIT,
    });

    // The off path is the pre-knob pipeline: an explicit 0 answers with
    // the default's exact bytes.
    expect(JSON.stringify(explicitOff)).toBe(JSON.stringify(off));
    // And that behavior is the crowding the cap exists to relieve: every
    // window slot went to one source session.
    expect(off.results.map((r) => r.path)).toEqual(
      off.results.map((r) => r.path).filter((p) => p.startsWith("a-")),
    );
    expect(off.results.length).toBe(LIMIT);
  } finally {
    v.cleanup();
  }
});

test("the cap on spreads the window across sessions and names its drop", async () => {
  const v = await indexedCrowdedVault();
  try {
    const on = await search(withRecall(v.cold, { poolMaxPerSession: 2 }), {
      query: CROWDED_QUERY,
      limit: LIMIT,
    });

    expect(on.results.length).toBe(LIMIT);
    // Two crowded-session rows keep the top slots; the rest of the window
    // reaches other sessions.
    expect(on.results[0]?.path).toBe("a-0.md");
    expect(on.results.some((r) => !r.path.startsWith("a-"))).toBe(true);
    const entry = degradationOf(on, RETRIEVAL_DEGRADATION.sourceSessionCappedRows);
    expect(entry?.detail).toEqual({ dropped: 4, cap: 2 });
  } finally {
    v.cleanup();
  }
});

test("a vault with no session identity ranks identically with the cap on", async () => {
  // The module fixture holds ordinary notes only - no session_ref, no
  // session_id - so the cap is on but has nothing to group.
  const cold = withRecall(config(), { recencyAmplitude: 0 });
  const off = await search(cold, { query: "widget calibration", limit: LIMIT });
  const on = await search(withRecall(cold, { poolMaxPerSession: 2 }), {
    query: "widget calibration",
    limit: LIMIT,
  });

  expect(JSON.stringify(on)).toBe(JSON.stringify(off));
  expect(on.retrievalTrail).toBeUndefined();
});

test("the cap is final: one wide pass, never a second assemble on its drops", async () => {
  // Forty matching notes in ONE session: the window cannot fill (cap 2,
  // limit 3), which is exactly where a wrong backfill trigger would fire
  // a second, wider assemble. `dropped` pins the pass width: 30 rows were
  // ranked (the widened rankLimit), 2 survived, 28 were dropped - a
  // second pass at the 50-wide backfill cap would report 48.
  const v = createTempVault("pool-cap-final");
  try {
    for (let i = 0; i < 40; i += 1) {
      writeMd(
        v.vault,
        `solo-${i}.md`,
        `---\ntitle: Solo ${i}\nsession_ref: sess-a\n---\n\n# Solo ${i}\n\n` +
          `The widget calibration routine number ${i}.\n`,
      );
    }
    const cold = withRecall(
      makeConfig({ vault: v.vault, dbPath: v.dbPath, maxHops: 0, mmrLambda: 1 }),
      { recencyAmplitude: 0, poolMultiplier: 20, poolMaxPerSession: 2 },
    );
    await indexVault(cold, {});

    const out = await search(cold, { query: CROWDED_QUERY, limit: LIMIT });

    expect(out.results.length).toBe(2);
    const entry = degradationOf(out, RETRIEVAL_DEGRADATION.sourceSessionCappedRows);
    expect(entry?.detail).toEqual({ dropped: 28, cap: 2 });
    // Once per answer, even beside the rank-cap code the same pass earns.
    const capNotes = out.retrievalTrail?.degraded.filter(
      (d) => d.code === RETRIEVAL_DEGRADATION.sourceSessionCappedRows,
    );
    expect(capNotes).toHaveLength(1);
  } finally {
    v.cleanup();
  }
});

test("the cap on joins the widening so a cross-encoder query keeps its topK pool", async () => {
  // Thirty rows of one session ranked ahead of ten of another. With the
  // cap active and the cross-encoder asking for a 40-wide pool, the
  // widened rankLimit ranks past the crowded session: the second
  // session's deep rows are in the pool the reader step draws from. A
  // composition that lost the topK term would rank only the crowded
  // session's top 30, and the cap would leave nothing else. Driven
  // through `assembleRankedResults` directly - the cross-encoder call
  // itself runs after this stage, so no endpoint is involved.
  const v = createTempVault("pool-cap-widen");
  try {
    for (let i = 0; i < 30; i += 1) {
      writeMd(
        v.vault,
        `a-${i}.md`,
        `---\ntitle: Wide ${i}\nsession_ref: sess-a\n---\n\n# Wide ${i}\n\nalpha beta gamma ${i}.\n`,
      );
    }
    for (let i = 0; i < 10; i += 1) {
      writeMd(
        v.vault,
        `b-${i}.md`,
        `---\ntitle: Deep ${i}\nsession_ref: sess-b\n---\n\n# Deep ${i}\n\nalpha beta gamma deep ${i}.\n`,
      );
    }
    const base = makeConfig({
      vault: v.vault,
      dbPath: v.dbPath,
      maxHops: 0,
      mmrLambda: 1,
      intentEnabled: false,
    });
    const cfg = withRecall(base, {
      recencyAmplitude: 0,
      poolMaxPerSession: 2,
    });
    const rerankCfg = Object.freeze({
      ...cfg,
      rerank: Object.freeze({ ...cfg.rerank, enabled: true, topK: 40 }),
    });
    await indexVault(rerankCfg, {});

    const store = await Store.open(rerankCfg, { mode: "read" });
    try {
      const documents = store.listDocuments();
      const chunkIdFor = (path: string): number => {
        const doc = documents.get(path);
        if (doc === undefined) throw new Error(`fixture document missing from index: ${path}`);
        const first = store.chunksForDocument(doc.id)[0];
        if (first === undefined) throw new Error(`fixture document has no chunk: ${path}`);
        return first.id;
      };
      const paths = [...documents.keys()].toSorted();
      const ids = paths.map(chunkIdFor);
      const hydrated = store.hydrateChunks(ids);
      // Every crowded row outranks every deep row: bm25 is more negative
      // for the crowded session, which ranks first.
      const keywordHits: KeywordHit[] = paths.map((path, at) => ({
        chunkId: ids[at]!,
        documentId: hydrated.get(ids[at]!)!.documentId,
        bm25: path.startsWith("a-") ? -(5 + at / 100) : -1,
      }));
      const frontmatterCache = new Map();
      const signals = collectCandidateSignals({
        store,
        config: rerankCfg,
        ids,
        hydrated,
        query: CROWDED_QUERY,
        frontmatterCache,
        temporalIntentActive: false,
        declaredEventTimeMs: () => null,
      });
      const pool = assembleRankedResults({
        store,
        config: rerankCfg,
        opts: { query: CROWDED_QUERY, limit: LIMIT },
        keywordHits,
        semanticHits: [],
        hydrated,
        signals,
        relationalRankedChunkIds: [],
        weightProfile: undefined,
        sessionFocus: null,
        semanticEnabled: false,
        structured: undefined,
        frontmatterCache,
        timeRange: null,
        temporalIntent: null,
        declaredEventTimeMs: () => null,
        limit: LIMIT,
        nowMs: Date.now(),
        degraded: [],
      });

      expect(pool.length).toBe(4); // the cap keeps two rows per session
      // The widen witness: the deep session's rows were RANKED at all,
      // which only the topK term of the widened composition allows.
      expect(pool.some((r) => r.path.startsWith("b-"))).toBe(true);
    } finally {
      await store.close();
    }
  } finally {
    v.cleanup();
  }
});
