/**
 * F2 chunk skip-and-hold (Lane B, task B1): the embedding phase holds
 * chunks whose token estimate PROVABLY exceeds the model's effective
 * declared input window.
 *
 * "Provably" is the whole unit. The estimator is two-sided (floor
 * `ceil(codePoints/4)`, ceiling charging every non-ASCII code point a
 * full token), and only the floor clearing the window is a fact - the
 * undecided band between the two bounds stays embedded exactly as before
 * this feature existed, because holding there would act on a guess. A
 * model with no declared window (outside the curated preset table and no
 * operator `embedding_input_window_tokens`) proves nothing, so nothing
 * is held for it; declaring the window is what arms the hold.
 *
 * The hold is a FILTER before batching, so whatever the provider does
 * receive still answers 1:1 (the batch invariant in `runEmbeddingPhase`
 * compares vector counts against its own batch), and what is held never
 * reaches `vecUpsert` - no embeddings row, no vector, no spend. A run
 * that holds every pending chunk therefore also prices nothing: the cost
 * gate reads the embeddable census, not the held one, so held work can
 * neither trip a refusal nor appear on the receipt.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { runEmbeddingPhase, type EmbeddingPhaseTally } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import {
  declaredInputWindowTokens,
  RECOMMENDED_EMBEDDING_MODEL,
} from "../../../src/core/search/embeddings/presets.ts";
import { chunkHoldExclusion } from "../../../src/core/search/embedding-spend.ts";
import { signatureIdentityKnown } from "../../../src/core/search/embeddings/signature.ts";
import {
  charLengthOverTokenBudget,
  estimateTokens,
  LOCAL_EMBEDDING_MODEL,
} from "../../../src/core/search/embeddings/signature.ts";
import { CHUNK_HOLD_REASON } from "../../../src/core/search/types.ts";
import type {
  ResolvedEmbeddingConfig,
  ResolvedSearchConfig,
} from "../../../src/core/search/types.ts";
import { createTempVault, makeConfig } from "../../helpers/search-fixtures.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";

/** The curated window of the shipped recommendation, read from the table. */
const WINDOW = declaredInputWindowTokens(RECOMMENDED_EMBEDDING_MODEL)!;

/** A model string deliberately outside the curated preset table. */
const UNCURATED_MODEL = "acme/custom-embed-9000";

/** Comfortably under any window. */
const FITTING = "small chunk of ordinary prose";

/** The LOW estimate already exceeds the window: provably over. */
const OVER_CONTENT = "b".repeat(charLengthOverTokenBudget(WINDOW) + 1);
const OVER_FLOOR = Math.ceil(OVER_CONTENT.length / 4);

/**
 * The undecided band: floor `ceil(2048/4)` equals the window (fits), the
 * ceiling charges each Cyrillic code point a full token (far over). The
 * census reports this band; the hold must never act on it.
 */
const UNDECIDED_CONTENT = "е".repeat(charLengthOverTokenBudget(WINDOW));

let vault: string;
let dbPath: string;
let cleanup: () => void;
let server: FakeHttp | null = null;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("embed-window-hold"));
});

afterEach(async () => {
  await server?.close();
  server = null;
  cleanup();
});

/**
 * Start the fake provider capturing every input text it receives and
 * answering exactly one 4-dimensional vector per input.
 */
async function captureProvider(): Promise<string[]> {
  server = await startFakeHttp();
  const sent: string[] = [];
  server.setHandler((req) => {
    const body = (req.body ?? {}) as { input?: unknown };
    const inputs = Array.isArray(body.input) ? (body.input as string[]) : [];
    sent.push(...inputs);
    return {
      status: 200,
      body: {
        data: inputs.map((text, index) => ({
          object: "embedding",
          embedding: [text.length, index, 1, 1],
          index,
        })),
        model: "fake",
      },
    };
  });
  return sent;
}

function cfg(semantic: Partial<ResolvedEmbeddingConfig> = {}): ResolvedSearchConfig {
  return makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      // Never contacted by the local embedder; only the openai-compat
      // tests point it at the fake server.
      baseUrl: server?.url ?? "https://embeddings.invalid/v1",
      model: RECOMMENDED_EMBEDDING_MODEL,
      apiKey: FAKE_PROVIDER_KEY,
      ...semantic,
    },
  });
}

/** A write-mode store seeded with one document carrying `contents`. */
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

/** The chunk row of exactly `length` code points (SQL counts code points). */
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

/** Chunk ids that carry a stored vector after the run. */
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

// ── the hold filter ──────────────────────────────────────────────────────────

test("a provably-over chunk is never sent while fitting and undecided-band chunks are", async () => {
  const sent = await captureProvider();
  const store = await openSeeded(cfg(), [FITTING, OVER_CONTENT, UNDECIDED_CONTENT]);
  const tally = EMPTY_TALLY();
  try {
    await runEmbeddingPhase(store, cfg(), tally, {});
  } finally {
    await store.close();
  }
  expect(sent).toContain(FITTING);
  expect(sent).toContain(UNDECIDED_CONTENT);
  expect(sent).not.toContain(OVER_CONTENT);
  // One vector per input survived the filter: the phase would have thrown
  // on a count mismatch, and the two texts it did send are stored.
  expect(tally.embeddingsComputed).toBe(2);
  const heldId = chunkIdByLength(OVER_CONTENT.length);
  expect(embeddedChunkIds()).not.toContain(heldId);
});

test("the held content reaches no vector store: embeddings rows exactly match what was sent", async () => {
  await captureProvider();
  const store = await openSeeded(cfg(), [FITTING, OVER_CONTENT, UNDECIDED_CONTENT]);
  try {
    await runEmbeddingPhase(store, cfg(), EMPTY_TALLY(), {});
  } finally {
    await store.close();
  }
  const ids = embeddedChunkIds().toSorted();
  expect(ids).toEqual(
    [chunkIdByLength(FITTING.length), chunkIdByLength(UNDECIDED_CONTENT.length)].toSorted(),
  );
});

// ── the tally ────────────────────────────────────────────────────────────────

test("the phase records each held chunk with its floor estimate, the window and the reason", async () => {
  await captureProvider();
  const store = await openSeeded(cfg(), [FITTING, OVER_CONTENT, UNDECIDED_CONTENT]);
  const tally = EMPTY_TALLY();
  try {
    await runEmbeddingPhase(store, cfg(), tally, {});
  } finally {
    await store.close();
  }
  expect(tally.embeddingsHeld).toBe(1);
  expect(tally.heldChunks).toEqual([
    {
      chunkId: chunkIdByLength(OVER_CONTENT.length),
      estimatedTokens: OVER_FLOOR,
      windowTokens: WINDOW,
      reason: CHUNK_HOLD_REASON.overDeclaredWindow,
    },
  ]);
});

test("a run that holds nothing records no hold tally at all", async () => {
  await captureProvider();
  const store = await openSeeded(cfg(), [FITTING]);
  const tally = EMPTY_TALLY();
  try {
    await runEmbeddingPhase(store, cfg(), tally, {});
  } finally {
    await store.close();
  }
  expect(tally.embeddingsHeld).toBeUndefined();
  expect(tally.heldChunks).toBeUndefined();
});

// ── holding is not spend ─────────────────────────────────────────────────────

test("everything held: no provider call, no receipt, no refusal under a gate the held census would blow", async () => {
  const sent = await captureProvider();
  // Priced so OVER_CONTENT's floor alone exceeds the gate: pre-feature
  // this census tripped EMBEDDING_COST_GATE, which is the false alarm a
  // held chunk must never cause.
  const config = cfg({
    costGateUsd: 0.000001,
    priceOverride: { model: RECOMMENDED_EMBEDDING_MODEL, usdPerMtok: 0.05 },
  });
  const store = await openSeeded(config, [OVER_CONTENT]);
  const tally = EMPTY_TALLY();
  try {
    await runEmbeddingPhase(store, config, tally, {});
  } finally {
    await store.close();
  }
  expect(sent).toEqual([]);
  expect(server!.callCount()).toBe(0);
  expect(tally.embeddingsComputed).toBe(0);
  expect(tally.embeddingsHeld).toBe(1);
  expect(tally.spend).toBeUndefined();
});

test("the gate and the receipt read the embeddable census, not the held one", async () => {
  await captureProvider();
  const config = cfg({
    costGateUsd: 0.000001,
    priceOverride: { model: RECOMMENDED_EMBEDDING_MODEL, usdPerMtok: 0.05 },
  });
  // The fitting chunk's own priced estimate stays under the gate; the
  // held chunk would have taken the run's estimate over it.
  const store = await openSeeded(config, [FITTING, OVER_CONTENT]);
  const tally = EMPTY_TALLY();
  try {
    await runEmbeddingPhase(store, config, tally, {});
  } finally {
    await store.close();
  }
  expect(tally.embeddingsHeld).toBe(1);
  expect(tally.spend).toBeDefined();
  expect(tally.spend!.tokens).toBe(estimateTokens([FITTING]));
  expect(tally.spend!.forced).toBe(false);
});

// ── the hold only acts on proof ──────────────────────────────────────────────

test("an undeclared window proves nothing: an oversized chunk is embedded as before", async () => {
  const sent = await captureProvider();
  const config = cfg({ model: UNCURATED_MODEL });
  const store = await openSeeded(config, [OVER_CONTENT]);
  const tally = EMPTY_TALLY();
  try {
    await runEmbeddingPhase(store, config, tally, {});
  } finally {
    await store.close();
  }
  expect(sent).toContain(OVER_CONTENT);
  expect(tally.embeddingsHeld).toBeUndefined();
  expect(tally.embeddingsComputed).toBe(1);
});

test("an operator-declared window arms the hold even for an uncurated model", async () => {
  const sent = await captureProvider();
  const config = cfg({ model: UNCURATED_MODEL, inputWindowTokens: WINDOW });
  const store = await openSeeded(config, [OVER_CONTENT]);
  const tally = EMPTY_TALLY();
  try {
    await runEmbeddingPhase(store, config, tally, {});
  } finally {
    await store.close();
  }
  expect(sent).not.toContain(OVER_CONTENT);
  expect(tally.embeddingsHeld).toBe(1);
  expect(tally.embeddingsComputed).toBe(0);
});

test("the hold key changes when the sent passage prefix changes", () => {
  // The hold's proof is measured over prefix + content, so the key the
  // proof is recorded under has to answer for the prefix too: a shortened
  // or removed prefix changes what fits the window, and a key that cannot
  // see the change would keep excluding a chunk that now fits.
  const withPrefix = cfg({ passagePrefix: "passage: ", dimension: 4 });
  const shortened = cfg({ passagePrefix: "", dimension: 4 });
  const otherPrefix = cfg({ passagePrefix: "represent passage: ", dimension: 4 });
  const a = chunkHoldExclusion(withPrefix)!;
  const b = chunkHoldExclusion(shortened)!;
  const c = chunkHoldExclusion(otherPrefix)!;
  expect(a.embeddingSignature).not.toBe(b.embeddingSignature);
  expect(a.embeddingSignature).not.toBe(c.embeddingSignature);
  // The composed key still reads as a signature from the end: the
  // trailing provider:model:dimension triple is intact.
  expect(signatureIdentityKnown(a.embeddingSignature)).toBe(true);
  expect(signatureIdentityKnown(b.embeddingSignature)).toBe(true);
});

test("the local embedder has no window and holds nothing", async () => {
  const config = cfg({ provider: "local", model: LOCAL_EMBEDDING_MODEL });
  const store = await openSeeded(config, [OVER_CONTENT]);
  const tally = EMPTY_TALLY();
  try {
    await runEmbeddingPhase(store, config, tally, {});
  } finally {
    await store.close();
  }
  expect(tally.embeddingsHeld).toBeUndefined();
  expect(tally.embeddingsComputed).toBe(1);
});
