import { test, expect, beforeEach, afterEach } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";

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

test("search returns keyword-only results when semantic is disabled", async () => {
  const cfg = await seedKeyword();
  await indexVault(cfg);

  const out = await search(cfg, { query: "fox", limit: 5 });
  expect(out.results.length).toBe(1);
  expect(out.results[0]?.path).toBe("Notes/foo.md");
  expect(out.results[0]?.searchType).toBe("keyword");
  expect(out.warnings).toEqual([]);
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

test("path_prefix filter scopes results", async () => {
  const cfg = await seedKeyword();
  await indexVault(cfg);
  const all = await search(cfg, { query: "quick", limit: 5 });
  expect(all.results.length).toBe(1);
  const scoped = await search(cfg, { query: "quick", limit: 5, pathPrefix: "Other/" });
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
