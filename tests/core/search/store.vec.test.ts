import { test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Store } from "../../../src/core/search/store.ts";
import type { ResolvedSearchConfig, ResolvedEmbeddingConfig } from "../../../src/core/search/types.ts";

let tmp: string;
let dbPath: string;

function semanticConfig(model: string, dim: number, overrides?: Partial<ResolvedSearchConfig>): ResolvedSearchConfig {
  const semantic: ResolvedEmbeddingConfig = Object.freeze({
    enabled: true,
    provider: "openai-compat",
    baseUrl: "https://x/v1",
    model,
    apiKey: "k",
    dimension: dim,
    timeoutMs: 10_000,
    concurrency: 4,
    batchSize: 32,
  });
  return Object.freeze({
    vault: tmp,
    dbPath,
    ignoreRules: Object.freeze([{ raw: ".git", kind: "name" as const }]),
    chunkSize: 800,
    chunkOverlap: 100,
    keywordWeight: 0.6,
    semanticWeight: 0.4,
    semantic,
    recall: Object.freeze({ mmrLambda: 0.7 }),
    ...(overrides ?? {}),
  });
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-vec-"));
  dbPath = join(tmp, "brain.sqlite");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function vecAvailable(): boolean {
  try {
    require("sqlite-vec");
    return true;
  } catch {
    return false;
  }
}

function unit(values: number[]): number[] {
  const norm = Math.hypot(...values);
  if (norm === 0) return values;
  return values.map((v) => v / norm);
}

test("vec round-trip when sqlite-vec is loaded", async () => {
  if (!vecAvailable()) return;
  const store = await Store.open(semanticConfig("m1", 4), { mode: "write" });
  expect(store.vecLoaded()).toBe(true);

  const docId = store.upsertDocument({
    path: "vec/a.md",
    title: null,
    contentHash: "h",
    mtime: 0,
    size: 1,
  });
  const [c0, c1] = store.replaceChunks(docId, [
    { chunkIndex: 0, content: "alpha", contentHash: "h0", startLine: 1, endLine: 1, tokenCount: 1 },
    { chunkIndex: 1, content: "bravo", contentHash: "h1", startLine: 2, endLine: 2, tokenCount: 1 },
  ]);

  store.vecUpsert(c0!, unit([1, 0, 0, 0]), "m1", 4, "eh0");
  store.vecUpsert(c1!, unit([0, 1, 0, 0]), "m1", 4, "eh1");

  // Query close to first vector → first chunk is nearest.
  const hits = store.semanticTopK(unit([0.9, 0.1, 0, 0]), { limit: 5 });
  expect(hits.length).toBe(2);
  expect(hits[0]?.chunkId).toBe(c0!);
  expect(hits[1]?.chunkId).toBe(c1!);
  expect(hits[0]!.distance).toBeLessThan(hits[1]!.distance);
  await store.close();
});

test("deleting a document leaves zero rows in chunk_vec/chunk_vec_map", async () => {
  if (!vecAvailable()) return;
  const store = await Store.open(semanticConfig("m1", 4), { mode: "write" });
  const docId = store.upsertDocument({
    path: "vec/b.md",
    title: null,
    contentHash: "h",
    mtime: 0,
    size: 1,
  });
  const [c0, c1] = store.replaceChunks(docId, [
    { chunkIndex: 0, content: "x", contentHash: "h0", startLine: 1, endLine: 1, tokenCount: 1 },
    { chunkIndex: 1, content: "y", contentHash: "h1", startLine: 2, endLine: 2, tokenCount: 1 },
  ]);
  store.vecUpsert(c0!, unit([1, 0, 0, 0]), "m1", 4, "eh0");
  store.vecUpsert(c1!, unit([0, 1, 0, 0]), "m1", 4, "eh1");

  const beforeVec = store.rawQuery<{ c: number }>("SELECT count(*) AS c FROM chunk_vec");
  const beforeMap = store.rawQuery<{ c: number }>("SELECT count(*) AS c FROM chunk_vec_map");
  expect(beforeVec[0]?.c).toBe(2);
  expect(beforeMap[0]?.c).toBe(2);

  store.deleteDocument("vec/b.md");

  const afterVec = store.rawQuery<{ c: number }>("SELECT count(*) AS c FROM chunk_vec");
  const afterMap = store.rawQuery<{ c: number }>("SELECT count(*) AS c FROM chunk_vec_map");
  expect(afterVec[0]?.c).toBe(0);
  expect(afterMap[0]?.c).toBe(0);
  await store.close();
});

test("ensureEmbeddingModel drops chunk_vec when dimension changes", async () => {
  if (!vecAvailable()) return;
  const store = await Store.open(semanticConfig("m1", 4), { mode: "write" });

  // Touch the vec table to confirm it exists.
  let tables = store.rawQuery<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_vec'",
  );
  expect(tables.length).toBe(1);

  // Change to a different model+dim.
  const change = store.ensureEmbeddingModel("m2", 8);
  expect(change.wasChanged).toBe(true);
  expect(change.previousModel).toBe("m1");
  expect(change.currentModel).toBe("m2");

  // Vec table recreated at new dim, embeddings empty.
  tables = store.rawQuery<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='chunk_vec'",
  );
  expect(tables.length).toBe(1);
  const emb = store.rawQuery<{ c: number }>("SELECT count(*) AS c FROM embeddings");
  expect(emb[0]?.c).toBe(0);
  await store.close();
});

test("dimension mismatch is rejected on vecUpsert", async () => {
  if (!vecAvailable()) return;
  const store = await Store.open(semanticConfig("m1", 4), { mode: "write" });
  const docId = store.upsertDocument({
    path: "z.md",
    title: null,
    contentHash: "h",
    mtime: 0,
    size: 1,
  });
  const [c0] = store.replaceChunks(docId, [
    { chunkIndex: 0, content: "x", contentHash: "h", startLine: 1, endLine: 1, tokenCount: 1 },
  ]);
  expect(() => store.vecUpsert(c0!, [0.1, 0.2, 0.3], "m1", 4, "eh")).toThrow(/dimension/);
  await store.close();
});
