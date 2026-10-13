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
import { parseBenchPinnedKnobs } from "../../../src/cli/brain/verbs/bench.ts";
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
    // Frozen pre-change expectation, so the proof is anchored outside
    // this build: a regression that shifts BOTH arms of the A/B above
    // identically now goes red. Order and trail identity are pinned -
    // never score magnitudes. The crowded session takes every window
    // slot, and the only narrowing the off answer names is the pre-knob
    // rank-cap truncation, never a session-cap note.
    expect(off.results.map((r) => r.path)).toEqual(["a-0.md", "a-1.md", "a-2.md"]);
    expect(off.retrievalTrail?.degraded).toEqual([
      { code: RETRIEVAL_DEGRADATION.rankCapTruncatedPool, detail: { cap: LIMIT } },
    ]);
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
    // The crowd's best-ranked survivor leads whichever a- note the index
    // ranked first - directory order must not decide the assertion.
    expect(on.results[0]?.path.startsWith("a-")).toBe(true);
    expect(on.results.some((r) => !r.path.startsWith("a-"))).toBe(true);
    const entry = degradationOf(on, RETRIEVAL_DEGRADATION.sourceSessionCappedRows);
    expect(entry?.detail).toEqual({ dropped: 4, cap: 2 });
  } finally {
    v.cleanup();
  }
});

test("the per-query override alone activates the cap without a config value", async () => {
  const v = await indexedCrowdedVault();
  try {
    // `cold` carries no poolMaxPerSession at all: the whole cap comes
    // from the per-query SearchOptions field.
    const overridden = await search(v.cold, {
      query: CROWDED_QUERY,
      limit: LIMIT,
      poolMaxPerSession: 2,
    });

    expect(overridden.results.length).toBe(LIMIT);
    expect(overridden.results[0]?.path.startsWith("a-")).toBe(true);
    expect(overridden.results.some((r) => !r.path.startsWith("a-"))).toBe(true);
    const entry = degradationOf(overridden, RETRIEVAL_DEGRADATION.sourceSessionCappedRows);
    expect(entry?.detail).toEqual({ dropped: 4, cap: 2 });
    // The same query without the override stays uncapped - the override,
    // not the fixture, is what capped the answer. (The uncapped run
    // still carries the pre-existing rank-cap note; the session-cap
    // note is the one that must be absent.)
    const plain = await search(v.cold, { query: CROWDED_QUERY, limit: LIMIT });
    expect(degradationOf(plain, RETRIEVAL_DEGRADATION.sourceSessionCappedRows)).toBeUndefined();
    expect(JSON.stringify(plain)).not.toBe(JSON.stringify(overridden));
  } finally {
    v.cleanup();
  }
});

test("the per-query override wins over the config value when both are set", async () => {
  const v = await indexedCrowdedVault();
  try {
    // Tighter than the config: 2 crowded rows survive under config cap
    // 2, but the query's own cap 1 keeps only the first.
    const tighter = await search(withRecall(v.cold, { poolMaxPerSession: 2 }), {
      query: CROWDED_QUERY,
      limit: LIMIT,
      poolMaxPerSession: 1,
    });
    expect(tighter.results.map((r) => r.path)).toEqual(["a-0.md", "b.md", "c.md"]);
    expect(degradationOf(tighter, RETRIEVAL_DEGRADATION.sourceSessionCappedRows)?.detail).toEqual({
      dropped: 5,
      cap: 1,
    });

    // Looser than the config: config cap 1 would keep one crowded row,
    // but the query's own cap 3 keeps three.
    const looser = await search(withRecall(v.cold, { poolMaxPerSession: 1 }), {
      query: CROWDED_QUERY,
      limit: LIMIT,
      poolMaxPerSession: 3,
    });
    expect(looser.results.map((r) => r.path)).toEqual(["a-0.md", "a-1.md", "a-2.md"]);
    expect(degradationOf(looser, RETRIEVAL_DEGRADATION.sourceSessionCappedRows)?.detail).toEqual({
      dropped: 3,
      cap: 3,
    });
  } finally {
    v.cleanup();
  }
});

test("an explicit per-query 0 forces the cap off over a config cap", async () => {
  const v = await indexedCrowdedVault();
  try {
    const forcedOff = await search(withRecall(v.cold, { poolMaxPerSession: 2 }), {
      query: CROWDED_QUERY,
      limit: LIMIT,
      poolMaxPerSession: 0,
    });
    const off = await search(v.cold, { query: CROWDED_QUERY, limit: LIMIT });

    // The documented forced-off value: the config knob cannot reach past
    // a per-query 0, and the answer is the default-off run's exact bytes
    // (rank-cap trail and all - the session-cap note never appears).
    expect(JSON.stringify(forcedOff)).toBe(JSON.stringify(off));
    expect(degradationOf(forcedOff, RETRIEVAL_DEGRADATION.sourceSessionCappedRows)).toBeUndefined();
  } finally {
    v.cleanup();
  }
});

test("a vault with no session identity ranks identically with the cap on", async () => {
  // The module fixture holds ordinary notes only - no session_ref, no
  // session_id - so with the cap on, every note is its own PATH group
  // (the M2 fallback) holding a single chunk, and nothing can drop.
  const cold = withRecall(config(), { recencyAmplitude: 0 });
  const off = await search(cold, { query: "widget calibration", limit: LIMIT });
  const on = await search(withRecall(cold, { poolMaxPerSession: 2 }), {
    query: "widget calibration",
    limit: LIMIT,
  });

  expect(JSON.stringify(on)).toBe(JSON.stringify(off));
  expect(on.retrievalTrail).toBeUndefined();
});

test("the cap's drops trigger the one-shot re-widen when the window under-fills", async () => {
  // Forty matching notes in ONE session: the window cannot fill (cap 2,
  // limit 3), and the cap's own drops are the review-M3 trigger the older
  // build lacked - the re-widen runs once at
  // `limit * (widestGroupRows + 1)` = 3 * 31 = 93, ranks the whole
  // corpus (40 rows), and reports the FINAL pass: 2 survived, 38
  // dropped - the first 30-wide pass dropped 28. The answer stays 2 rows
  // because the corpus holds one session only; the trail names that pass
  // honestly instead of retrying forever.
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

    // The corpus holds nothing outside the one session, so the re-widen
    // cannot add rows - but it RANKED them: dropped 38 witnesses the
    // 40-row final pass, never the first pass's 28.
    expect(out.results.length).toBe(2);
    const entry = degradationOf(out, RETRIEVAL_DEGRADATION.sourceSessionCappedRows);
    expect(entry?.detail).toEqual({ dropped: 38, cap: 2 });
    // Once per answer: the re-widen's second pass replaces the first
    // pass's note, it never stacks beside it.
    const capNotes = out.retrievalTrail?.degraded.filter(
      (d) => d.code === RETRIEVAL_DEGRADATION.sourceSessionCappedRows,
    );
    expect(capNotes).toHaveLength(1);
  } finally {
    v.cleanup();
  }
});

test("the re-widen actually refills the window from deeper sessions", async () => {
  // The review-M3 repro, ranked deterministically: forty rows of one
  // session outrank ten single-row sessions, cap 1, limit 3. The first
  // 30-wide pass keeps one row; the re-widen ranks past the crowded
  // session and the window fills from the sessions the cap did not
  // exhaust. Driven through `assembleRankedResults` directly so the rank
  // order is pinned by the fixture, not by scoring.
  const v = createTempVault("pool-cap-refill");
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
        `---\ntitle: Deep ${i}\nsession_ref: sess-b-${i}\n---\n\n# Deep ${i}\n\nalpha beta gamma deep ${i}.\n`,
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
      poolMaxPerSession: 1,
    });
    await indexVault(cfg, {});

    const store = await Store.open(cfg, { mode: "read" });
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
        config: cfg,
        ids,
        hydrated,
        query: CROWDED_QUERY,
        frontmatterCache,
        temporalIntentActive: false,
        declaredEventTimeMs: () => null,
      });
      const degraded: RetrievalDegradation[] = [];
      const pool = assembleRankedResults({
        store,
        config: cfg,
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
        degraded,
      });

      // The crowded session keeps its one row; every deep session row is
      // in the pool the window draws from - the re-widen reached them.
      expect(pool.length).toBe(11);
      // The fixture's bm25 ladder makes a-9 (last in the sorted paths)
      // the best-ranked crowded row - the one the cap keeps.
      expect(pool[0]?.path).toBe("a-9.md");
      expect(pool.filter((r) => r.path.startsWith("b-"))).toHaveLength(10);
      // The note carries the FINAL pass's numbers: the crowded session
      // still drops 29 of its ranked rows (1 kept), now beside the ten
      // sessions the wider pool admitted.
      const entry = degraded.find((d) => d.code === RETRIEVAL_DEGRADATION.sourceSessionCappedRows);
      expect(entry?.detail).toEqual({ dropped: 29, cap: 1 });
      expect(
        degraded.filter((d) => d.code === RETRIEVAL_DEGRADATION.sourceSessionCappedRows),
      ).toHaveLength(1);
    } finally {
      await store.close();
    }
  } finally {
    v.cleanup();
  }
});

test("a pre-existing backfill under the cap notes the final pass's drops exactly once", async () => {
  // The harder shape the once-per-answer contract claims: the backfill
  // fires for its OWN pre-existing reason (default-scope visibility drops
  // the private half of the session, leaving the window under-filled),
  // the cap is re-applied over the wider 50-row pool, and the trail
  // reports THAT pass's numbers - not the first pass's. Forty notes in
  // one session, half `visibility: private`, cap 2, limit 3: the first
  // (30-wide) pass sees 15 filter-passing rows and drops 13 of them to
  // the cap, the second (50-wide) pass ranks all 40, filters to 20, and
  // drops 18 - so `dropped: 18` is itself the witness that the window
  // grew and the answer came from the final pass. And because the cap
  // counts only FILTER-PASSING rows against the session's quota (the
  // review-M4 ordering), both surviving public rows are in the answer -
  // the older build spent quota on a private row the filters then
  // withheld, and answered with one.
  const v = createTempVault("pool-cap-backfill");
  try {
    for (let i = 0; i < 40; i += 1) {
      const visibility = i % 2 === 1 ? "visibility: private\n" : "";
      writeMd(
        v.vault,
        `solo-${i}.md`,
        `---\ntitle: Solo ${i}\n${visibility}session_ref: sess-a\n---\n\n# Solo ${i}\n\n` +
          `The widget calibration routine number ${i}.\n`,
      );
    }
    const cold = withRecall(
      makeConfig({ vault: v.vault, dbPath: v.dbPath, maxHops: 0, mmrLambda: 1 }),
      { recencyAmplitude: 0, poolMultiplier: 20, poolMaxPerSession: 2 },
    );
    await indexVault(cold, {});

    const out = await search(cold, { query: CROWDED_QUERY, limit: LIMIT });

    // The note names the FINAL pass: 18 dropped over the 50-wide pool's
    // 20 filter-passing rows, never the first pass's 13. The two
    // survivors are the two best-ranked PUBLIC rows (solo-1 is private
    // and filters out before the cap ever sees it).
    expect(out.results.map((r) => r.path)).toEqual(["solo-0.md", "solo-10.md"]);
    const entry = degradationOf(out, RETRIEVAL_DEGRADATION.sourceSessionCappedRows);
    expect(entry?.detail).toEqual({ dropped: 18, cap: 2 });
    // Once per answer, even when the assemble closure ran twice.
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

test("a bench pin caps frontmatter-less bench session notes (path fallback)", async () => {
  // The review-M2 repro on the bench this knob was added to measure:
  // LongMemEval-style session notes carry NO frontmatter (the converter
  // writes plain bodies - `sessionNoteBody`), and one long session note
  // splits into several chunks that crowd the pool together. Grouped by
  // frontmatter alone, the cap changed nothing here, byte for byte; with
  // the path fallback every chunk of one note is one group, so the pinned
  // cap drops real rows. The knob NAME and its value semantics ride the
  // exported pin parser and the resolved search config - the two seams
  // `--pin '{"recall":{"poolMaxPerSession":N}}'` flows through.
  const v = createTempVault("pool-cap-bench-pin");
  try {
    for (const session of [1, 2, 3]) {
      const body = Array.from(
        { length: 300 },
        (_, i) =>
          `Turn ${i}: the widget calibration routine number ${i % 40} appears in session ${session} ` +
          `near marker ${i} of note ${session}, with enough surrounding words to force the chunker ` +
          `to split this session note into several chunks.`,
      ).join("\n");
      writeMd(
        v.vault,
        `sessions/q1/session-${session}.md`,
        `# Session ${session} (question q1)\n\n${body}\n`,
      );
    }
    const base = withRecall(
      makeConfig({ vault: v.vault, dbPath: v.dbPath, maxHops: 0, mmrLambda: 1 }),
      { recencyAmplitude: 0 },
    );
    await indexVault(base, {});

    const pin = parseBenchPinnedKnobs('{"recall":{"poolMaxPerSession":1}}');
    expect(pin.recall?.poolMaxPerSession).toBe(1);
    const pinned = withRecall(base, { poolMaxPerSession: pin.recall?.poolMaxPerSession });

    const uncapped = await search(base, { query: "widget calibration", limit: LIMIT });
    const capped = await search(pinned, { query: "widget calibration", limit: LIMIT });

    // The uncapped pool is the crowding itself: one frontmatter-less
    // session note fills the window with its own chunks.
    expect(uncapped.total).toBeGreaterThanOrEqual(LIMIT);
    const crowdedPath = uncapped.results[0]?.path;
    expect(uncapped.results.filter((r) => r.path === crowdedPath).length).toBeGreaterThan(1);

    // NON-ZERO drops: the pin measurably narrows the pool over notes
    // that carry no session frontmatter at all.
    const entry = degradationOf(capped, RETRIEVAL_DEGRADATION.sourceSessionCappedRows);
    expect(entry?.detail?.dropped).toBeGreaterThan(0);
    // Cap 1 per note: no session note contributes two rows to the answer
    // any more, and the answer is not the uncapped bytes.
    const byPath = new Map<string, number>();
    for (const r of capped.results) byPath.set(r.path, (byPath.get(r.path) ?? 0) + 1);
    expect([...byPath.values()].every((n) => n === 1)).toBe(true);
    expect(JSON.stringify(capped)).not.toBe(JSON.stringify(uncapped));
  } finally {
    v.cleanup();
  }
});

test("a fractional or negative per-query override is refused by name", async () => {
  // The per-query override used to bypass the config validation: 1.5
  // turned the cap on with a fractional comparison (seen >= 1.5 kept two
  // rows), NaN read as off, a negative as drop-everything. The search
  // entry refuses all three through the same named INVALID_INPUT path
  // the config key is judged by.
  const v = await indexedCrowdedVault();
  try {
    await expect(
      search(v.cold, { query: CROWDED_QUERY, limit: LIMIT, poolMaxPerSession: 1.5 }),
    ).rejects.toThrow(/poolMaxPerSession/);
    await expect(
      search(v.cold, { query: CROWDED_QUERY, limit: LIMIT, poolMaxPerSession: Number.NaN }),
    ).rejects.toThrow(/poolMaxPerSession/);
    await expect(
      search(v.cold, { query: CROWDED_QUERY, limit: LIMIT, poolMaxPerSession: -2 }),
    ).rejects.toThrow(/poolMaxPerSession/);
  } finally {
    v.cleanup();
  }
});

test("a cap at or above the pool width it would judge is treated as off", async () => {
  // The review-L4 upper bound: a huge cap turned the phase on, read
  // frontmatter for every row, and dropped nothing. At or above the
  // resolved pool width the cap cannot drop a row, so it is off - the
  // answer is the default-off run's exact bytes and no session-cap note
  // appears. The configured value still folds into the fingerprint
  // (pinned in config.test.ts), so crossing this boundary can never
  // serve a stale cached row.
  const v = await indexedCrowdedVault();
  try {
    const huge = await search(withRecall(v.cold, { poolMaxPerSession: 10_000 }), {
      query: CROWDED_QUERY,
      limit: LIMIT,
    });
    const off = await search(v.cold, { query: CROWDED_QUERY, limit: LIMIT });

    expect(JSON.stringify(huge)).toBe(JSON.stringify(off));
    expect(degradationOf(huge, RETRIEVAL_DEGRADATION.sourceSessionCappedRows)).toBeUndefined();

    // The boundary is the width the cap would judge when on - for a
    // plain limit-3 query, the widened 30. Below it the phase still runs
    // and bites (the crowded session holds 6 rows, so cap 5 drops one);
    // at or above it - 30 exactly, one past it, and far past it - the
    // answer is the off run's bytes.
    const justUnder = await search(withRecall(v.cold, { poolMaxPerSession: 5 }), {
      query: CROWDED_QUERY,
      limit: LIMIT,
    });
    expect(degradationOf(justUnder, RETRIEVAL_DEGRADATION.sourceSessionCappedRows)?.detail).toEqual(
      { dropped: 1, cap: 5 },
    );
    const atBoundary = await search(withRecall(v.cold, { poolMaxPerSession: 30 }), {
      query: CROWDED_QUERY,
      limit: LIMIT,
    });
    expect(JSON.stringify(atBoundary)).toBe(JSON.stringify(off));
    const onePast = await search(withRecall(v.cold, { poolMaxPerSession: 31 }), {
      query: CROWDED_QUERY,
      limit: LIMIT,
    });
    expect(JSON.stringify(onePast)).toBe(JSON.stringify(off));
    const farPast = await search(withRecall(v.cold, { poolMaxPerSession: 120 }), {
      query: CROWDED_QUERY,
      limit: LIMIT,
    });
    expect(JSON.stringify(farPast)).toBe(JSON.stringify(off));
  } finally {
    v.cleanup();
  }
});
