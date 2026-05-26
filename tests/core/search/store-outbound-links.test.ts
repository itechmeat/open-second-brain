/**
 * Store support for link-graph traversal: `outboundLinkTargets` returns
 * the resolved outbound adjacency for a set of documents, and
 * `representativeChunks` returns one chunk per document (the lowest
 * chunk_index) so the traversal layer has something to surface.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";

import { Store } from "../../../src/core/search/store.ts";
import { makeConfig, createTempVault } from "../../helpers/search-fixtures.ts";

let tmp: ReturnType<typeof createTempVault>;

beforeEach(() => {
  tmp = createTempVault("store-outbound");
});
afterEach(() => {
  tmp.cleanup();
});

async function seed() {
  const store = await Store.open(makeConfig({ vault: tmp.vault, dbPath: tmp.dbPath }), {
    mode: "write",
    loadVec: false,
  });
  const a = store.upsertDocument({ path: "a.md", title: "A", contentHash: "ha", mtime: 1, size: 1 });
  const b = store.upsertDocument({ path: "b.md", title: "B", contentHash: "hb", mtime: 1, size: 1 });
  const c = store.upsertDocument({ path: "c.md", title: "C", contentHash: "hc", mtime: 1, size: 1 });
  const aChunks = store.replaceChunks(a, [
    { chunkIndex: 0, content: "alpha head", contentHash: "a0", startLine: 1, endLine: 1, tokenCount: 2 },
    { chunkIndex: 1, content: "alpha tail", contentHash: "a1", startLine: 2, endLine: 2, tokenCount: 2 },
  ]);
  store.replaceChunks(b, [
    { chunkIndex: 0, content: "beta body", contentHash: "b0", startLine: 1, endLine: 1, tokenCount: 2 },
  ]);
  store.replaceChunks(c, [
    { chunkIndex: 0, content: "gamma body", contentHash: "c0", startLine: 1, endLine: 1, tokenCount: 2 },
  ]);
  // a -> b (wikilink), a -> c (markdown_link), a -> a (self, must be ignored),
  // a -> #tag (tag, must be ignored for traversal).
  store.replaceLinks(a, [
    { sourceChunkId: aChunks[0]!, targetPath: "b.md", linkText: "B", linkType: "wikilink" },
    { sourceChunkId: aChunks[0]!, targetPath: "c.md", linkText: "C", linkType: "markdown_link" },
    { sourceChunkId: aChunks[0]!, targetPath: "a.md", linkText: "A", linkType: "wikilink" },
    { sourceChunkId: aChunks[0]!, targetPath: null, linkText: "topic", linkType: "tag" },
  ]);
  store.resolveLinkTargets();
  return { store, a, b, c };
}

test("outboundLinkTargets returns resolved wikilink/markdown targets, excluding self and tags", async () => {
  const { store, a, b, c } = await seed();
  const map = store.outboundLinkTargets([a]);
  const targets = (map.get(a) ?? []).slice().sort((x, y) => x - y);
  expect(targets).toEqual([b, c].sort((x, y) => x - y));
  await store.close();
});

test("outboundLinkTargets omits documents with no outbound links", async () => {
  const { store, b } = await seed();
  const map = store.outboundLinkTargets([b]);
  expect(map.get(b)).toBeUndefined();
  await store.close();
});

test("representativeChunks returns the lowest chunk_index per document", async () => {
  const { store, a } = await seed();
  const reps = store.representativeChunks([a]);
  const rep = reps.get(a);
  expect(rep).toBeDefined();
  expect(rep!.content).toBe("alpha head"); // chunk_index 0, not the tail
  expect(rep!.path).toBe("a.md");
  await store.close();
});
