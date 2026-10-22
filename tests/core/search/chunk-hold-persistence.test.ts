/**
 * Chunk skip-and-hold, persistence and the pending exclusion (Lane B,
 * task B2): the hold a phase decides is a RECORD, not just a filter.
 *
 * The point of the persistent hold is that the index stops OWING the
 * provably-over chunk: it leaves the pending-vector anti-join, so the
 * status refresh estimate, the backfill dry run and the spend preview all
 * stop pricing work the run will refuse to spend anyway. The exclusion is
 * keyed by (model, window_tokens, embedding_signature): a window or model
 * change makes the stored key not match, which RELEASES the hold back
 * into pending with no migration and no delete pass - the next phase
 * decides fresh, and either embeds (releasing) or re-records (keeping).
 *
 * The release direction is what makes the key honest. An unchanged config
 * must keep the chunk held without any new provider contact - the second
 * run's census no longer even contains it.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { runEmbeddingPhase, type EmbeddingPhaseTally } from "../../../src/core/search/indexer.ts";
import { estimatePendingEmbeddingSpend } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import {
  chunkHoldExclusion,
  planEmbeddingSpend,
} from "../../../src/core/search/embedding-spend.ts";
import type { ChunkHoldExclusion } from "../../../src/core/search/store/chunks.ts";
import {
  declaredInputWindowTokens,
  RECOMMENDED_EMBEDDING_MODEL,
} from "../../../src/core/search/embeddings/presets.ts";
import {
  embeddingSignature,
  textExtent,
  tokenHoldFloor,
} from "../../../src/core/search/embeddings/signature.ts";
import type {
  ResolvedEmbeddingConfig,
  ResolvedSearchConfig,
} from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig } from "../../helpers/search-fixtures.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";

const WINDOW = declaredInputWindowTokens(RECOMMENDED_EMBEDDING_MODEL)!;

/**
 * An ordinary English sentence, assembled into a fixture of an exact
 * code-point size: the hold's proof reads code points, and a fixture
 * shaped like the corpus keeps the persistence tests honest about which
 * chunks a real tokenizer cannot fit.
 */
const PROSE_SENTENCE =
  "The survey team recorded every measurement in the ledger before the storm reached the harbour wall. ";

/**
 * The conservative hold bound already exceeds the window: even at one
 * token per twelve code points - far below what this prose costs a real
 * tokenizer - it cannot fit, so it gets held.
 */
const OVER_CONTENT = PROSE_SENTENCE.repeat(
  Math.ceil((WINDOW * 12 + 1) / PROSE_SENTENCE.length),
).slice(0, WINDOW * 12 + 1);
const HELD_TOKENS = tokenHoldFloor(textExtent(OVER_CONTENT));
const FITTING = "small chunk of ordinary prose";

let vault: string;
let dbPath: string;
let cleanup: () => void;
let server: FakeHttp | null = null;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("chunk-hold-persistence"));
});

afterEach(async () => {
  await server?.close();
  server = null;
  cleanup();
});

async function startProvider(): Promise<void> {
  server = await startFakeHttp();
}

function cfg(semantic: Partial<ResolvedEmbeddingConfig> = {}): ResolvedSearchConfig {
  return makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: server!.url,
      model: RECOMMENDED_EMBEDDING_MODEL,
      apiKey: FAKE_PROVIDER_KEY,
      ...semantic,
    },
  });
}

async function openSeeded(config: ResolvedSearchConfig, contents: string[]): Promise<Store> {
  const store = await Store.open(config, { mode: "write" });
  const docId = store.upsertDocument({
    path: "Brain/note.md",
    title: "note",
    contentHash: "h1",
    mtime: 1_700_000_000,
    size: 10,
  });
  store.replaceChunks(
    docId,
    contents.map((content, i) => ({
      chunkIndex: i,
      content,
      contentHash: `h1-${i}`,
      startLine: 1,
      endLine: 2,
      tokenCount: content.length,
    })),
  );
  return store;
}

function chunkIdByLength(length: number): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    const row = db
      .query<{ id: number }, [number]>("SELECT id FROM chunks WHERE length(content) = ?")
      .get(length);
    if (!row) throw new Error(`no chunk of length ${length} in the seeded index`);
    return row.id;
  } finally {
    db.close();
  }
}

function embeddedChunkIds(): number[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<{ chunk_id: number }, []>("SELECT chunk_id FROM embeddings ORDER BY chunk_id")
      .all()
      .map((r) => r.chunk_id);
  } finally {
    db.close();
  }
}

const EMPTY_TALLY = (): EmbeddingPhaseTally => ({ embeddingsComputed: 0, embeddingsRetries: 0 });

/**
 * Seed one provably-over chunk plus one fitting chunk, run the phase to
 * the hold, and hand back the closed vault plus the held chunk's id.
 */
async function runOnceUntilHold(): Promise<{ heldId: number }> {
  await startProvider();
  const config = cfg();
  const store = await openSeeded(config, [OVER_CONTENT, FITTING]);
  try {
    await runEmbeddingPhase(store, config, EMPTY_TALLY(), {});
  } finally {
    await store.close();
  }
  return { heldId: chunkIdByLength(OVER_CONTENT.length) };
}

// ── the hold is a record ─────────────────────────────────────────────────────

test("the phase persists a hold row keyed by model, window and signature", async () => {
  const { heldId } = await runOnceUntilHold();
  const config = cfg();
  const rows = (() => {
    const db = new Database(dbPath, { readonly: true });
    try {
      return db
        .query<
          {
            chunk_id: number;
            model: string;
            window_tokens: number;
            embedding_signature: string;
            estimated_tokens: number;
            held_at: string;
          },
          []
        >("SELECT * FROM chunk_embedding_holds ORDER BY chunk_id")
        .all();
    } finally {
      db.close();
    }
  })();
  expect(rows.length).toBe(1);
  expect(rows[0]!.chunk_id).toBe(heldId);
  expect(rows[0]!.model).toBe(RECOMMENDED_EMBEDDING_MODEL);
  expect(rows[0]!.window_tokens).toBe(WINDOW);
  expect(rows[0]!.embedding_signature).toBe(
    embeddingSignature({
      provider: "openai-compat",
      model: RECOMMENDED_EMBEDDING_MODEL,
      dimension: config.semantic.dimension,
    }),
  );
  expect(rows[0]!.estimated_tokens).toBe(HELD_TOKENS);
  expect(Number.isNaN(Date.parse(rows[0]!.held_at))).toBe(false);
});

test("a held chunk leaves the pending census, the count, the plan and the preview", async () => {
  const { heldId } = await runOnceUntilHold();
  const config = cfg();
  const store = await Store.open(config, { mode: "write" });
  try {
    const hold = chunkHoldExclusion(config);
    expect(hold).not.toBeNull();
    // Config-aware reads exclude the held chunk...
    expect(
      store.findChunksWithoutEmbeddings(undefined, hold ?? undefined).map((p) => p.chunkId),
    ).toEqual([]);
    expect(store.countChunksWithoutEmbeddings(undefined, hold ?? undefined)).toBe(0);
    expect(planEmbeddingSpend(store, config).pending.map((p) => p.chunkId)).toEqual([]);
    // ...and the key-free diagnostic read still sees the missing vector:
    // the chunk genuinely has none, which is a fact the hold does not erase.
    expect(store.countChunksWithoutEmbeddings()).toBe(1);
  } finally {
    await store.close();
  }
  expect(embeddedChunkIds()).not.toContain(heldId);
  // The maintenance preview reads the plan: with nothing pending it
  // cannot spend, exactly as an embedded-clean vault reports.
  expect(await estimatePendingEmbeddingSpend(config)).toBeNull();
});

test("a second run with the same config never re-embeds and never re-spends", async () => {
  await runOnceUntilHold();
  const callsBefore = server!.callCount();
  const config = cfg();
  const store = await Store.open(config, { mode: "write" });
  const tally = EMPTY_TALLY();
  try {
    await runEmbeddingPhase(store, config, tally, {});
  } finally {
    await store.close();
  }
  // The held chunk is gone from the phase's own census: it is not even
  // re-decided, and the tally says nothing was held this run.
  expect(tally.embeddingsHeld).toBeUndefined();
  expect(tally.embeddingsComputed).toBe(0);
  expect(server!.callCount()).toBe(callsBefore);
});

// ── release on key change ────────────────────────────────────────────────────

test("raising the declared window releases the hold and the chunk embeds", async () => {
  const { heldId } = await runOnceUntilHold();
  const wider = cfg({ inputWindowTokens: WINDOW * 4 });
  const store = await Store.open(wider, { mode: "write" });
  try {
    // The stored key (window WINDOW) no longer matches: pending again.
    const hold = chunkHoldExclusion(wider);
    expect(store.countChunksWithoutEmbeddings(undefined, hold ?? undefined)).toBe(1);
    const before = server!.callCount();
    await runEmbeddingPhase(store, wider, EMPTY_TALLY(), {});
    expect(server!.callCount()).toBeGreaterThan(before);
  } finally {
    await store.close();
  }
  expect(embeddedChunkIds()).toContain(heldId);
});

test("a model change releases the hold under the old model's key", async () => {
  const { heldId } = await runOnceUntilHold();
  const other = cfg({ model: "BAAI/bge-m3" });
  const store = await Store.open(other, { mode: "write" });
  try {
    // A model change also trips the pre-existing clear-on-model-change
    // path, so the whole corpus is pending again; counting would not
    // isolate the hold's release. What the hold itself promises is
    // checked by id: the stored row survives under the OLD key and
    // excludes under it, and the NEW key's census contains the chunk.
    const [holdRow] = store.chunkHoldRowsFor(heldId);
    expect(holdRow).toBeDefined();
    const oldKey: ChunkHoldExclusion = {
      model: holdRow!.model,
      windowTokens: holdRow!.windowTokens,
      embeddingSignature: holdRow!.embeddingSignature,
    };
    const pendingUnderOldKey = store
      .findChunksWithoutEmbeddings(undefined, oldKey)
      .map((r) => r.chunkId);
    expect(pendingUnderOldKey).not.toContain(heldId);
    const hold = chunkHoldExclusion(other);
    const pendingUnderNewKey = store
      .findChunksWithoutEmbeddings(undefined, hold ?? undefined)
      .map((r) => r.chunkId);
    expect(pendingUnderNewKey).toContain(heldId);
  } finally {
    await store.close();
  }
  // bge-m3's declared window bounds the proof the other way: under the
  // new model the chunk simply fits, so the releasing run embeds it.
  expect(declaredInputWindowTokens("BAAI/bge-m3")! > HELD_TOKENS).toBe(true);
  const store2 = await Store.open(other, { mode: "write" });
  const tally = EMPTY_TALLY();
  try {
    await runEmbeddingPhase(store2, other, tally, {});
  } finally {
    await store2.close();
  }
  expect(embeddedChunkIds()).toContain(heldId);
  expect(tally.embeddingsHeld).toBeUndefined();
});

test("holding again refreshes the row rather than duplicating it", async () => {
  const { heldId } = await runOnceUntilHold();
  // No release and no re-decide under a new key: this test exercises only
  // the SAME-key path, re-recording the hold under the original
  // (model, embedding signature) key.
  const original = cfg();
  const store = await Store.open(original, { mode: "write" });
  try {
    // Same-key re-decision re-records through the primary key rather than
    // stacking a second row for one chunk.
    store.recordChunkHolds(
      [{ chunkId: heldId, estimatedTokens: HELD_TOKENS, windowTokens: WINDOW }],
      {
        model: RECOMMENDED_EMBEDDING_MODEL,
        embeddingSignature: chunkHoldExclusion(original)!.embeddingSignature,
      },
    );
  } finally {
    await store.close();
  }
  const db = new Database(dbPath, { readonly: true });
  try {
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunk_embedding_holds").get()?.n,
    ).toBe(1);
  } finally {
    db.close();
  }
});

// ── no proof, no record ──────────────────────────────────────────────────────

test("an undeclared window holds nothing and records nothing", async () => {
  await startProvider();
  const config = cfg({ model: "acme/custom-embed-9000" });
  const store = await openSeeded(config, [OVER_CONTENT]);
  try {
    await runEmbeddingPhase(store, config, EMPTY_TALLY(), {});
  } finally {
    await store.close();
  }
  expect(chunkHoldExclusion(config)).toBeNull();
  const db = new Database(dbPath, { readonly: true });
  try {
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunk_embedding_holds").get()?.n,
    ).toBe(0);
  } finally {
    db.close();
  }
});

test("deleting the chunk rows drops the hold rows with them", async () => {
  const { heldId } = await runOnceUntilHold();
  // The document's chunk rows die on a re-index that no longer holds
  // them; the FK cascade must take the hold with them. Exercised through
  // the Store connection, which is the one that enforces foreign keys.
  const config = cfg();
  const store = await Store.open(config, { mode: "write" });
  try {
    const docId = (() => {
      const db = new Database(dbPath);
      try {
        return db
          .query<{ document_id: number }, [number]>("SELECT document_id FROM chunks WHERE id = ?")
          .get(heldId)!.document_id;
      } finally {
        db.close();
      }
    })();
    store.replaceChunks(docId, []);
    expect(store.chunkHoldRowsFor(heldId)).toEqual([]);
  } finally {
    await store.close();
  }
});
