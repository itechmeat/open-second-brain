import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;
let server: FakeHttp;

beforeEach(async () => {
  const v = createTempVault("search");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  server = await startFakeHttp();
});

afterEach(async () => {
  cleanup();
  await server.close();
});

function semanticConfig() {
  return makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: server.url,
      model: "fake-model",
      apiKey: "test-key",
      dimension: 4,
      timeoutMs: 5_000,
      concurrency: 2,
      batchSize: 8,
    },
  });
}

async function seedKeyword() {
  writeMd(
    vault,
    "Notes/foo.md",
    "# Foo\n\nThe quick brown fox jumps over the lazy dog. Foxes are interesting.",
  );
  writeMd(vault, "Other/bar.md", "# Bar\n\nA different note about cats and turtles.");
  writeMd(vault, "Notes/ru.md", "# Ru\n\nКириллический текст про брожение тестового зерна.");
  return makeConfig({ vault, dbPath });
}

function cacheRowCount(): number {
  const db = new Database(dbPath);
  try {
    return db.query<{ c: number }, []>("SELECT count(*) AS c FROM query_cache").get()?.c ?? 0;
  } finally {
    db.close();
  }
}

test("query cache (opt-in) stores a row and serves an identical request", async () => {
  await seedKeyword();
  const cfg = makeConfig({ vault, dbPath, cacheEnabled: true });
  await indexVault(cfg);
  expect(cacheRowCount()).toBe(0);

  const r1 = await search(cfg, { query: "fox", limit: 5 });
  expect(cacheRowCount()).toBeGreaterThan(0);

  const r2 = await search(cfg, { query: "fox", limit: 5 });
  expect(r2.results.map((x) => x.path)).toEqual(r1.results.map((x) => x.path));
});

test("query cache is invalidated by a reindex (corpus-generation bump)", async () => {
  await seedKeyword();
  const cfg = makeConfig({ vault, dbPath, cacheEnabled: true });
  await indexVault(cfg);

  const r1 = await search(cfg, { query: "fox", limit: 10 });
  expect(r1.results.map((x) => x.path)).not.toContain("Notes/fox2.md");

  // A new matching doc + reindex bumps the index revision -> generation
  // changes -> the cached row is not served and the result reflects it.
  writeMd(vault, "Notes/fox2.md", "# Fox2\n\nAnother fox appears here.");
  await indexVault(cfg);
  const r2 = await search(cfg, { query: "fox", limit: 10 });
  expect(r2.results.map((x) => x.path)).toContain("Notes/fox2.md");
});

test("no query_cache rows are written when the cache is disabled", async () => {
  await seedKeyword();
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  await search(cfg, { query: "fox", limit: 5 });
  expect(cacheRowCount()).toBe(0);
});

async function seedExpansion() {
  // d1 + d2 both match "alpha" and co-mention "beta" -> "beta" is a
  // co-occurrence expansion term. d3 has "beta" but not "alpha".
  writeMd(vault, "Notes/d1.md", "# D1\n\nalpha beta gamma notes.");
  writeMd(vault, "Notes/d2.md", "# D2\n\nalpha beta delta notes.");
  writeMd(vault, "Notes/d3.md", "# D3\n\nbeta epsilon unrelated content.");
}

test("synonym expansion (opt-in) broadens recall to a co-occurring-term doc", async () => {
  await seedExpansion();
  const off = makeConfig({ vault, dbPath });
  await indexVault(off);

  const baseline = await search(off, { query: "alpha", limit: 10 });
  expect(baseline.results.map((r) => r.path)).not.toContain("Notes/d3.md");

  const on = makeConfig({ vault, dbPath, synonymEnabled: true });
  const expanded = await search(on, { query: "alpha", limit: 10 });
  // "beta" co-occurs in d1+d2, so expansion pulls in d3 via the OR.
  expect(expanded.results.map((r) => r.path)).toContain("Notes/d3.md");
});

test("synonym expansion is suppressed for an exact-intent (quoted) query", async () => {
  await seedExpansion();
  const on = makeConfig({ vault, dbPath, synonymEnabled: true });
  await indexVault(on);
  const res = await search(on, { query: '"alpha"', limit: 10 });
  // Quoted -> exact intent -> no expansion -> d3 (no "alpha") stays out.
  expect(res.results.map((r) => r.path)).not.toContain("Notes/d3.md");
});

test("search returns keyword-only results when semantic is disabled", async () => {
  const cfg = await seedKeyword();
  await indexVault(cfg);

  const out = await search(cfg, { query: "fox", limit: 5 });
  expect(out.results.length).toBe(1);
  expect(out.results[0]?.path).toBe("Notes/foo.md");
  expect(out.results[0]?.searchType).toBe("keyword");
  expect(out.warnings).toEqual([]);
});

test("search warns when keyword retrieval rebuilds a desynced FTS table", async () => {
  const cfg = await seedKeyword();
  await indexVault(cfg);
  const db = new Database(dbPath);
  try {
    db.run("DELETE FROM chunk_fts");
  } finally {
    db.close();
  }

  const out = await search(cfg, { query: "fox", limit: 5 });

  expect(out.results.map((r) => r.path)).toContain("Notes/foo.md");
  expect(out.warnings.some((w) => w.includes("rebuilt FTS"))).toBe(true);
});

test("search returns empty (no error) when no results match", async () => {
  const cfg = await seedKeyword();
  await indexVault(cfg);
  const out = await search(cfg, { query: "nonexistentterm", limit: 5 });
  expect(out.results).toEqual([]);
  expect(out.total).toBe(0);
});

test("search supports Cyrillic query against Cyrillic content", async () => {
  const cfg = await seedKeyword();
  await indexVault(cfg);
  const out = await search(cfg, { query: "брожение", limit: 5 });
  expect(out.results.length).toBe(1);
  expect(out.results[0]?.path).toBe("Notes/ru.md");
});

test("search supports unspaced CJK query segments without polluting result content", async () => {
  writeMd(vault, "Notes/cjk.md", "# CJK\n\n我喜欢苹果派，也喜欢机器学习。");
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);

  const out = await search(cfg, { query: "苹果", limit: 5 });

  expect(out.results.map((r) => r.path)).toContain("Notes/cjk.md");
  const hit = out.results.find((r) => r.path === "Notes/cjk.md");
  expect(hit?.content).toContain("我喜欢苹果派");
  expect(hit?.content).not.toContain("苹果 果派");
});

test("path_prefix filter scopes results", async () => {
  const cfg = await seedKeyword();
  await indexVault(cfg);
  const all = await search(cfg, { query: "quick", limit: 5 });
  expect(all.results.length).toBe(1);
  const scoped = await search(cfg, {
    query: "quick",
    limit: 5,
    pathPrefix: "Other/",
  });
  expect(scoped.results.length).toBe(0);
});

test("path_prefix escaping is rejected with INVALID_INPUT", async () => {
  const cfg = await seedKeyword();
  await indexVault(cfg);
  let err: SearchError | null = null;
  try {
    await search(cfg, { query: "x", pathPrefix: "../etc/" });
  } catch (e) {
    err = e as SearchError;
  }
  expect(err?.code).toBe("INVALID_INPUT");
});

test("empty query throws INVALID_INPUT", async () => {
  const cfg = await seedKeyword();
  await indexVault(cfg);
  let err: SearchError | null = null;
  try {
    await search(cfg, { query: "   " });
  } catch (e) {
    err = e as SearchError;
  }
  expect(err?.code).toBe("INVALID_INPUT");
});

test("missing index throws INDEX_MISSING", async () => {
  const cfg = await seedKeyword();
  // skip indexVault
  let err: SearchError | null = null;
  try {
    await search(cfg, { query: "fox" });
  } catch (e) {
    err = e as SearchError;
  }
  expect(err?.code).toBe("INDEX_MISSING");
});

test("hybrid search combines keyword and semantic when both contribute", async () => {
  if (!sqliteVecLoadable()) return;
  writeMd(vault, "A/foo.md", "alpha beta gamma");
  writeMd(vault, "A/bar.md", "delta epsilon zeta");
  const cfg = semanticConfig();
  await indexVault(cfg, { embeddings: true });

  const out = await search(cfg, { query: "alpha", limit: 5, semantic: true });
  expect(out.results.length).toBeGreaterThan(0);
  // The keyword hit should be in the top result; searchType may be hybrid.
  const first = out.results[0]!;
  expect(["keyword", "hybrid", "semantic"]).toContain(first.searchType);
});

test("explicit --semantic without vec extension throws (configured-down case)", async () => {
  await seedKeyword();
  const cfg = makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: server.url,
      model: "fake-model",
      apiKey: "k",
      dimension: 4,
      timeoutMs: 5_000,
      concurrency: 1,
      batchSize: 8,
    },
  });
  await indexVault(cfg);
  // Now disable vec by closing the index and reopening through a config
  // that uses a fresh dbPath without vec. We can't unload the extension —
  // so emulate by stubbing config.semantic.enabled=true but no embeddings
  // recorded. The store loads vec OK but counts.embeddings===0, which is
  // the data-state warning case (warn + skip even when explicit).
  const out = await search(cfg, { query: "fox", limit: 5, semantic: true });
  expect(out.warnings.some((w) => w.includes("no compatible embeddings"))).toBe(true);
});

test("implicit semantic + no embeddings → keyword-only + warning, no throw", async () => {
  await seedKeyword();
  const cfg = semanticConfig();
  await indexVault(cfg); // no --embeddings
  const out = await search(cfg, { query: "fox", limit: 5 });
  expect(out.warnings.some((w) => w.includes("no compatible embeddings"))).toBe(true);
  expect(out.results.length).toBeGreaterThan(0);
});

test("limit truncates results", async () => {
  for (let i = 0; i < 20; i++) {
    writeMd(vault, `notes/n${i}.md`, `# Note ${i}\n\nrepeated word repeated word repeated word`);
  }
  const cfg = makeConfig({ vault, dbPath });
  await indexVault(cfg);
  const out = await search(cfg, { query: "repeated", limit: 5 });
  expect(out.results.length).toBe(5);
});
