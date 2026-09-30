import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { buildExpandedFtsMatch, buildFtsMatch, runFtsQuery } from "../../../src/core/search/fts.ts";
import { FTS_MATCH_MODE } from "../../../src/core/search/fts-match-mode.ts";
import { Store } from "../../../src/core/search/store.ts";
import { createTempVault, makeConfig } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("fts");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

async function fixture() {
  const store = await Store.open(makeConfig({ vault, dbPath }), {
    mode: "write",
    loadVec: false,
  });
  const d1 = store.upsertDocument({
    path: "Notes/alpha.md",
    title: "Alpha",
    contentHash: "h1",
    mtime: 1700000000,
    size: 10,
  });
  store.replaceChunks(d1, [
    {
      chunkIndex: 0,
      content: "the quick brown fox jumps over the lazy dog",
      contentHash: "c1",
      startLine: 1,
      endLine: 1,
      tokenCount: 9,
    },
    {
      chunkIndex: 1,
      content: "брожу по тихим улицам петербурга. white nights.",
      contentHash: "c2",
      startLine: 2,
      endLine: 2,
      tokenCount: 7,
    },
  ]);
  const d2 = store.upsertDocument({
    path: "Other/beta.md",
    title: "Beta",
    contentHash: "h2",
    mtime: 1700001000,
    size: 10,
  });
  store.replaceChunks(d2, [
    {
      chunkIndex: 0,
      content: "fox in beta document repeats: fox fox fox",
      contentHash: "c3",
      startLine: 1,
      endLine: 1,
      tokenCount: 7,
    },
  ]);
  return { store, d1, d2 };
}

function clearFtsRows(): void {
  const db = new Database(dbPath);
  try {
    db.run("DELETE FROM chunk_fts");
  } finally {
    db.close();
  }
}

test("buildFtsMatch quotes tokens for safety", () => {
  expect(buildFtsMatch("hello")).toBe('"hello"');
  expect(buildFtsMatch("two words")).toBe('"two" "words"');
});

test("buildFtsMatch escapes embedded double quotes", () => {
  expect(buildFtsMatch('he said "hi"')).toBe('"he" "said" """hi"""');
});

test("buildFtsMatch ignores empty input", () => {
  expect(buildFtsMatch("")).toBe("");
  expect(buildFtsMatch("   ")).toBe("");
});

test("buildFtsMatch defangs FTS5 operator words and metacharacters", () => {
  // Without quoting, "AND" would be a boolean operator and "*" a prefix glob.
  // With other meaningful tokens present, standalone uppercase operators are
  // dropped so natural-language connector words do not over-constrain recall.
  expect(buildFtsMatch("AND foo*")).toBe('"foo*"');
  expect(buildFtsMatch("fox AND OR")).toBe('"fox"');
  expect(buildFtsMatch("AND OR")).toBe('"AND" "OR"');
});

test("runFtsQuery returns BM25-ordered hits across documents", async () => {
  const { store, d2 } = await fixture();
  const hits = runFtsQuery(store, "fox", { limit: 10 });
  expect(hits.length).toBeGreaterThanOrEqual(2);
  // Beta document has the term repeated four times → should rank above alpha.
  expect(hits[0]?.documentId).toBe(d2);
  await store.close();
});

test("runFtsQuery respects path_prefix filter", async () => {
  const { store, d1 } = await fixture();
  const hits = runFtsQuery(store, "fox", { limit: 10, pathPrefix: "Notes/" });
  expect(hits.length).toBe(1);
  expect(hits[0]?.documentId).toBe(d1);
  await store.close();
});

test("runFtsQuery finds Cyrillic content", async () => {
  const { store, d1 } = await fixture();
  const hits = runFtsQuery(store, "тихим", { limit: 10 });
  expect(hits.length).toBe(1);
  expect(hits[0]?.documentId).toBe(d1);
  await store.close();
});

test("runFtsQuery returns empty array on empty query", async () => {
  const { store } = await fixture();
  expect(runFtsQuery(store, "   ", { limit: 5 })).toEqual([]);
  await store.close();
});

test("runFtsQuery survives FTS5-operator-like queries safely", async () => {
  const { store } = await fixture();
  // Without quoting, the bare token "AND" would be a syntax error (left-hand
  // operand missing). Quoted as a phrase it's just a literal word match.
  // No row contains "AND" literally so the result is empty, but the query
  // must not throw and must not return spurious matches.
  expect(() => runFtsQuery(store, "AND", { limit: 5 })).not.toThrow();
  expect(runFtsQuery(store, "AND", { limit: 5 })).toEqual([]);
  // A query mixing operator-like tokens with a real token drops the operator
  // token and still returns natural-language matches.
  const hits = runFtsQuery(store, "fox AND", { limit: 5 });
  expect(hits.length).toBeGreaterThan(0);
  await store.close();
});

test("runFtsQuery rebuilds an empty desynced FTS table once", async () => {
  const { store, d2 } = await fixture();
  await store.close();
  clearFtsRows();

  const readStore = await Store.open(makeConfig({ vault, dbPath }), {
    mode: "read",
    loadVec: false,
  });
  const hits = runFtsQuery(readStore, "fox", { limit: 10 });

  expect(hits.length).toBeGreaterThanOrEqual(2);
  expect(hits[0]?.documentId).toBe(d2);
  await readStore.close();
});

test("match mode any OR-joins the quoted tokens (t_c5326ece)", () => {
  expect(buildFtsMatch("alpha beta", { matchMode: FTS_MATCH_MODE.any })).toBe('"alpha" OR "beta"');
});

test("caller-typed operator tokens stay dropped in both modes", () => {
  expect(buildFtsMatch("alpha AND beta")).toBe('"alpha" "beta"');
  expect(buildFtsMatch("alpha AND beta", { matchMode: FTS_MATCH_MODE.any })).toBe(
    '"alpha" OR "beta"',
  );
});

test("the default mode is byte-identical, including empty and single-token cases", () => {
  expect(buildFtsMatch("alpha")).toBe('"alpha"');
  expect(buildFtsMatch("")).toBe("");
  expect(buildFtsMatch("alpha beta")).toBe('"alpha" "beta"');
});

test("expanded composition in any mode ORs the flat group with the expansion terms", () => {
  expect(buildExpandedFtsMatch("alpha beta", ["gamma"], { matchMode: FTS_MATCH_MODE.any })).toBe(
    '("alpha" OR "beta") OR "gamma"',
  );
  expect(buildExpandedFtsMatch("alpha beta", ["gamma"])).toBe('("alpha" "beta") OR "gamma"');
});

test("runFtsQuery with matchMode any keeps the single-term document", async () => {
  // Only Notes/alpha.md (d1) carries both terms ("fox" and "nights"); in
  // the default all-mode it is the only hit, and any-mode keeps Other/beta.md (d2).
  const { store, d1, d2 } = await fixture();
  try {
    const strict = runFtsQuery(store, "fox nights", { limit: 10 });
    const widened = runFtsQuery(store, "fox nights", { limit: 10, matchMode: FTS_MATCH_MODE.any });
    expect(strict.some((h) => h.documentId === d2)).toBe(false);
    expect(widened.some((h) => h.documentId === d2)).toBe(true);
    expect(widened.some((h) => h.documentId === d1)).toBe(true);
  } finally {
    await store.close();
  }
});
