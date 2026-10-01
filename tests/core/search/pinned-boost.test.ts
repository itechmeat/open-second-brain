/**
 * The pinned ranking signal (t_f7bef96a kept half): a bounded, always-on
 * additive layer over the per-note `pinned` frontmatter flag, which the
 * indexer persists into `documents.pinned` (v13) and the ranker consumes
 * through a pinned-by-document lookup.
 *
 * Pinned here:
 *   - the cap is the reinforce-scale 0.05, named in the ranker's caps
 *     block;
 *   - a pinned candidate outranks its unpinned twin by exactly the cap -
 *     never more - so BM25's lead stays non-overridable;
 *   - the layer is named in `reasons` and `breakdown`, and a row the
 *     index never measured contributes nothing and reports by absence,
 *     byte-identically to pre-feature ranking;
 *   - the store reader hands the ranker only MEASURED rows: "not pinned"
 *     and "nobody looked" stay different statements end to end.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PINNED_BOOST_CAP, rankResults } from "../../../src/core/search/ranker.ts";
import {
  applyMigrations,
  LATEST_SCHEMA_VERSION,
  PINNED_COLUMN,
} from "../../../src/core/search/schema.ts";
import { pinnedDocumentIds, upsertDocument } from "../../../src/core/search/store/documents.ts";
import type { KeywordHit, SemanticHit, HydratedChunk } from "../../../src/core/search/store.ts";

// ─────────────────────────────────────────────────────────────────────────────
// Ranker layer
// ─────────────────────────────────────────────────────────────────────────────

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

const NOW = 1_750_000_000_000; // ms
const OLD_MTIME = NOW / 1000 - 365 * 24 * 3600; // past the decay band → 0 recency

/** Two byte-identical candidates: the pin is the only difference. */
function twinInputs() {
  const keyword: KeywordHit[] = [
    { chunkId: 1, documentId: 10, bm25: -3 },
    { chunkId: 2, documentId: 11, bm25: -3 },
  ];
  const hydrated = new Map<number, HydratedChunk>([
    [1, hyd(1, 10, OLD_MTIME)],
    [2, hyd(2, 11, OLD_MTIME)],
  ]);
  return {
    keyword,
    semantic: [] as SemanticHit[],
    hydrated,
    inboundLinkSources: new Map<number, ReadonlySet<number>>(),
    tagsByDoc: new Map<number, ReadonlySet<string>>(),
  };
}

const OPTS = { keywordWeight: 0.6, semanticWeight: 0.4, limit: 10, nowMs: NOW };

test("the pinned cap is the reinforce-scale 0.05", () => {
  expect(PINNED_BOOST_CAP).toBe(0.05);
});

test("a pinned document outranks its unpinned twin by exactly the cap", () => {
  const boosted = rankResults({ ...twinInputs(), pinnedDocIds: new Set([11]) }, OPTS);
  expect(boosted[0]!.chunkId).toBe(2);
  const unpinned = boosted.find((r) => r.chunkId === 1)!;
  const pinned = boosted.find((r) => r.chunkId === 2)!;
  expect(pinned.score - unpinned.score).toBeCloseTo(PINNED_BOOST_CAP, 9);
});

test("the boost never overrides BM25's lead", () => {
  // The unpinned candidate leads on relevance by the full keyword weight
  // (0.6); the cap is 0.05, so the pin reorders ties, never relevance.
  const inputs = {
    ...twinInputs(),
    keyword: [
      { chunkId: 1, documentId: 10, bm25: -5 },
      { chunkId: 2, documentId: 11, bm25: -1 },
    ] as KeywordHit[],
    pinnedDocIds: new Set([11]),
  };
  const ranked = rankResults(inputs, OPTS);
  expect(ranked[0]!.chunkId).toBe(1);
  const leader = ranked.find((r) => r.chunkId === 1)!;
  const pinned = ranked.find((r) => r.chunkId === 2)!;
  expect(pinned.score - leader.score).toBeLessThan(PINNED_BOOST_CAP);
});

test("reasons and breakdown name the layer", () => {
  const boosted = rankResults(
    {
      ...twinInputs(),
      pinnedDocIds: new Set([11]),
    },
    OPTS,
  );
  const pinned = boosted.find((r) => r.chunkId === 2)!;
  expect(pinned.reasons).toContain(`pinned: ${PINNED_BOOST_CAP.toFixed(3)}`);
  expect(pinned.breakdown!.pinned).toBe(PINNED_BOOST_CAP);
  // The unpinned twin reports the layer by absence: no key, no reason.
  const unpinned = boosted.find((r) => r.chunkId === 1)!;
  expect(unpinned.breakdown!.pinned).toBeUndefined();
  expect(unpinned.reasons.some((r) => r.startsWith("pinned:"))).toBe(false);
  expect(unpinned.score).toBeCloseTo(
    rankResults(twinInputs(), OPTS).find((r) => r.chunkId === 1)!.score,
    12,
  );
});

test("a document outside the pinned set contributes nothing and reports by absence", () => {
  // A set that does not carry this document - measured unpinned, or a row
  // the index has not re-examined since v13 - must rank byte-identically
  // to no lookup at all, including the breakdown shape.
  const withMap = rankResults({ ...twinInputs(), pinnedDocIds: new Set() }, OPTS);
  const withoutMap = rankResults(twinInputs(), OPTS);
  expect(withMap.map((r) => r.score)).toEqual(withoutMap.map((r) => r.score));
  for (const r of withMap) expect(r.breakdown!.pinned).toBeUndefined();
  for (const r of withoutMap) expect(r.breakdown!.pinned).toBeUndefined();
});

// ─────────────────────────────────────────────────────────────────────────────
// Store reader
// ─────────────────────────────────────────────────────────────────────────────

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-pinned-boost-"));
  dbPath = join(tmp, "test.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function openMigrated(): Database {
  const db = new Database(dbPath);
  expect(applyMigrations(db)).toBe(LATEST_SCHEMA_VERSION);
  return db;
}

function doc(db: Database, path: string, pinned?: boolean): number {
  return upsertDocument(db, {
    path,
    title: null,
    contentHash: path,
    mtime: 1,
    size: 1,
    pinned,
  });
}

test("pinnedDocumentIds returns only the pinned rows among the candidates", () => {
  const db = openMigrated();
  const pinnedId = doc(db, "pinned.md", true);
  const otherPinnedId = doc(db, "other-pinned.md", true);
  const unpinnedId = doc(db, "unpinned.md", false);
  const unmeasuredId = doc(db, "unmeasured.md");
  // A pinned document outside the candidate set is not read.
  expect(pinnedDocumentIds(db, [pinnedId, unpinnedId, unmeasuredId, pinnedId])).toEqual(
    new Set([pinnedId]),
  );
  expect(pinnedDocumentIds(db, [otherPinnedId])).toEqual(new Set([otherPinnedId]));
  db.close(true);
});

test("pinnedDocumentIds with no candidates or no pinned rows is an empty set", () => {
  const db = openMigrated();
  const id = doc(db, "lazy-backfill.md");
  expect(pinnedDocumentIds(db, [])).toEqual(new Set());
  expect(pinnedDocumentIds(db, [id])).toEqual(new Set());
  db.close(true);
});

test("the persisted column is the named 1/0, never a third value", () => {
  const db = openMigrated();
  const id = doc(db, "pinned.md", true);
  const raw = db
    .query<Record<string, number | null>, [number]>(
      `SELECT ${PINNED_COLUMN} AS pinned FROM documents WHERE id = ?`,
    )
    .get(id);
  expect(raw?.pinned).toBe(1);
  db.close(true);
});
