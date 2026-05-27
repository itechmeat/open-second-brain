/**
 * Store support for entity-boosted retrieval: `replaceEntities` writes
 * a chunk's entity set (replacing any prior set), and
 * `chunkEntityMatches` counts how many query entities each candidate
 * chunk shares - the raw signal the ranker turns into a capped boost.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { Store } from "../../../src/core/search/store.ts";
import { makeConfig, createTempVault } from "../../helpers/search-fixtures.ts";

let tmp: ReturnType<typeof createTempVault>;

beforeEach(() => {
  tmp = createTempVault("store-entities");
});
afterEach(() => {
  tmp.cleanup();
});

async function open() {
  return Store.open(makeConfig({ vault: tmp.vault, dbPath: tmp.dbPath }), {
    mode: "write",
    loadVec: false,
  });
}

async function seedChunk(store: Store): Promise<number> {
  const doc = store.upsertDocument({
    path: "a.md",
    title: "A",
    contentHash: "h",
    mtime: 1,
    size: 1,
  });
  const ids = store.replaceChunks(doc, [
    { chunkIndex: 0, content: "body", contentHash: "c0", startLine: 1, endLine: 1, tokenCount: 1 },
  ]);
  return ids[0]!;
}

test("replaceEntities stores a chunk's entity set", async () => {
  const store = await open();
  const chunkId = await seedChunk(store);
  store.replaceEntities(chunkId, ["pay memory", "sergey"]);
  const matches = store.chunkEntityMatches([chunkId], ["pay memory"]);
  expect(matches.get(chunkId)).toBe(1);
  await store.close();
});

test("replaceEntities replaces the prior set rather than appending", async () => {
  const store = await open();
  const chunkId = await seedChunk(store);
  store.replaceEntities(chunkId, ["alpha", "beta"]);
  store.replaceEntities(chunkId, ["gamma"]);
  const matches = store.chunkEntityMatches([chunkId], ["alpha", "beta", "gamma"]);
  expect(matches.get(chunkId)).toBe(1); // only gamma remains
  await store.close();
});

test("chunkEntityMatches counts distinct query-entity overlaps per chunk", async () => {
  const store = await open();
  const chunkId = await seedChunk(store);
  store.replaceEntities(chunkId, ["pay memory", "sergey", "fts5"]);
  const matches = store.chunkEntityMatches([chunkId], ["pay memory", "fts5", "absent"]);
  expect(matches.get(chunkId)).toBe(2);
  await store.close();
});

test("chunkEntityMatches returns empty when there are no query entities", async () => {
  const store = await open();
  const chunkId = await seedChunk(store);
  store.replaceEntities(chunkId, ["alpha"]);
  expect(store.chunkEntityMatches([chunkId], []).size).toBe(0);
  await store.close();
});
