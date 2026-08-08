/**
 * Ranking determinism: a search ranks against the instant its request
 * resolved, never against a wall clock the ranker reads for itself.
 *
 * The defect this locks down: `rankResults` defaulted `nowMs` to
 * `Date.now()` and the assembly stage never passed the request's
 * already-resolved instant, so the freshness layer folded a second,
 * later clock reading into every live score. Two rows that tie on every
 * intrinsic signal then order by whatever the clock happened to say at
 * the moment the ranker ran, and the tie-break ladder's first rung is an
 * exact float comparison.
 *
 * Three assertions, in increasing strength:
 *   1. the acceptance lock - two live searches over a fixture built to
 *      tie return the same rows in the same order with the query cache
 *      off;
 *   2. the census - during one `search()` call the wall clock is read
 *      only where the request is resolved, and never from the ranker;
 *   3. the direct assembly test - `assembleRankedResults` is a pure
 *      function of its input, so moving the process wall clock between
 *      two invocations with the same input cannot change the ordering.
 *
 * A fourth covers the companion defect one layer down: the keyword,
 * trigram and vector candidate queries all truncate on a score column
 * that is not a total order, so each ends its sort on `chunks.id`.
 *
 * What that fourth test can and cannot witness, stated rather than
 * implied. It DOES witness the vector lane, where the fix is load-bearing
 * for a reason no ORDER BY can supply: the k-nearest selection happens
 * before SQL sees the rows, so the clause needs an over-fetch beside it
 * and removing either is caught here. For the keyword and trigram lanes
 * it witnesses only that a WRONG tiebreak is caught - removing the clause
 * entirely leaves this test green, because FTS5 scans a MATCH in rowid
 * order and SQLite's sorter is stable, so the natural order for a fixture
 * of this shape already equals `chunks.id ASC`. Those two clauses are
 * therefore defensive: they pin an order the engine currently gives for
 * free and is under no contract to keep. No fixture in this shape can
 * discriminate them, and claiming otherwise would be evidence this file
 * does not have.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { utimesSync } from "node:fs";
import { join } from "node:path";

import { indexVault, search } from "../../../src/core/search/index.ts";
import { assembleRankedResults } from "../../../src/core/search/pipeline/assemble.ts";
import { collectCandidateSignals } from "../../../src/core/search/pipeline/candidate-signals.ts";
import { Store } from "../../../src/core/search/store.ts";
import { planTrigramPrefilter } from "../../../src/core/search/trigram-prefilter.ts";
import type { KeywordHit } from "../../../src/core/search/store.ts";
import type { BrainSearchResult } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

/**
 * The only module that may read the wall clock on the `search()` path.
 * Every time-resolving decision in a call is derived from the single
 * instant resolved there; anything else re-reading the clock mid-pipeline
 * makes one call disagree with itself.
 */
const CLOCK_OWNER = "src/core/search/pipeline/request.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const SECONDS_PER_DAY = 24 * 60 * 60;

/** Two candidates a hair apart in BM25, and a third that sets the range. */
const BM25_LEAD = -5;
const BM25_RUNNER_UP = -4.99;
const BM25_FLOOR = -1;

/** Ages that put the recency layer above, then below, the BM25 gap. */
const STALE_AGE_DAYS = 60;
const CLOCK_JUMP_DAYS = 3650;

/** More tied candidates than the top-K asks for, so the cut has to choose. */
const TIED_DOCUMENT_COUNT = 8;
const TIED_TOP_K = 3;
const SEMANTIC_DIMENSION = 256;
const TIED_QUERY_TEXT = "migration rollback";
const TIED_FTS_QUERY = '"migration" AND "rollback"';

let tmp: ReturnType<typeof createTempVault>;

beforeEach(() => {
  tmp = createTempVault("rank-clock-determinism");
});

afterEach(() => {
  tmp.cleanup();
});

function identityProjection(results: ReadonlyArray<BrainSearchResult>) {
  return results.map((r) => `${r.path}#${r.chunkId}`);
}

// ---------------------------------------------------------------------------
// 1. Acceptance lock: two live searches over a genuine score tie.
// ---------------------------------------------------------------------------

test("two live searches over a scored tie return the same rows in the same order", async () => {
  // Byte-identical bodies in two files: identical term frequencies and
  // identical document lengths, so FTS5 scores them identically, and the
  // same indexing pass gives them the same second-resolution mtime. Every
  // ranked layer - keyword, recency, link, tag - is therefore equal, and
  // the composite score is an exact float tie.
  const body = "The rollback strategy reverts the migration in one step.\n";
  writeMd(tmp.vault, "left.md", `---\ntitle: Left\n---\n\n${body}`);
  writeMd(tmp.vault, "right.md", `---\ntitle: Right\n---\n\n${body}`);
  writeMd(tmp.vault, "other.md", `---\ntitle: Other\n---\n\nUnrelated prose about gardening.\n`);
  const config = makeConfig({ vault: tmp.vault, dbPath: tmp.dbPath, cacheEnabled: false });
  await indexVault(config, {});

  const first = await search(config, { query: "rollback strategy migration", limit: 10 });
  const second = await search(config, { query: "rollback strategy migration", limit: 10 });

  // The fixture really does tie - otherwise this test would be asserting
  // determinism over an ordering nothing could have disturbed.
  expect(first.results.length).toBeGreaterThanOrEqual(2);
  expect(first.results[0]!.score).toBe(first.results[1]!.score);

  expect(identityProjection(second.results)).toEqual(identityProjection(first.results));
});

// ---------------------------------------------------------------------------
// 2. Census: who reads the wall clock during one search.
// ---------------------------------------------------------------------------

test("one search() call reads the wall clock only where the request is resolved", async () => {
  writeMd(tmp.vault, "a.md", "---\ntitle: A\n---\n\nalpha beta gamma delta\n");
  writeMd(tmp.vault, "b.md", "---\ntitle: B\n---\n\nalpha beta gamma epsilon\n");
  const config = makeConfig({ vault: tmp.vault, dbPath: tmp.dbPath, cacheEnabled: false });
  await indexVault(config, {});

  const realNow = Date.now;
  const sites = new Set<string>();
  let capturing = false;
  const record = (): void => {
    if (!capturing) return;
    for (const frame of (new Error().stack ?? "").split("\n").slice(1)) {
      const match = /\((\/.*?\/(src\/core\/.*?\.ts)):\d+:\d+\)/.exec(frame);
      if (match) {
        sites.add(match[2]!);
        return;
      }
    }
    sites.add("unattributed");
  };
  Date.now = () => {
    record();
    return realNow();
  };
  try {
    capturing = true;
    await search(config, { query: "alpha beta gamma", limit: 5 });
    capturing = false;
  } finally {
    Date.now = realNow;
  }

  // Non-vacuous: the instrumentation did observe the clock being read.
  expect(sites.size).toBeGreaterThan(0);
  expect([...sites].toSorted()).toEqual([CLOCK_OWNER]);
});

// ---------------------------------------------------------------------------
// 3. Direct assembly test: same input, same ordering, whatever the clock.
// ---------------------------------------------------------------------------

test("assembleRankedResults orders on the injected instant, not the process clock", async () => {
  // `lead` wins on BM25 by a hair; `runnerUp` is fresh and `lead` is
  // stale, so at the pinned instant the recency layer more than covers
  // the BM25 gap and `runnerUp` ranks first. Far enough into the future
  // both freshness boosts collapse to zero and the BM25 gap decides -
  // the ordering inverts. That inversion is the observable the injected
  // clock has to suppress.
  writeMd(tmp.vault, "lead.md", "---\ntitle: Lead\n---\n\nalpha beta gamma alpha beta gamma\n");
  writeMd(tmp.vault, "runner-up.md", "---\ntitle: Runner Up\n---\n\nalpha beta gamma\n");
  writeMd(
    tmp.vault,
    "floor.md",
    "---\ntitle: Floor\n---\n\nalpha and a long tail of other words\n",
  );
  const nowMs = Date.now();
  const staleSeconds = (nowMs - STALE_AGE_DAYS * DAY_MS) / 1000;
  utimesSync(join(tmp.vault, "lead.md"), staleSeconds, staleSeconds);
  const config = makeConfig({
    vault: tmp.vault,
    dbPath: tmp.dbPath,
    mmrLambda: 1,
    maxHops: 0,
    cacheEnabled: false,
  });
  await indexVault(config, {});

  const store = await Store.open(config, { mode: "read" });
  try {
    const documents = store.listDocuments();
    const chunkIdFor = (path: string): number => {
      const doc = documents.get(path);
      if (doc === undefined) throw new Error(`fixture document missing from index: ${path}`);
      const chunks = store.chunksForDocument(doc.id);
      const first = chunks[0];
      if (first === undefined) throw new Error(`fixture document has no chunk: ${path}`);
      return first.id;
    };
    const leadChunk = chunkIdFor("lead.md");
    const runnerUpChunk = chunkIdFor("runner-up.md");
    const floorChunk = chunkIdFor("floor.md");
    const ids = [leadChunk, runnerUpChunk, floorChunk];
    const hydrated = store.hydrateChunks(ids);
    // The fixture's staleness has to survive indexing, or the two
    // candidates would share a freshness boost and nothing below could
    // move.
    const staleMtime = hydrated.get(leadChunk)!.mtime;
    const freshMtime = hydrated.get(runnerUpChunk)!.mtime;
    expect(freshMtime - staleMtime).toBeGreaterThanOrEqual((STALE_AGE_DAYS - 1) * SECONDS_PER_DAY);

    const documentIdFor = (chunkId: number): number => hydrated.get(chunkId)!.documentId;
    const keywordHits: ReadonlyArray<KeywordHit> = [
      { chunkId: leadChunk, documentId: documentIdFor(leadChunk), bm25: BM25_LEAD },
      { chunkId: runnerUpChunk, documentId: documentIdFor(runnerUpChunk), bm25: BM25_RUNNER_UP },
      { chunkId: floorChunk, documentId: documentIdFor(floorChunk), bm25: BM25_FLOOR },
    ];
    const frontmatterCache = new Map();
    const signals = collectCandidateSignals({
      store,
      config,
      ids,
      hydrated,
      query: "alpha beta gamma",
      frontmatterCache,
      temporalIntentActive: false,
      declaredEventTimeMs: () => null,
    });
    const input = {
      store,
      config,
      opts: { query: "alpha beta gamma", limit: ids.length },
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
      limit: ids.length,
      nowMs,
    } as const;

    const realNow = Date.now;
    let atPinnedInstant: ReadonlyArray<BrainSearchResult>;
    let afterClockJump: ReadonlyArray<BrainSearchResult>;
    try {
      Date.now = () => nowMs;
      atPinnedInstant = assembleRankedResults(input);
      Date.now = () => nowMs + CLOCK_JUMP_DAYS * DAY_MS;
      afterClockJump = assembleRankedResults(input);
    } finally {
      Date.now = realNow;
    }

    // At the injected instant the fresh runner-up outranks the stale
    // BM25 leader: the fixture is genuinely clock-sensitive, so a ranker
    // that re-read the clock would have something to get wrong.
    expect(identityProjection(atPinnedInstant).slice(0, 2)).toEqual([
      `runner-up.md#${runnerUpChunk}`,
      `lead.md#${leadChunk}`,
    ]);
    expect(identityProjection(afterClockJump)).toEqual(identityProjection(atPinnedInstant));
    expect(afterClockJump.map((r) => r.score)).toEqual(atPinnedInstant.map((r) => r.score));
  } finally {
    await store.close();
  }
});

// ---------------------------------------------------------------------------
// 4. The three candidate queries end their ordering in a unique column.
// ---------------------------------------------------------------------------

test("the three candidate queries cut their top-K on a total order", async () => {
  // Byte-identical bodies across more documents than the top-K asks
  // for: every candidate scores the same BM25 in `chunk_fts` and in
  // `chunk_trigram`, and embeds to the same vector, so the score column
  // alone cannot decide which rows survive the `LIMIT`. Only the unique
  // final sort key can, and it is `chunks.id` ascending.
  const body = "Deterministic paragraph about migration rollback strategy planning.\n";
  for (let i = 0; i < TIED_DOCUMENT_COUNT; i++) {
    writeMd(tmp.vault, `tied-${i}.md`, `---\ntitle: Tied ${i}\n---\n\n${body}`);
  }
  const config = makeConfig({
    vault: tmp.vault,
    dbPath: tmp.dbPath,
    semantic: { enabled: true, provider: "local", dimension: SEMANTIC_DIMENSION },
    trigramPrefilterEnabled: true,
    trigramPrefilterMinChunks: 0,
  });
  await indexVault(config, { embeddings: true });

  const store = await Store.open(config, { mode: "read" });
  try {
    // The whole tied set first, so the expectation is derived from the
    // rows that actually tie rather than from every chunk in the vault
    // (each fixture note also yields a frontmatter chunk, which matches
    // nothing here).
    const wholeSet = store.keywordTopK(TIED_FTS_QUERY, { limit: TIED_DOCUMENT_COUNT * 2 });
    expect(wholeSet.length).toBe(TIED_DOCUMENT_COUNT);
    // Non-vacuous: the lane really did tie, so the cut below had nothing
    // but the unique key to go on.
    expect(new Set(wholeSet.map((h) => h.bm25)).size).toBe(1);
    const tiedIds = wholeSet.map((h) => h.chunkId).toSorted((a, b) => a - b);
    const expected = tiedIds.slice(0, TIED_TOP_K);

    const keyword = store.keywordTopK(TIED_FTS_QUERY, { limit: TIED_TOP_K });
    expect(keyword.map((h) => h.chunkId)).toEqual(expected);

    const trigramPlan = planTrigramPrefilter(TIED_QUERY_TEXT);
    if (trigramPlan.mode !== "match") throw new Error("expected a trigram match plan");
    const trigram = store.trigramCandidates(trigramPlan.ftsQuery, { limit: TIED_TOP_K });
    expect(trigram.warnings).toEqual([]);
    expect(new Set(trigram.hits.map((h) => h.bm25)).size).toBe(1);
    expect(trigram.hits.map((h) => h.chunkId)).toEqual(expected);

    // The semantic lane only ranks when sqlite-vec is present; without
    // it there is no KNN query to order and the assertion would be
    // meaningless rather than passing.
    expect(store.vecLoaded()).toBe(true);
    const vector = store.embeddingForChunk(tiedIds[0]!);
    if (vector === null) throw new Error("fixture chunk has no embedding");
    const semantic = store.semanticTopK(vector, { limit: TIED_TOP_K });
    expect(new Set(semantic.map((h) => h.distance)).size).toBe(1);
    expect(semantic.map((h) => h.chunkId)).toEqual(expected);
  } finally {
    await store.close();
  }
});
