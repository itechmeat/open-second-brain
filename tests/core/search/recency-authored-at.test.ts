/**
 * The freshness prior measures age from the authoring instant (D1).
 *
 * The defect: `rankResults` computed its freshness boost from `c.mtime` -
 * the filesystem modification time the indexer recorded when it wrote the
 * file into the vault - while the authoring instant the note declares sat
 * on the same hydrated record, already projected, already used nine lines
 * below as an exact-tie rung. A batch of conversations imported today with
 * year-old turn instants therefore received the FULL freshness amplitude,
 * because the vault wrote their files today. Storage time answered a
 * question only authoring time can answer.
 *
 * The fix is `hyd.authoredAt ?? c.mtime`. Both are unix seconds, so no
 * conversion enters `recencyBoost`.
 *
 * The second half: `representativeChunks` produced `HydratedChunk` rows
 * that omitted `authoredAt` entirely, so its rows could not distinguish
 * "this document declares no authoring instant" from "this read did not
 * ask". It now projects the column and reports `null` for a document with
 * none, which is the answer, not the silence.
 *
 * What this file deliberately does NOT cover:
 *   - the query-side temporal layer (`eventTimeMsByChunk`), which keeps
 *     its own "declared validity start, else storage mtime" rule. That
 *     anchor answers "when did the event happen", not "how fresh is this",
 *     and merging the two is a separate decision;
 *   - the exact-tie ordering ladder, covered in `ranker.test.ts`;
 *   - which ingestion paths stamp `authored_at`. Only session import and
 *     the inbox backfill do; for every other path the column is NULL and
 *     the fallback below is the whole behaviour. That limit is stated in
 *     `ranker.ts`, and the byte-identity test here is what proves it costs
 *     nothing.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { rankResults } from "../../../src/core/search/ranker.ts";
import { weibullDecay, DEFAULT_RECENCY } from "../../../src/core/search/recency.ts";
import { Store } from "../../../src/core/search/store.ts";
import type { HydratedChunk, KeywordHit } from "../../../src/core/search/store.ts";
import { createTempVault, makeConfig } from "../../helpers/search-fixtures.ts";

const NOW_MS = 1_750_000_000_000;
const NOW_SECONDS = NOW_MS / 1000;
const DAY_SECONDS = 24 * 60 * 60;

/** Written into the vault today: the storage clock says maximally fresh. */
const INDEXED_TODAY = NOW_SECONDS;
/** A turn instant from a year ago: the authoring clock says stale. */
const AUTHORED_A_YEAR_AGO = NOW_SECONDS - 365 * DAY_SECONDS;
/** A turn instant from three days ago: still inside the decay curve. */
const AUTHORED_THREE_DAYS_AGO = NOW_SECONDS - 3 * DAY_SECONDS;

/**
 * A hydrated row. `authoredAt` is passed through exactly as given -
 * omitted when `undefined`, so a caller can build the "column never
 * projected" shape as well as the "column projected and NULL" one.
 */
function hyd(
  chunkId: number,
  docId: number,
  mtime: number,
  authoredAt?: number | null,
): HydratedChunk {
  return Object.freeze({
    chunkId,
    documentId: docId,
    path: `doc${docId}.md`,
    title: `Doc ${docId}`,
    content: `chunk ${chunkId}`,
    startLine: 1,
    endLine: 1,
    mtime,
    ...(authoredAt !== undefined ? { authoredAt } : {}),
  });
}

function rankOne(hydrated: HydratedChunk) {
  const keyword: KeywordHit[] = [
    { chunkId: hydrated.chunkId, documentId: hydrated.documentId, bm25: -3 },
  ];
  return rankResults(
    {
      keyword,
      semantic: [],
      hydrated: new Map([[hydrated.chunkId, hydrated]]),
      inboundLinkSources: new Map(),
      tagsByDoc: new Map(),
    },
    { keywordWeight: 1, semanticWeight: 0, limit: 10, nowMs: NOW_MS },
  );
}

test("a note imported today with a year-old turn instant loses the freshness it did not earn", () => {
  const ranked = rankOne(hyd(1, 10, INDEXED_TODAY, AUTHORED_A_YEAR_AGO));
  expect(ranked).toHaveLength(1);
  // Age is measured from the turn instant, not from the day the vault
  // happened to write the file.
  expect(ranked[0]!.recencyBoost).toBe(weibullDecay(365, DEFAULT_RECENCY));
  expect(ranked[0]!.recencyBoost).toBe(0);
  // The defect, named: the storage clock would have paid full amplitude.
  expect(ranked[0]!.recencyBoost).not.toBe(DEFAULT_RECENCY.amplitude);
});

test("a note imported today whose turn instant is also today keeps the full boost", () => {
  const ranked = rankOne(hyd(1, 10, INDEXED_TODAY, INDEXED_TODAY));
  expect(ranked[0]!.recencyBoost).toBe(DEFAULT_RECENCY.amplitude);
});

test("a stale file re-touched today ranks on its turn instant, not its new mtime", () => {
  const ranked = rankOne(hyd(1, 10, INDEXED_TODAY, AUTHORED_THREE_DAYS_AGO));
  expect(ranked[0]!.recencyBoost).toBe(weibullDecay(3, DEFAULT_RECENCY));
});

test("a record with no turn instant ranks on mtime, byte-identically to before", () => {
  const withoutColumn = rankOne(hyd(1, 10, NOW_SECONDS - 3 * DAY_SECONDS));
  const withNullColumn = rankOne(hyd(1, 10, NOW_SECONDS - 3 * DAY_SECONDS, null));
  // The three-day mtime decay, unchanged: `?? mtime` is the whole path.
  expect(withoutColumn[0]!.recencyBoost).toBe(weibullDecay(3, DEFAULT_RECENCY));
  // A projected NULL and an unprojected column rank identically, so
  // adding the projection to a read cannot move a score by itself.
  expect(withNullColumn).toEqual(withoutColumn);
});

test("two notes the vault wrote in the same instant order by their turn instants", () => {
  const keyword: KeywordHit[] = [
    { chunkId: 1, documentId: 10, bm25: -3 },
    { chunkId: 2, documentId: 11, bm25: -3 },
  ];
  const hydrated = new Map<number, HydratedChunk>([
    [1, hyd(1, 10, INDEXED_TODAY, AUTHORED_A_YEAR_AGO)],
    [2, hyd(2, 11, INDEXED_TODAY, AUTHORED_THREE_DAYS_AGO)],
  ]);
  const ranked = rankResults(
    { keyword, semantic: [], hydrated, inboundLinkSources: new Map(), tagsByDoc: new Map() },
    // Half weight so the composite lands at 0.5 + boost. At weight 1 the
    // two equal bm25 values normalise to 1 each and `clamp01` saturates
    // the sum, which would hide the very difference under test.
    { keywordWeight: 0.5, semanticWeight: 0, limit: 10, nowMs: NOW_MS },
  );
  // Identical mtime and identical bm25: under the storage clock these two
  // were an exact tie separated only by the tie-break ladder. The scores
  // now differ by exactly the difference between the two decay values.
  expect(ranked.map((r) => r.chunkId)).toEqual([2, 1]);
  expect(ranked[0]!.score - ranked[1]!.score).toBeCloseTo(
    weibullDecay(3, DEFAULT_RECENCY) - weibullDecay(365, DEFAULT_RECENCY),
    12,
  );
});

test("a zero recency amplitude stays the off switch for the authoring anchor too", () => {
  const keyword: KeywordHit[] = [{ chunkId: 1, documentId: 10, bm25: -3 }];
  const ranked = rankResults(
    {
      keyword,
      semantic: [],
      hydrated: new Map([[1, hyd(1, 10, INDEXED_TODAY, INDEXED_TODAY)]]),
      inboundLinkSources: new Map(),
      tagsByDoc: new Map(),
    },
    {
      keywordWeight: 1,
      semanticWeight: 0,
      limit: 10,
      nowMs: NOW_MS,
      recency: { ...DEFAULT_RECENCY, amplitude: 0 },
    },
  );
  expect(ranked[0]!.recencyBoost).toBe(0);
});

// ── the representative-chunk read reports the column instead of omitting it ──

let tmp: ReturnType<typeof createTempVault>;

beforeEach(() => {
  tmp = createTempVault("recency-authored-at");
});
afterEach(() => {
  tmp.cleanup();
});

async function seedStore() {
  const store = await Store.open(makeConfig({ vault: tmp.vault, dbPath: tmp.dbPath }), {
    mode: "write",
    loadVec: false,
  });
  const stamped = store.upsertDocument({
    path: "stamped.md",
    title: "Stamped",
    contentHash: "hs",
    mtime: INDEXED_TODAY,
    size: 1,
    authoredAt: AUTHORED_A_YEAR_AGO,
  });
  const plain = store.upsertDocument({
    path: "plain.md",
    title: "Plain",
    contentHash: "hp",
    mtime: INDEXED_TODAY,
    size: 1,
  });
  for (const id of [stamped, plain]) {
    store.replaceChunks(id, [
      {
        chunkIndex: 0,
        content: `head of ${id}`,
        contentHash: `c${id}`,
        startLine: 1,
        endLine: 1,
        tokenCount: 3,
      },
    ]);
  }
  return { store, stamped, plain };
}

test("representativeChunks reports the authoring instant of a stamped document", async () => {
  const { store, stamped } = await seedStore();
  const rep = store.representativeChunks([stamped]).get(stamped);
  expect(rep).toBeDefined();
  expect(rep!.authoredAt).toBe(AUTHORED_A_YEAR_AGO);
  await store.close();
});

test("representativeChunks answers null - not silence - for an unstamped document", async () => {
  const { store, plain } = await seedStore();
  const rep = store.representativeChunks([plain]).get(plain);
  expect(rep).toBeDefined();
  // `undefined` would mean "this read did not ask"; `null` means "the
  // document declares none". Only the second is an answer.
  expect(rep!.authoredAt).toBeNull();
  await store.close();
});

test("both producers of a hydrated row agree on the authoring instant", async () => {
  const { store, stamped, plain } = await seedStore();
  const reps = store.representativeChunks([stamped, plain]);
  const ids = [reps.get(stamped)!.chunkId, reps.get(plain)!.chunkId];
  const full = store.hydrateChunks(ids);
  for (const docId of [stamped, plain]) {
    const rep = reps.get(docId)!;
    expect(rep.authoredAt).toBe(full.get(rep.chunkId)!.authoredAt ?? null);
  }
  await store.close();
});
