import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../../../src/core/search/store.ts";
import { LATEST_SCHEMA_VERSION } from "../../../src/core/search/schema.ts";
import { SearchError } from "../../../src/core/search/types.ts";
import type {
  ResolvedSearchConfig,
  ResolvedEmbeddingConfig,
} from "../../../src/core/search/types.ts";

let tmp: string;
let dbPath: string;

function makeConfig(overrides?: Partial<ResolvedSearchConfig>): ResolvedSearchConfig {
  const semantic: ResolvedEmbeddingConfig = Object.freeze({
    enabled: false,
    provider: "openai-compat",
    baseUrl: null,
    model: null,
    apiKey: null,
    dimension: null,
    timeoutMs: 10_000,
    concurrency: 4,
    batchSize: 32,
    costGateUsd: 0,
  });
  return Object.freeze({
    vault: tmp,
    dbPath,
    ignoreRules: Object.freeze([{ raw: ".git", kind: "name" as const }]),
    chunkSize: 800,
    chunkOverlap: 100,
    chunkMinSize: 100,
    keywordWeight: 0.6,
    semanticWeight: 0.4,
    fusionMode: "linear" as const,
    rrfK: 60,
    semantic,
    recall: Object.freeze({
      mmrLambda: 0.7,
      maxHops: 1,
      hopDecay: 0.5,
      maxExpansionPerHit: 3,
      recencyShape: 0.8,
      recencyScale: 30,
      recencyAmplitude: 0.05,
      intentEnabled: true,
      synonymEnabled: false,
      synonymMaxTerms: 3,
      cacheEnabled: false,
      cacheTtlSeconds: 300,
      relationPolarityEnabled: true,
      learnedWeightsEnabled: false,
      activationEnabled: true,
      twoPassEnabled: true,
      poolMultiplier: 3,
      selfTuningEnabled: false,
      chainStopEnabled: false,
      chainStopScore: 0.8,
    }),
    rerank: Object.freeze({
      enabled: false,
      baseUrl: null,
      model: null,
      envKey: null,
      apiKey: null,
      topK: 20,
      minScore: 0,
    }),
    shutdownGraceMs: 5_000,
    resumeReindex: false,
    ...overrides,
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-store-"));
  dbPath = join(tmp, "brain.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

test("open in write mode creates file and applies migrations", async () => {
  const store = await Store.open(makeConfig(), { mode: "write", loadVec: false });
  expect(existsSync(dbPath)).toBe(true);
  expect(store.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
  await store.close();
});

test("open in read mode throws INDEX_MISSING when file doesn't exist", async () => {
  let err: SearchError | null = null;
  try {
    await Store.open(makeConfig(), { mode: "read", loadVec: false });
  } catch (e) {
    err = e as SearchError;
  }
  expect(err?.code).toBe("INDEX_MISSING");
});

test("open in read mode succeeds after writer creates the file", async () => {
  const w = await Store.open(makeConfig(), { mode: "write", loadVec: false });
  await w.close();
  const r = await Store.open(makeConfig(), { mode: "read", loadVec: false });
  expect(r.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
  await r.close();
});

test("upsertDocument is unique on path; second call updates same id", async () => {
  const store = await Store.open(makeConfig(), { mode: "write", loadVec: false });
  const id1 = store.upsertDocument({
    path: "Daily/2026-05-16.md",
    title: "2026-05-16",
    contentHash: "h1",
    mtime: 1700000000,
    size: 12,
  });
  const id2 = store.upsertDocument({
    path: "Daily/2026-05-16.md",
    title: "renamed",
    contentHash: "h2",
    mtime: 1700000099,
    size: 22,
  });
  expect(id2).toBe(id1);

  const docs = store.listDocuments();
  expect(docs.size).toBe(1);
  expect(docs.get("Daily/2026-05-16.md")?.contentHash).toBe("h2");
  await store.close();
});

test("replaceChunks populates FTS via triggers", async () => {
  const store = await Store.open(makeConfig(), { mode: "write", loadVec: false });
  const docId = store.upsertDocument({
    path: "notes/hello.md",
    title: "Hello",
    contentHash: "h",
    mtime: 1700000000,
    size: 20,
  });
  const ids = store.replaceChunks(docId, [
    {
      chunkIndex: 0,
      content: "hello world from open second brain",
      contentHash: "c0",
      startLine: 1,
      endLine: 1,
      tokenCount: 6,
    },
    {
      chunkIndex: 1,
      content: "second chunk talks about cats and dogs",
      contentHash: "c1",
      startLine: 2,
      endLine: 2,
      tokenCount: 8,
    },
  ]);
  expect(ids.length).toBe(2);

  const hits = store.keywordTopK("brain", { limit: 10 });
  expect(hits.length).toBe(1);
  expect(hits[0]?.chunkId).toBe(ids[0]!);

  const noHits = store.keywordTopK("nonexistentterm", { limit: 10 });
  expect(noHits.length).toBe(0);
  await store.close();
});

test("replaceChunks twice replaces all old chunks", async () => {
  const store = await Store.open(makeConfig(), { mode: "write", loadVec: false });
  const docId = store.upsertDocument({
    path: "x.md",
    title: null,
    contentHash: "h",
    mtime: 0,
    size: 1,
  });
  store.replaceChunks(docId, [
    {
      chunkIndex: 0,
      content: "alpha bravo",
      contentHash: "c0",
      startLine: 1,
      endLine: 1,
      tokenCount: 2,
    },
  ]);
  store.replaceChunks(docId, [
    {
      chunkIndex: 0,
      content: "charlie delta",
      contentHash: "c1",
      startLine: 1,
      endLine: 1,
      tokenCount: 2,
    },
  ]);
  expect(store.keywordTopK("alpha", { limit: 5 }).length).toBe(0);
  expect(store.keywordTopK("charlie", { limit: 5 }).length).toBe(1);
  expect(store.getChunksByDocument(docId).length).toBe(1);
  await store.close();
});

test("deleteDocument cascades to chunks and FTS", async () => {
  const store = await Store.open(makeConfig(), { mode: "write", loadVec: false });
  const docId = store.upsertDocument({
    path: "doomed.md",
    title: null,
    contentHash: "h",
    mtime: 0,
    size: 1,
  });
  store.replaceChunks(docId, [
    {
      chunkIndex: 0,
      content: "doomed content",
      contentHash: "c",
      startLine: 1,
      endLine: 1,
      tokenCount: 2,
    },
  ]);
  expect(store.keywordTopK("doomed", { limit: 5 }).length).toBe(1);

  store.deleteDocument("doomed.md");
  expect(store.listDocuments().size).toBe(0);
  expect(store.keywordTopK("doomed", { limit: 5 }).length).toBe(0);
  await store.close();
});

test("path-prefix filter constrains keywordTopK", async () => {
  const store = await Store.open(makeConfig(), { mode: "write", loadVec: false });
  const d1 = store.upsertDocument({
    path: "A/foo.md",
    title: null,
    contentHash: "h",
    mtime: 0,
    size: 1,
  });
  const d2 = store.upsertDocument({
    path: "B/bar.md",
    title: null,
    contentHash: "h",
    mtime: 0,
    size: 1,
  });
  store.replaceChunks(d1, [
    {
      chunkIndex: 0,
      content: "alpha alpha alpha",
      contentHash: "c",
      startLine: 1,
      endLine: 1,
      tokenCount: 3,
    },
  ]);
  store.replaceChunks(d2, [
    {
      chunkIndex: 0,
      content: "alpha bravo",
      contentHash: "c",
      startLine: 1,
      endLine: 1,
      tokenCount: 2,
    },
  ]);
  const hitsA = store.keywordTopK("alpha", { limit: 10, pathPrefix: "A/" });
  expect(hitsA.length).toBe(1);
  expect(hitsA[0]?.documentId).toBe(d1);
  await store.close();
});

test("path-prefix filter treats SQL wildcard characters literally", async () => {
  const store = await Store.open(makeConfig(), { mode: "write", loadVec: false });
  const literal = store.upsertDocument({
    path: "A_/foo.md",
    title: null,
    contentHash: "h1",
    mtime: 0,
    size: 1,
  });
  const wildcardMatch = store.upsertDocument({
    path: "AB/bar.md",
    title: null,
    contentHash: "h2",
    mtime: 0,
    size: 1,
  });
  store.replaceChunks(literal, [
    {
      chunkIndex: 0,
      content: "alpha literal",
      contentHash: "c1",
      startLine: 1,
      endLine: 1,
      tokenCount: 2,
    },
  ]);
  store.replaceChunks(wildcardMatch, [
    {
      chunkIndex: 0,
      content: "alpha wildcard",
      contentHash: "c2",
      startLine: 1,
      endLine: 1,
      tokenCount: 2,
    },
  ]);
  const hits = store.keywordTopK("alpha", { limit: 10, pathPrefix: "A_/" });
  expect(hits.map((h) => h.documentId)).toEqual([literal]);
  await store.close();
});

test("counts() reflects documents/chunks", async () => {
  const store = await Store.open(makeConfig(), { mode: "write", loadVec: false });
  const d = store.upsertDocument({
    path: "a.md",
    title: null,
    contentHash: "h",
    mtime: 0,
    size: 1,
  });
  store.replaceChunks(d, [
    { chunkIndex: 0, content: "one", contentHash: "c0", startLine: 1, endLine: 1, tokenCount: 1 },
    { chunkIndex: 1, content: "two", contentHash: "c1", startLine: 2, endLine: 2, tokenCount: 1 },
  ]);
  const c = store.counts();
  expect(c.documents).toBe(1);
  expect(c.chunks).toBe(2);
  expect(c.embeddings).toBe(0);
  await store.close();
});

test("getState / setState / deleteState round-trip", async () => {
  const store = await Store.open(makeConfig(), { mode: "write", loadVec: false });
  expect(store.getState("unset")).toBeNull();
  store.setState("foo", "bar");
  expect(store.getState("foo")).toBe("bar");
  store.setState("foo", "bar2");
  expect(store.getState("foo")).toBe("bar2");
  store.deleteState("foo");
  expect(store.getState("foo")).toBeNull();
  await store.close();
});

test("ensureEmbeddingModel sets state on first call and clears on change", async () => {
  const store = await Store.open(makeConfig(), { mode: "write", loadVec: false });

  const first = store.ensureEmbeddingModel("modelA", 384);
  expect(first.wasChanged).toBe(false);
  expect(store.getState("embedding_model")).toBe("modelA");
  expect(store.getState("embedding_dimension")).toBe("384");

  // Insert a fake embedding row so we can witness clearing.
  // Bypass typed API because there's no chunk; SQLite FK would block, so use unrelated insert.
  // Instead, mimic the change against an existing chunk-less embeddings row:
  //   (skip — we verify only state cleanup; full embeddings cascade lives in store.vec.test.ts)

  const second = store.ensureEmbeddingModel("modelB", 768);
  expect(second.wasChanged).toBe(true);
  expect(store.getState("embedding_model")).toBe("modelB");
  expect(store.getState("embedding_dimension")).toBe("768");
  await store.close();
});

test("vecUpsert without sqlite-vec throws VEC_EXTENSION_UNAVAILABLE", async () => {
  const store = await Store.open(makeConfig(), { mode: "write", loadVec: false });
  expect(() => store.vecUpsert(1, [0.1, 0.2, 0.3], "m", 3, "h")).toThrow(/sqlite-vec/);
  await store.close();
});

test("schema-mismatch is surfaced on open", async () => {
  // Prepare a db at schema 2 (above LATEST=1)
  const store = await Store.open(makeConfig(), { mode: "write", loadVec: false });
  store.setState("schema_version", "99");
  await store.close();

  let err: SearchError | null = null;
  try {
    const s = await Store.open(makeConfig(), { mode: "read", loadVec: false });
    await s.close();
  } catch (e) {
    err = e as SearchError;
  }
  expect(err?.code).toBe("SCHEMA_MISMATCH");
});

test("two writers contend → second fails with INDEX_LOCKED", async () => {
  const first = await Store.open(makeConfig(), { mode: "write", loadVec: false });
  let err: SearchError | null = null;
  try {
    const second = await Store.open(makeConfig(), { mode: "write", loadVec: false });
    await second.close();
  } catch (e) {
    err = e as SearchError;
  }
  expect(err?.code).toBe("INDEX_LOCKED");
  await first.close();
}, 30_000);
