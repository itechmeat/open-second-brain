/**
 * Chunk skip-and-hold, the bounded status report (Lane B, task B3).
 *
 * The phase tally says what one run held; the status snapshot must say
 * what the INDEX currently holds, read back from the durable record. Two
 * constraints shape the field:
 *
 *   - presence/absence byte discipline (pinned for the census beside it
 *     in chunk-window-census.test.ts): a status with nothing held emits
 *     the bytes it emitted before this field existed - absent, never an
 *     empty list, never a zero;
 *   - a bound on the wire: a vault can hold thousands of chunks after a
 *     model swap, and the status JSON is read by humans and by agents on
 *     a token budget. The list is capped and the total discloses how
 *     many the cap left out.
 *
 * Only holds under the CURRENT (model, window, signature) key are
 * reported: a row whose key no longer matches describes a decision the
 * active configuration already released, and reporting it would claim a
 * hold the next run will not honour.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { indexStatus, HELD_CHUNK_REPORT_CAP } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { chunkHoldExclusion } from "../../../src/core/search/embedding-spend.ts";
import { serializeIndexStatus } from "../../../src/core/search/serialize.ts";
import {
  declaredInputWindowTokens,
  RECOMMENDED_EMBEDDING_MODEL,
} from "../../../src/core/search/embeddings/presets.ts";
import type { ChunkHoldExclusion } from "../../../src/core/search/store/chunks.ts";
import type {
  ResolvedEmbeddingConfig,
  ResolvedSearchConfig,
} from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig } from "../../helpers/search-fixtures.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";

const WINDOW = declaredInputWindowTokens(RECOMMENDED_EMBEDDING_MODEL)!;

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("chunk-hold-report"));
});
afterEach(() => cleanup());

function cfg(semantic: Partial<ResolvedEmbeddingConfig> = {}): ResolvedSearchConfig {
  return makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      // Never contacted: status reads the index, it does not embed.
      baseUrl: "https://hold-report.invalid/v1",
      model: RECOMMENDED_EMBEDDING_MODEL,
      apiKey: FAKE_PROVIDER_KEY,
      ...semantic,
    },
  });
}

/** Seed one document with one chunk per content entry, no phase involved. */
async function seedDocument(config: ResolvedSearchConfig, path: string, contents: string[]) {
  const store = await Store.open(config, { mode: "write" });
  try {
    const docId = store.upsertDocument({
      path,
      title: path,
      contentHash: `h-${path}`,
      mtime: 1_700_000_000,
      size: contents.reduce((n, c) => n + c.length, 0),
    });
    store.replaceChunks(
      docId,
      contents.map((content, i) => ({
        chunkIndex: i,
        content,
        contentHash: `h-${path}-${i}`,
        startLine: 1,
        endLine: 2,
        tokenCount: content.length,
      })),
    );
  } finally {
    await store.close();
  }
  const db = new Database(dbPath);
  try {
    return db
      .query<{ id: number }, [string]>(
        "SELECT c.id AS id FROM chunks c JOIN documents d ON d.id = c.document_id " +
          "WHERE d.path = ? ORDER BY c.chunk_index",
      )
      .all(path)
      .map((r) => r.id);
  } finally {
    db.close();
  }
}

/** Seed and hand back the chunk id at `index`, failing loudly if absent. */
async function seedOne(
  config: ResolvedSearchConfig,
  path: string,
  contents: string[],
  index = 0,
): Promise<number> {
  const ids = await seedDocument(config, path, contents);
  const id = ids[index];
  if (id === undefined) throw new Error(`seeded ${path} with no chunk at index ${index}`);
  return id;
}

/**
 * Record holds the way the phase would, under `key` (default: the
 * current config's key) so the test controls key match explicitly.
 */
async function recordHolds(
  config: ResolvedSearchConfig,
  entries: Array<{ chunkId: number; estimatedTokens: number }>,
  key: ChunkHoldExclusion | null = chunkHoldExclusion(config),
): Promise<void> {
  const store = await Store.open(config, { mode: "write" });
  try {
    store.recordChunkHolds(
      entries.map((e) => ({ ...e, windowTokens: WINDOW })),
      { model: key!.model, embeddingSignature: key!.embeddingSignature },
    );
  } finally {
    await store.close();
  }
}

test("the snapshot names every held chunk with its path, index, estimate and window", async () => {
  const config = cfg();
  expect(chunkHoldExclusion(config)).not.toBeNull();
  const bigId = await seedOne(config, "Brain/big-note.md", [
    "x".repeat(2048),
    "a modest paragraph",
  ]);
  const anotherId = await seedOne(config, "Brain/another.md", ["y".repeat(4096)]);
  await recordHolds(config, [
    { chunkId: bigId, estimatedTokens: 512 },
    { chunkId: anotherId, estimatedTokens: 1024 },
  ]);

  const status = await indexStatus(config);
  expect(status.heldChunks?.total).toBe(2);
  // Sorted by path, then chunk index: the reader gets a stable list.
  expect(status.heldChunks?.items).toEqual([
    {
      path: "Brain/another.md",
      chunkIndex: 0,
      estimatedTokens: 1024,
      windowTokens: WINDOW,
      reason: "over_declared_window",
    },
    {
      path: "Brain/big-note.md",
      chunkIndex: 0,
      estimatedTokens: 512,
      windowTokens: WINDOW,
      reason: "over_declared_window",
    },
  ]);
});

test("a status with nothing held emits the bytes from before the field existed", async () => {
  const config = cfg();
  await seedDocument(config, "Brain/plain.md", ["a modest paragraph"]);
  const status = await indexStatus(config);
  expect("heldChunks" in status).toBe(false);
  const wire = serializeIndexStatus(status);
  expect("held_chunks" in wire).toBe(false);
  expect(JSON.stringify(wire)).not.toContain("held_chunks");
});

test("the wire maps the report to snake_case with the cap's total disclosure", async () => {
  const config = cfg();
  const heldId = await seedOne(config, "Brain/big-note.md", ["x".repeat(2048)]);
  await recordHolds(config, [{ chunkId: heldId, estimatedTokens: 512 }]);
  const wire = serializeIndexStatus(await indexStatus(config));
  expect(wire["held_chunks"]).toEqual({
    total: 1,
    items: [
      {
        path: "Brain/big-note.md",
        chunk_index: 0,
        estimated_tokens: 512,
        window_tokens: WINDOW,
        reason: "over_declared_window",
      },
    ],
  });
});

test("the list is capped and the total discloses the remainder", async () => {
  const config = cfg();
  const contents = Array.from({ length: HELD_CHUNK_REPORT_CAP + 3 }, (_, i) => `d-${i}.md`);
  const ids: Array<{ chunkId: number; estimatedTokens: number }> = [];
  for (const [i, path] of contents.entries()) {
    ids.push({
      chunkId: await seedOne(config, `Brain/${path}`, [`chunk number ${i}`]),
      estimatedTokens: 512 + i,
    });
  }
  await recordHolds(config, ids);

  const status = await indexStatus(config);
  expect(status.heldChunks?.total).toBe(HELD_CHUNK_REPORT_CAP + 3);
  expect(status.heldChunks?.items.length).toBe(HELD_CHUNK_REPORT_CAP);
});

test("a hold row whose chunk has a vector is not reported as held", async () => {
  // Window up, chunk embedded, window back: the old row matches the
  // active key again, but the chunk has a stored vector and is not held
  // back from anything. Reporting it would warn an operator about work
  // that is already done - the report answers to the same fact the
  // pending anti-join answers to.
  const config = cfg();
  const chunkId = await seedOne(config, "Brain/embedded-anyway.md", ["x".repeat(2048)]);
  await recordHolds(config, [{ chunkId, estimatedTokens: 512 }]);
  const store = await Store.open(config, { mode: "write" });
  try {
    store.ensureEmbeddingModel(RECOMMENDED_EMBEDDING_MODEL, 4, { query: "", passage: "" });
    store.vecUpsert(chunkId, [1, 0, 0, 0], RECOMMENDED_EMBEDDING_MODEL, 4, "hash-1");
  } finally {
    await store.close();
  }
  const status = await indexStatus(config);
  expect(status.heldChunks).toBeUndefined();
});

test("a row under a released key is not reported", async () => {
  const config = cfg();
  const heldId = await seedOne(config, "Brain/big-note.md", ["x".repeat(2048)]);
  const oldKey = chunkHoldExclusion(config);
  // Record under the CURRENT key, then change the key underneath the row:
  // a wider declared window is a new key, and the phase would re-decide.
  await recordHolds(config, [{ chunkId: heldId, estimatedTokens: 512 }], oldKey);
  const wider = cfg({ inputWindowTokens: WINDOW * 2 });
  const status = await indexStatus(wider);
  expect("heldChunks" in status).toBe(false);
  // The row survives as inert history rather than being deleted on read.
  const db = new Database(dbPath, { readonly: true });
  try {
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunk_embedding_holds").get()?.n,
    ).toBe(1);
  } finally {
    db.close();
  }
});

test("a config that cannot hold reports nothing even when rows exist", async () => {
  const config = cfg();
  const heldId = await seedOne(config, "Brain/big-note.md", ["x".repeat(2048)]);
  await recordHolds(config, [{ chunkId: heldId, estimatedTokens: 512 }]);
  // An uncurated model declares no window: there is no current key, so
  // there is nothing the active configuration holds.
  const uncurated = cfg({ model: "acme/custom-embed-9000" });
  expect(chunkHoldExclusion(uncurated)).toBeNull();
  const status = await indexStatus(uncurated);
  expect("heldChunks" in status).toBe(false);
});
