/**
 * The `search.*` status block over MCP names held chunks by COUNT, not
 * by path. The items list is an operator diagnostic - `o2b search status`
 * and the doctor show it at local reach - while `second_brain_status`
 * reaches callers a transport may serve at `remote` reach, and a held
 * chunk's path is exactly the location a reservation may want kept off
 * the wire. The total travels; the paths stay local.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { indexStatus } from "../../src/core/search/indexer.ts";
import { resolveSearchConfig } from "../../src/core/search/index.ts";
import { Store } from "../../src/core/search/store.ts";
import { chunkHoldExclusion } from "../../src/core/search/embedding-spend.ts";
import {
  declaredInputWindowTokens,
  RECOMMENDED_EMBEDDING_MODEL,
} from "../../src/core/search/embeddings/presets.ts";
import { buildSearchStatusBlock } from "../../src/mcp/search-tools.ts";
import { createTempVault } from "../helpers/search-fixtures.ts";
import { FAKE_PROVIDER_KEY } from "../helpers/fake-credentials.ts";

const WINDOW = declaredInputWindowTokens(RECOMMENDED_EMBEDDING_MODEL)!;

let tmp: ReturnType<typeof createTempVault>;
let configPath: string;

beforeEach(() => {
  tmp = createTempVault("mcp-held-chunks");
  configPath = join(tmp.vault, "config.yaml");
  atomicWriteFileSync(
    configPath,
    `vault: ${tmp.vault}\n` +
      "search_semantic_enabled: true\n" +
      "embedding_provider: openai-compat\n" +
      "embedding_base_url: https://mcp-held.invalid/v1\n" +
      `embedding_model: ${RECOMMENDED_EMBEDDING_MODEL}\n` +
      `embedding_api_key: ${FAKE_PROVIDER_KEY}\n` +
      "embedding_dimension: 4\n",
  );
});

afterEach(() => tmp.cleanup());

test("the MCP status block reports held chunks as a total, without item paths", async () => {
  const config = resolveSearchConfig({ vault: tmp.vault, configPath });
  const store = await Store.open(config, { mode: "write" });
  let chunkId: number;
  try {
    const docId = store.upsertDocument({
      path: "Brain/note.md",
      title: "note",
      contentHash: "h1",
      mtime: 1_700_000_000,
      size: 10,
    });
    store.replaceChunks(docId, [
      {
        chunkIndex: 0,
        content: "a chunk",
        contentHash: "h1-0",
        startLine: 1,
        endLine: 2,
        tokenCount: 2,
      },
    ]);
    const db = new Database(config.dbPath);
    try {
      chunkId = db.query<{ id: number }, []>("SELECT id FROM chunks ORDER BY id LIMIT 1").get()!.id;
    } finally {
      db.close();
    }
    const exclusion = chunkHoldExclusion(config)!;
    store.recordChunkHolds([{ chunkId, estimatedTokens: WINDOW + 1, windowTokens: WINDOW }], {
      model: exclusion.model,
      embeddingSignature: exclusion.embeddingSignature,
    });
  } finally {
    await store.close();
  }
  // The operator surface still names the paths.
  const status = await indexStatus(config);
  expect(status.heldChunks?.total).toBe(1);
  expect(status.heldChunks?.items[0]!.path).toBe("Brain/note.md");

  const block = (await buildSearchStatusBlock({ vault: tmp.vault, configPath } as never)) as Record<
    string,
    unknown
  >;
  const held = block["held_chunks"] as { total: number; items?: unknown } | undefined;
  expect(held).toBeDefined();
  expect(held!.total).toBe(1);
  expect(held!.items).toBeUndefined();
});
