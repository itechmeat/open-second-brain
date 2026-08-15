/**
 * A declared `authored_at` in the FUTURE pinned a document at maximum
 * freshness forever, and any note could declare one.
 *
 * `freshnessAnchorSeconds` returned the declared instant unclamped, and
 * `weibullDecay` returns the full amplitude for a non-positive age - so a
 * note carrying `authored_at: 2999-01-01` scored the maximum recency boost
 * on every query, above a note actually written today, and no passage of
 * time moved it. The docblock that made this look safe claimed only session
 * import and the inbox backfill write the column; the indexer in fact reads
 * the key off EVERY indexed markdown file, so a hand-written note is enough.
 *
 * Two boundaries are pinned here because one cannot cover the other:
 *   - the INDEX refuses an instant that had not happened when it read the
 *     file, so the stored column keeps meaning "an authoring instant";
 *   - the RANKER refuses one that reached it anyway, because this release
 *     does not rewrite existing databases and the content-hash fastpath
 *     lets a poisoned row outlive many index runs.
 *
 * The fallback is `mtime` (not a clamp to now): a note that cannot have been
 * authored yet has declared nothing usable, and the storage fact is the only
 * instant left. Clamping to now would leave the note at full amplitude, which
 * is the defect.
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { utimesSync } from "node:fs";
import { join } from "node:path";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { rankResults } from "../../../src/core/search/ranker.ts";
import { search } from "../../../src/core/search/search.ts";
import type { HydratedChunk, KeywordHit } from "../../../src/core/search/store.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("authored-at-future");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

const DAY_MS = 24 * 60 * 60 * 1000;

function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/**
 * A plain hand-written note - no `kind`, no import path, just frontmatter.
 * `name` varies the heading only, so the searchable sentence is identical
 * across the fixture while the file bytes are not (identical bytes are
 * merged by the duplicate-passage pass and would leave the set short).
 */
function noteMd(authoredAt: string | null, name: string, marker: string): string {
  return [
    "---",
    "title: Chronology note",
    ...(authoredAt !== null ? [`authored_at: ${authoredAt}`] : []),
    "---",
    "",
    `# Note ${name}`,
    "",
    `The operator discussed chronology token ${marker} in this note.`,
    "",
  ].join("\n");
}

function pinMtimeDaysAgo(path: string, days: number): void {
  const when = new Date(Date.now() - days * DAY_MS);
  utimesSync(join(vault, path), when, when);
}

test("a note declaring a future instant does not outrank the present (end to end)", async () => {
  // The reviewer's reproduction, verbatim in shape: four notes with
  // identical searchable content.
  writeMd(vault, "notes/c.md", noteMd("2999-01-01T00:00:00Z", "cee", "clamp"));
  writeMd(vault, "notes/b.md", noteMd(isoDaysAgo(30), "bee", "clamp"));
  writeMd(vault, "notes/a.md", noteMd(null, "aye", "clamp"));
  writeMd(vault, "notes/d.md", noteMd(null, "dee", "clamp"));
  pinMtimeDaysAgo("notes/c.md", 400);
  pinMtimeDaysAgo("notes/b.md", 0);
  pinMtimeDaysAgo("notes/a.md", 30);
  pinMtimeDaysAgo("notes/d.md", 400);

  const config = makeConfig({ vault, dbPath });
  await indexVault(config, { embeddings: false });

  const outcome = await search(config, { query: "chronology token clamp", limit: 10 });
  const byPath = new Map(outcome.results.map((r) => [r.path, r]));
  const c = byPath.get("notes/c.md");
  const b = byPath.get("notes/b.md");
  const a = byPath.get("notes/a.md");
  const d = byPath.get("notes/d.md");
  expect(c).toBeDefined();
  expect(b).toBeDefined();
  expect(a).toBeDefined();
  expect(d).toBeDefined();

  // The future declaration buys nothing: the note falls back to its own
  // mtime, 400 days old, which has decayed past the epsilon floor - exactly
  // where the same note sat before `authored_at` became the anchor.
  expect(c!.recencyBoost).toBe(0);
  expect(d!.recencyBoost).toBe(0);
  expect(b!.recencyBoost).toBeGreaterThan(0);
  expect(a!.recencyBoost).toBeGreaterThan(0);
  // And it no longer sits above every honestly-dated note.
  expect(b!.score).toBeGreaterThan(c!.score);
  expect(a!.score).toBeGreaterThan(c!.score);
});

test("the index refuses an instant that had not happened when it read the file", async () => {
  writeMd(vault, "notes/future.md", noteMd("2999-01-01T00:00:00Z", "future", "refuse"));
  writeMd(vault, "notes/past.md", noteMd(isoDaysAgo(30), "past", "refuse"));
  const config = makeConfig({ vault, dbPath });
  await indexVault(config, { embeddings: false });

  const outcome = await search(config, { query: "chronology token refuse", limit: 10 });
  const byPath = new Map(outcome.results.map((r) => [r.path, r]));
  const future = byPath.get("notes/future.md");
  const past = byPath.get("notes/past.md");
  expect(future).toBeDefined();
  // Refused at the boundary: the column carries an authoring instant or
  // nothing, so no consumer downstream has to re-derive the rule.
  expect(future!.authoredAt).toBeUndefined();
  expect("authoredAt" in future!).toBe(false);
  // Discriminating: a usable instant on the same run is still carried.
  expect(past).toBeDefined();
  expect(past!.authoredAt).toBeGreaterThan(0);
});

test("a pre-epoch instant is still treated as absent (the existing sentinel)", async () => {
  writeMd(vault, "notes/epoch.md", noteMd("1969-01-01T00:00:00Z", "epoch", "epoch"));
  const config = makeConfig({ vault, dbPath });
  await indexVault(config, { embeddings: false });

  const outcome = await search(config, { query: "chronology token epoch", limit: 10 });
  const hit = outcome.results.find((r) => r.path === "notes/epoch.md");
  expect(hit).toBeDefined();
  expect("authoredAt" in hit!).toBe(false);
});

// ---------------------------------------------------------------------------
// The rank-time boundary: a row already in the database.
// ---------------------------------------------------------------------------

const NOW_MS = 1_750_000_000_000;
const NOW_S = NOW_MS / 1000;

function hyd(chunkId: number, docId: number, mtime: number, authoredAt?: number): HydratedChunk {
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

const RANK_OPTS = { keywordWeight: 0.6, semanticWeight: 0.4, limit: 10, nowMs: NOW_MS };

test("the ranker refuses a future instant a legacy database already carries", () => {
  const keyword: KeywordHit[] = [
    { chunkId: 1, documentId: 10, bm25: -3 },
    { chunkId: 2, documentId: 11, bm25: -3 },
  ];
  const hydrated = new Map<number, HydratedChunk>([
    // Poisoned row: authored in the year 2999, file 400 days old.
    [1, hyd(1, 10, NOW_S - 400 * 24 * 3600, NOW_S + 300 * 365 * 24 * 3600)],
    // Honest row: authored three days ago.
    [2, hyd(2, 11, NOW_S - 3 * 24 * 3600, NOW_S - 3 * 24 * 3600)],
  ]);
  const ranked = rankResults(
    { keyword, semantic: [], hydrated, inboundLinkSources: new Map(), tagsByDoc: new Map() },
    RANK_OPTS,
  );
  const poisoned = ranked.find((r) => r.chunkId === 1)!;
  const honest = ranked.find((r) => r.chunkId === 2)!;
  expect(poisoned.recencyBoost).toBe(0);
  expect(honest.recencyBoost).toBeGreaterThan(0);
  expect(ranked[0]!.chunkId).toBe(2);
  // The ranking and the reported field agree: what the ranker will not
  // trust, it does not hand to a consumer as an authoring instant.
  expect("authoredAt" in poisoned).toBe(false);
  expect(honest.authoredAt).toBe(NOW_S - 3 * 24 * 3600);
});

test("a future instant cannot win the exact-score tie-break either", () => {
  const keyword: KeywordHit[] = [
    { chunkId: 1, documentId: 10, bm25: -3 },
    { chunkId: 2, documentId: 11, bm25: -3 },
  ];
  const mtime = NOW_S - 600 * 24 * 3600; // both decayed to exactly 0
  const hydrated = new Map<number, HydratedChunk>([
    // The poisoned row is the HIGHER chunk id on purpose: if the rung still
    // trusted its declared instant it would sort FIRST, above both the
    // honest instant and the `chunkId asc` floor of the ladder.
    [1, hyd(1, 10, mtime, NOW_S - 500 * 24 * 3600)],
    [2, hyd(2, 11, mtime, NOW_S + 300 * 365 * 24 * 3600)],
  ]);
  const ranked = rankResults(
    { keyword, semantic: [], hydrated, inboundLinkSources: new Map(), tagsByDoc: new Map() },
    RANK_OPTS,
  );
  expect(ranked[0]!.score).toBe(ranked[1]!.score);
  // Chunk 2 declares the later instant, but it is not an authoring instant,
  // so the rung sees one usable value and falls through to the ladder below.
  expect(ranked[0]!.chunkId).toBe(1);
});

test("an unpoisoned pair is byte-identical: the guard is inert without a future instant", () => {
  const keyword: KeywordHit[] = [
    { chunkId: 1, documentId: 10, bm25: -3 },
    { chunkId: 2, documentId: 11, bm25: -4 },
  ];
  const hydrated = new Map<number, HydratedChunk>([
    [1, hyd(1, 10, NOW_S - 10 * 24 * 3600, NOW_S - 10 * 24 * 3600)],
    [2, hyd(2, 11, NOW_S - 40 * 24 * 3600)],
  ]);
  const ranked = rankResults(
    { keyword, semantic: [], hydrated, inboundLinkSources: new Map(), tagsByDoc: new Map() },
    RANK_OPTS,
  );
  expect(ranked.find((r) => r.chunkId === 1)!.authoredAt).toBe(NOW_S - 10 * 24 * 3600);
  expect("authoredAt" in ranked.find((r) => r.chunkId === 2)!).toBe(false);
  expect(ranked.find((r) => r.chunkId === 1)!.recencyBoost).toBeGreaterThan(
    ranked.find((r) => r.chunkId === 2)!.recencyBoost,
  );
});
