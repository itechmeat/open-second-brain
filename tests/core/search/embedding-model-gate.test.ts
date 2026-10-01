/**
 * Verify-before-replace gate on the embedding-model clear path
 * (t_2fbdaf70, Task 2).
 *
 * `ensureEmbeddingModel` destroys every stored vector when the configured
 * model or dimension changes. The gate refuses that clear with a named
 * error unless the corpus can actually be rebuilt: source chunks exist
 * AND the configured provider can compute embeddings
 * (`resolveSemanticCapability` not blocked). A named-model -> null-model
 * transition is never a clear at all - rebuildability cannot be verified
 * with no model configured - and must not stay silent either.
 *
 * These tests exercise `vectors.ensureEmbeddingModel` on a raw migrated
 * database, which is the level the gate lives at. The `Store` wrapper
 * must pass the gate the resolved semantic config of the opening
 * process; without that evidence the legacy clear contract applies
 * (pinned below, not silently widened).
 */

import { test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { applyMigrations } from "../../../src/core/search/schema.ts";
import { closeDatabase } from "../../../src/core/sqlite-close.ts";
import { upsertDocument } from "../../../src/core/search/store/documents.ts";
import { replaceChunks } from "../../../src/core/search/store/chunks.ts";
import {
  EMBEDDING_MODEL_STATE_KEY,
  EMBEDDING_DIMENSION_STATE_KEY,
  EMBEDDING_PREFIX_QUERY_STATE_KEY,
  EMBEDDING_PREFIX_PASSAGE_STATE_KEY,
  getState,
  setState,
} from "../../../src/core/search/store/state.ts";
import {
  ensureEmbeddingModel,
  type EmbeddingRebuildGate,
} from "../../../src/core/search/store/vectors.ts";
import type { ResolvedEmbeddingConfig } from "../../../src/core/search/types.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { startFakeHttp } from "../../helpers/fake-http.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";

const FIXED_STAMP = "2026-01-01T00:00:00.000Z";

/**
 * Recursive removal that rides out a transient Windows refusal (EBUSY,
 * EPERM, ENOTEMPTY while a handle is still closing) - the same posture
 * tests/setup.ts and tests/helpers/temp-dir.ts use for every temp tree.
 */
const REMOVE_TREE = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 } as const;

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-emb-gate-"));
  db = new Database(join(tmp, "brain.sqlite"));
  applyMigrations(db);
});

afterEach(() => {
  // `db.close()` is the lazy sqlite3_close_v2: with the unfinalized cached
  // statements `db.query()` leaves behind, the connection turns into a
  // zombie that keeps brain.sqlite open until GC. Invisible on POSIX, but
  // on Windows the still-open file makes the rm below fail with EBUSY, so
  // close the way the product does - finalizing statements NOW
  // (src/core/sqlite-close.ts).
  closeDatabase(db);
  rmSync(tmp, REMOVE_TREE);
});

function semantic(overrides: Partial<ResolvedEmbeddingConfig>): ResolvedEmbeddingConfig {
  return Object.freeze({
    enabled: true,
    provider: "openai-compat",
    baseUrl: "https://x/v1",
    model: "m2",
    apiKey: null,
    dimension: 8,
    timeoutMs: 10_000,
    concurrency: 4,
    batchSize: 32,
    costGateUsd: 0,
    maxRetries: 3,
    ...overrides,
  });
}

/** The three capability tiers the gate must distinguish. */
const CREDENTIAL_MISSING_GATE: EmbeddingRebuildGate = Object.freeze({
  semantic: semantic({ apiKey: null }),
});
const DISABLED_GATE: EmbeddingRebuildGate = Object.freeze({
  semantic: semantic({ enabled: false }),
});
const CONFIGURED_GATE: EmbeddingRebuildGate = Object.freeze({
  semantic: semantic({ apiKey: "k" }),
});

const NO_VEC = { loaded: false, version: null } as const;

/** One document with one chunk and one stored embedding under m1/4. */
function seedStoredEmbedding(model: string, dimension: number): number {
  const docId = upsertDocument(db, {
    path: "gate/a.md",
    title: null,
    contentHash: "h",
    mtime: 0,
    size: 1,
  });
  const [chunkId] = replaceChunks(db, false, docId, [
    { chunkIndex: 0, content: "x", contentHash: "h0", startLine: 1, endLine: 1, tokenCount: 1 },
  ]);
  const id = chunkId!;
  db.run(
    "INSERT INTO embeddings(chunk_id, model, dimension, embedding_hash, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
    [id, model, dimension, "eh", FIXED_STAMP, FIXED_STAMP],
  );
  return id;
}

function embeddingCount(): number {
  return db.query<{ c: number }, []>("SELECT count(*) AS c FROM embeddings").get()?.c ?? 0;
}

/** Run `fn` with console.error captured; returns its result and the lines. */
function captureErrors<T>(fn: () => T): { result: T; errors: string[] } {
  const errors: string[] = [];
  const original = console.error;
  console.error = (msg: string) => errors.push(msg);
  try {
    return { result: fn(), errors };
  } finally {
    console.error = original;
  }
}

test("a model change with a blocked capability tier refuses the clear and keeps the old vectors", () => {
  seedStoredEmbedding("m1", 4);
  ensureEmbeddingModel(db, NO_VEC, "m1", 4);

  const { result: outcome, errors } = captureErrors(() =>
    ensureEmbeddingModel(db, NO_VEC, "m2", 8, undefined, CREDENTIAL_MISSING_GATE),
  );
  expect(outcome.wasChanged).toBe(false);
  expect(outcome.refusal?.code).toBe("EMBEDDING_KEY_MISSING");
  expect(outcome.refusal?.message).toMatch(/rebuilt/i);
  // The refusal is logged under its code, not swallowed.
  expect(errors.some((m) => m.startsWith("EMBEDDING_KEY_MISSING:"))).toBe(true);
  // Nothing was destroyed and nothing was re-stamped: the old vectors
  // and the old recorded model both survive the refusal.
  expect(embeddingCount()).toBe(1);
  expect(getState(db, EMBEDDING_MODEL_STATE_KEY)).toBe("m1");
  expect(getState(db, EMBEDDING_DIMENSION_STATE_KEY)).toBe("4");
});

test("a disabled capability tier refuses with the disabled code", () => {
  seedStoredEmbedding("m1", 4);
  ensureEmbeddingModel(db, NO_VEC, "m1", 4);

  const { result: outcome } = captureErrors(() =>
    ensureEmbeddingModel(db, NO_VEC, "m2", 8, undefined, DISABLED_GATE),
  );
  expect(outcome.refusal?.code).toBe("EMBEDDING_DISABLED");
  expect(embeddingCount()).toBe(1);
});

test("a model change with a configured provider clears as today", () => {
  seedStoredEmbedding("m1", 4);
  ensureEmbeddingModel(db, NO_VEC, "m1", 4);

  const outcome = ensureEmbeddingModel(db, NO_VEC, "m2", 8, undefined, CONFIGURED_GATE);
  expect(outcome.wasChanged).toBe(true);
  expect(embeddingCount()).toBe(0);
  expect(getState(db, EMBEDDING_MODEL_STATE_KEY)).toBe("m2");
  expect(getState(db, EMBEDDING_DIMENSION_STATE_KEY)).toBe("8");
});

test("without capability evidence the legacy clear contract applies", () => {
  // The gate is evidence-driven: a caller that passes no gate gets the
  // pre-gate behavior. This pins that contract explicitly so widening
  // or narrowing it can never happen silently.
  seedStoredEmbedding("m1", 4);
  ensureEmbeddingModel(db, NO_VEC, "m1", 4);

  const outcome = ensureEmbeddingModel(db, NO_VEC, "m2", 8);
  expect(outcome.wasChanged).toBe(true);
  expect(embeddingCount()).toBe(0);
});

test("an empty corpus clears even under a blocked tier: nothing stored, nothing to lose", () => {
  ensureEmbeddingModel(db, NO_VEC, "m1", 4);

  const outcome = ensureEmbeddingModel(db, NO_VEC, "m2", 8, undefined, CREDENTIAL_MISSING_GATE);
  expect(outcome.wasChanged).toBe(true);
  expect(getState(db, EMBEDDING_MODEL_STATE_KEY)).toBe("m2");
});

test("the loss-bearing trigger is the embeddings row, not the chunk count", () => {
  // A real store cannot hold an embedding without its chunk (FK cascade,
  // lifecycle.ts turns foreign_keys ON), so this raw-connection insert
  // documents the boundary rather than a reachable state: even here the
  // gate refuses on the stored vector, and the refusal says why the
  // rebuild has no material.
  db.run(
    "INSERT INTO embeddings(chunk_id, model, dimension, embedding_hash, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
    [999, "m1", 4, "eh", FIXED_STAMP, FIXED_STAMP],
  );
  ensureEmbeddingModel(db, NO_VEC, "m1", 4);

  const { result: outcome } = captureErrors(() =>
    ensureEmbeddingModel(db, NO_VEC, "m2", 8, undefined, CREDENTIAL_MISSING_GATE),
  );
  expect(outcome.refusal?.code).toBe("EMBEDDING_KEY_MISSING");
  expect(outcome.refusal?.message).toMatch(/no chunk material/i);
  expect(embeddingCount()).toBe(1);
});

test("a named-model to null-model transition warns, names the last model, and never clears", () => {
  seedStoredEmbedding("m1", 4);
  ensureEmbeddingModel(db, NO_VEC, "m1", 4);

  const errors: string[] = [];
  const original = console.error;
  console.error = (msg: string) => errors.push(msg);
  let outcome;
  try {
    outcome = ensureEmbeddingModel(db, NO_VEC, null, null, undefined, CONFIGURED_GATE);
  } finally {
    console.error = original;
  }

  expect(outcome.wasChanged).toBe(false);
  expect(errors.some((m) => m.includes("m1"))).toBe(true);
  // Even a CONFIGURED gate must not turn the transition into a clear:
  // with no model configured there is nothing to verify rebuildability
  // against.
  expect(embeddingCount()).toBe(1);
  expect(getState(db, EMBEDDING_MODEL_STATE_KEY)).toBe("m1");
});

test("a prefix change with a blocked capability tier refuses the clear", () => {
  seedStoredEmbedding("m1", 4);
  setState(db, EMBEDDING_PREFIX_QUERY_STATE_KEY, "q1");
  setState(db, EMBEDDING_PREFIX_PASSAGE_STATE_KEY, "p1");
  ensureEmbeddingModel(db, NO_VEC, "m1", 4, { query: "q1", passage: "p1" });

  const { result: outcome } = captureErrors(() =>
    ensureEmbeddingModel(db, NO_VEC, "m1", 4, { query: "q2", passage: "p2" }, DISABLED_GATE),
  );
  expect(outcome.refusal?.code).toBe("EMBEDDING_DISABLED");
  expect(embeddingCount()).toBe(1);
  expect(getState(db, EMBEDDING_PREFIX_QUERY_STATE_KEY)).toBe("q1");
});

test("a prefix change with a configured provider clears as today", () => {
  seedStoredEmbedding("m1", 4);
  setState(db, EMBEDDING_PREFIX_QUERY_STATE_KEY, "q1");
  setState(db, EMBEDDING_PREFIX_PASSAGE_STATE_KEY, "p1");
  ensureEmbeddingModel(db, NO_VEC, "m1", 4, { query: "q1", passage: "p1" });

  const outcome = ensureEmbeddingModel(
    db,
    NO_VEC,
    "m1",
    4,
    { query: "q2", passage: "p2" },
    CONFIGURED_GATE,
  );
  expect(outcome.wasChanged).toBe(false);
  expect(embeddingCount()).toBe(0);
  expect(getState(db, EMBEDDING_PREFIX_QUERY_STATE_KEY)).toBe("q2");
});

test("a write open under a blocked tier opens anyway, keeps the vectors and names the refusal", async () => {
  if (!sqliteVecLoadable()) return;
  const v = createTempVault("emb-gate-open");
  const server = await startFakeHttp();
  try {
    writeMd(v.vault, "a.md", "# A\n\nalpha body");
    const remote = (model: string, apiKey: string | null) =>
      makeConfig({
        vault: v.vault,
        dbPath: v.dbPath,
        semantic: {
          enabled: true,
          provider: "openai-compat",
          baseUrl: server.url,
          model,
          apiKey,
          dimension: 4,
          timeoutMs: 5_000,
          concurrency: 1,
          batchSize: 8,
          costGateUsd: 0,
          maxRetries: 1,
        },
      });
    await indexVault(remote("m1", FAKE_PROVIDER_KEY), { embeddings: true });

    // The model is bumped in an environment without the key: keyword
    // indexing must still open the store.
    const { result: opened, errors } = await captureErrorsAsync(() =>
      Store.open(remote("m2", null), { mode: "write" }),
    );
    try {
      expect(opened.counts().embeddings).toBeGreaterThan(0);
      expect(opened.getState(EMBEDDING_MODEL_STATE_KEY)).toBe("m1");
    } finally {
      await opened.close();
    }
    expect(errors.some((m) => m.startsWith("EMBEDDING_KEY_MISSING:"))).toBe(true);
  } finally {
    await server.close();
    v.cleanup();
  }
});

async function captureErrorsAsync<T>(
  fn: () => Promise<T>,
): Promise<{ result: T; errors: string[] }> {
  const errors: string[] = [];
  const original = console.error;
  console.error = (msg: string) => errors.push(msg);
  try {
    return { result: await fn(), errors };
  } finally {
    console.error = original;
  }
}
