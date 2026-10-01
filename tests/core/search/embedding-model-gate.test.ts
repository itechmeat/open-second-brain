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
import { SearchError } from "../../../src/core/search/types.ts";
import type { ResolvedEmbeddingConfig } from "../../../src/core/search/types.ts";

const FIXED_STAMP = "2026-01-01T00:00:00.000Z";

let tmp: string;
let db: Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-emb-gate-"));
  db = new Database(join(tmp, "brain.sqlite"));
  applyMigrations(db);
});

afterEach(() => {
  db.close();
  rmSync(tmp, { recursive: true, force: true });
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

test("a model change with a blocked capability tier refuses the clear and keeps the old vectors", () => {
  seedStoredEmbedding("m1", 4);
  ensureEmbeddingModel(db, NO_VEC, "m1", 4);

  expect(() =>
    ensureEmbeddingModel(db, NO_VEC, "m2", 8, undefined, CREDENTIAL_MISSING_GATE),
  ).toThrow(SearchError);
  try {
    ensureEmbeddingModel(db, NO_VEC, "m2", 8, undefined, CREDENTIAL_MISSING_GATE);
    throw new Error("expected the gate to refuse the clear");
  } catch (e) {
    expect(e).toBeInstanceOf(SearchError);
    expect((e as SearchError).code).toBe("EMBEDDING_KEY_MISSING");
    expect((e as SearchError).message).toMatch(/rebuilt/i);
  }
  // Nothing was destroyed and nothing was re-stamped: the old vectors
  // and the old recorded model both survive the refusal.
  expect(embeddingCount()).toBe(1);
  expect(getState(db, EMBEDDING_MODEL_STATE_KEY)).toBe("m1");
  expect(getState(db, EMBEDDING_DIMENSION_STATE_KEY)).toBe("4");
});

test("a disabled capability tier refuses with the disabled code", () => {
  seedStoredEmbedding("m1", 4);
  ensureEmbeddingModel(db, NO_VEC, "m1", 4);

  expect(() => ensureEmbeddingModel(db, NO_VEC, "m2", 8, undefined, DISABLED_GATE)).toThrow(
    SearchError,
  );
  try {
    ensureEmbeddingModel(db, NO_VEC, "m2", 8, undefined, DISABLED_GATE);
    throw new Error("expected the gate to refuse the clear");
  } catch (e) {
    expect((e as SearchError).code).toBe("EMBEDDING_DISABLED");
  }
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

  try {
    ensureEmbeddingModel(db, NO_VEC, "m2", 8, undefined, CREDENTIAL_MISSING_GATE);
    throw new Error("expected the gate to refuse the clear");
  } catch (e) {
    expect(e).toBeInstanceOf(SearchError);
    expect((e as SearchError).code).toBe("EMBEDDING_KEY_MISSING");
    expect((e as SearchError).message).toMatch(/no chunk material|rebuild/i);
  }
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

  expect(() =>
    ensureEmbeddingModel(db, NO_VEC, "m1", 4, { query: "q2", passage: "p2" }, DISABLED_GATE),
  ).toThrow(SearchError);
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
