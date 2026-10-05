/**
 * Vector carry-over on edit (t_82c3b275, task 9).
 *
 * The defect pinned here: `replaceChunks` purged every stored vector of
 * a document before it rewrote the chunks, so an edit to one paragraph
 * re-embedded, and re-paid for, every paragraph that did not change.
 * The rule now is that a new chunk whose `content_hash` equals an old
 * chunk's hash in the same document keeps that chunk's vector, provided
 * the old row's model and dimension equal the identity `index_state`
 * records. Only the vectors that are not carried are purged.
 *
 * Covered: the pure multiset matcher (edit, move, duplicates), the
 * store seam (carry, purge of the uncarried vec rows, the model and
 * dimension guards, the unrecorded-identity guard, vec not loaded), the
 * `embeddingsReused` tally of an index run, the embedder record audit on
 * carried rows, a KNN query that finds the carried chunk under its
 * new id, and the one-document scope of the carry census (two notes
 * sharing a paragraph never trade vectors).
 *
 * Deliberately not covered: carry-over ACROSS documents (a paragraph
 * moved into another note is re-embedded by design - the key is scoped
 * to one document) and any change to the model-change lifecycle, which
 * still clears every vector through `ensureEmbeddingModel`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import type { ChunkInput } from "../../../src/core/search/store/chunks.ts";
import { readEmbedderRecordCensusSync } from "../../../src/core/search/store/embedder-audit.ts";
import {
  EMBEDDING_DIMENSION_STATE_KEY,
  EMBEDDING_MODEL_STATE_KEY,
} from "../../../src/core/search/store/state.ts";
import { matchCarriedVectors } from "../../../src/core/search/store/vector-carry-over.ts";
import { loadVecExtension } from "../../../src/core/search/store/vectors.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";

const VEC_LOADABLE = sqliteVecLoadable();

const STORE_MODEL = "carry-model";
const STORE_DIMENSION = 4;
const NOTE_PATH = "Notes/carry.md";

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  const v = createTempVault("vector-carry-over");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
});

afterEach(() => {
  cleanup();
});

function storeConfig(): ResolvedSearchConfig {
  return makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: "https://embeddings.invalid/v1",
      model: STORE_MODEL,
      apiKey: FAKE_PROVIDER_KEY,
      dimension: STORE_DIMENSION,
    },
  });
}

function chunkInput(chunkIndex: number, contentHash: string): ChunkInput {
  return {
    chunkIndex,
    content: `content ${contentHash}`,
    contentHash,
    startLine: chunkIndex + 1,
    endLine: chunkIndex + 1,
    tokenCount: 2,
  };
}

function unitVector(seed: number): number[] {
  const raw = [seed + 1, seed * 2 + 1, 3 - seed, 1];
  const norm = Math.hypot(...raw);
  return raw.map((v) => v / norm);
}

const SEED_HASHES = ["h0", "h1", "h2"] as const;

/** A write store holding one document of three embedded chunks. */
async function seededStore(): Promise<{ store: Store; docId: number; oldIds: number[] }> {
  const store = await Store.open(storeConfig(), { mode: "write" });
  const docId = store.upsertDocument({
    path: NOTE_PATH,
    title: null,
    contentHash: "doc-v1",
    mtime: 0,
    size: 1,
  });
  const oldIds = store.replaceChunks(
    docId,
    SEED_HASHES.map((h, i) => chunkInput(i, h)),
  );
  oldIds.forEach((id, i) => {
    store.vecUpsert(id, unitVector(i), STORE_MODEL, STORE_DIMENSION, `emb-${i}`);
  });
  return { store, docId, oldIds };
}

function vecRowCount(path: string): number {
  const db = new Database(path, { readonly: true });
  try {
    if (loadVecExtension(db) === null) throw new Error("sqlite-vec failed to load in the probe");
    return db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM chunk_vec").get()?.n ?? 0;
  } finally {
    db.close();
  }
}

/** The two timestamps of one chunk's `embeddings` row, read off disk. */
function embeddingTimes(path: string, chunkId: number): { createdAt: string; updatedAt: string } {
  const db = new Database(path, { readonly: true });
  try {
    const row = db
      .query<{ created_at: string; updated_at: string }, [number]>(
        "SELECT created_at, updated_at FROM embeddings WHERE chunk_id = ?",
      )
      .get(chunkId);
    if (row === null) throw new Error(`no embeddings row for chunk ${chunkId}`);
    return { createdAt: row.created_at, updatedAt: row.updated_at };
  } finally {
    db.close();
  }
}

function old(hashes: ReadonlyArray<string>): Array<{ contentHash: string; ref: string }> {
  return hashes.map((contentHash, i) => ({ contentHash, ref: `old-${i}` }));
}

describe("matchCarriedVectors", () => {
  test("an edited chunk is the only unmatched position", () => {
    const matches = matchCarriedVectors(old(["a", "b", "c"]), ["a", "b2", "c"]);
    expect(matches.map((m) => [m.position, m.candidate.ref])).toEqual([
      [0, "old-0"],
      [2, "old-2"],
    ]);
  });

  test("a moved chunk is matched at its new position", () => {
    const matches = matchCarriedVectors(old(["a", "b", "c"]), ["c", "a", "b"]);
    expect(matches.map((m) => [m.position, m.candidate.ref])).toEqual([
      [0, "old-2"],
      [1, "old-0"],
      [2, "old-1"],
    ]);
  });

  test("duplicated hashes match as a multiset in order", () => {
    const matches = matchCarriedVectors(old(["a", "a", "b"]), ["a", "b", "a", "a"]);
    expect(matches.map((m) => [m.position, m.candidate.ref])).toEqual([
      [0, "old-0"],
      [1, "old-2"],
      [2, "old-1"],
    ]);
  });

  test("no shared hash carries nothing", () => {
    expect(matchCarriedVectors(old(["a"]), ["b"])).toEqual([]);
  });
});

describe("replaceDocumentChunks carry-over", () => {
  test.skipIf(!VEC_LOADABLE)(
    "an edit keeps the vectors of the unchanged chunks and purges only the replaced one",
    async () => {
      const { store, docId } = await seededStore();
      const replaced = store.replaceDocumentChunks(docId, [
        chunkInput(0, "h0"),
        chunkInput(1, "h1-edited"),
        chunkInput(2, "h2"),
      ]);
      const [first, edited, last] = replaced.chunkIds;
      expect(replaced.embeddingsReused).toBe(2);
      expect(store.getEmbeddingHash(first!)).toBe("emb-0");
      expect(store.getEmbeddingHash(last!)).toBe("emb-2");
      expect(store.getEmbeddingHash(edited!)).toBeNull();
      expect(store.findChunksWithoutEmbeddings().map((p) => p.chunkId)).toEqual([edited!]);
      expect(Array.from(store.embeddingForChunk(last!) ?? [])).toEqual(
        Array.from(Float32Array.from(unitVector(2))),
      );
      const hits = store.semanticTopK(unitVector(2), { limit: 1 });
      expect(hits.map((h) => h.chunkId)).toEqual([last!]);
      await store.close();
      expect(vecRowCount(dbPath)).toBe(2);
      const census = readEmbedderRecordCensusSync(dbPath);
      expect(census.verdict).toBe("audited");
      if (census.verdict === "audited") expect(census.outcome).toBe("complete");
    },
  );

  test.skipIf(!VEC_LOADABLE)(
    "a carried vector keeps its created_at and moves its updated_at",
    async () => {
      const { store, docId, oldIds } = await seededStore();
      const before = embeddingTimes(dbPath, oldIds[0]!);
      await Bun.sleep(5);
      const replaced = store.replaceDocumentChunks(docId, [
        chunkInput(0, "h0"),
        chunkInput(1, "h1-edited"),
        chunkInput(2, "h2"),
      ]);
      await store.close();
      const after = embeddingTimes(dbPath, replaced.chunkIds[0]!);
      expect(after.createdAt).toBe(before.createdAt);
      expect(after.updatedAt).not.toBe(before.updatedAt);
    },
  );

  test.skipIf(!VEC_LOADABLE)(
    "the plain replaceChunks form carries too and still returns the ids",
    async () => {
      const { store, docId } = await seededStore();
      const ids = store.replaceChunks(docId, [chunkInput(0, "h2")]);
      expect(store.getEmbeddingHash(ids[0]!)).toBe("emb-2");
      await store.close();
      expect(vecRowCount(dbPath)).toBe(1);
    },
  );

  test.skipIf(!VEC_LOADABLE)(
    "a row whose model differs from the recorded identity is not carried",
    async () => {
      const { store, docId } = await seededStore();
      store.setState(EMBEDDING_MODEL_STATE_KEY, "another-model");
      const replaced = store.replaceDocumentChunks(
        docId,
        SEED_HASHES.map((h, i) => chunkInput(i, h)),
      );
      expect(replaced.embeddingsReused).toBe(0);
      expect(store.countEmbeddings()).toBe(0);
      await store.close();
      expect(vecRowCount(dbPath)).toBe(0);
    },
  );

  test.skipIf(!VEC_LOADABLE)(
    "a row whose dimension differs from the recorded identity is not carried",
    async () => {
      const { store, docId } = await seededStore();
      store.setState(EMBEDDING_DIMENSION_STATE_KEY, String(STORE_DIMENSION * 2));
      const replaced = store.replaceDocumentChunks(
        docId,
        SEED_HASHES.map((h, i) => chunkInput(i, h)),
      );
      expect(replaced.embeddingsReused).toBe(0);
      expect(store.countEmbeddings()).toBe(0);
      await store.close();
    },
  );

  test.skipIf(!VEC_LOADABLE)(
    "nothing is carried when the embedding identity is unrecorded",
    async () => {
      const { store, docId } = await seededStore();
      store.deleteState(EMBEDDING_MODEL_STATE_KEY);
      const replaced = store.replaceDocumentChunks(
        docId,
        SEED_HASHES.map((h, i) => chunkInput(i, h)),
      );
      expect(replaced.embeddingsReused).toBe(0);
      expect(store.countEmbeddings()).toBe(0);
      await store.close();
    },
  );

  test.skipIf(!VEC_LOADABLE)(
    "with vec not loaded the replacement behaves as before: nothing carried",
    async () => {
      const seeded = await seededStore();
      await seeded.store.close();
      const store = await Store.open(storeConfig(), { mode: "write", loadVec: false });
      expect(store.vecLoaded()).toBe(false);
      const replaced = store.replaceDocumentChunks(
        seeded.docId,
        SEED_HASHES.map((h, i) => chunkInput(i, h)),
      );
      expect(replaced.embeddingsReused).toBe(0);
      expect(replaced.chunkIds).toHaveLength(3);
      expect(store.countEmbeddings()).toBe(0);
      await store.close();
    },
  );
});

/** The `chunk_vec_map` rows of one document's chunks, as `chunk_id:vec_rowid`. */
function vecMapRows(path: string, docId: number): string[] {
  const db = new Database(path, { readonly: true });
  try {
    return db
      .query<{ chunk_id: number; vec_rowid: number }, [number]>(
        "SELECT m.chunk_id AS chunk_id, m.vec_rowid AS vec_rowid FROM chunk_vec_map m " +
          "JOIN chunks c ON c.id = m.chunk_id WHERE c.document_id = ? ORDER BY m.chunk_id",
      )
      .all(docId)
      .map((r) => `${r.chunk_id}:${r.vec_rowid}`);
  } finally {
    db.close();
  }
}

describe("carry-over stays inside one document", () => {
  test.skipIf(!VEC_LOADABLE)(
    "a paragraph two notes share carries only the edited note's own vector",
    async () => {
      const store = await Store.open(storeConfig(), { mode: "write" });
      const docOf = (path: string) =>
        store.upsertDocument({ path, title: null, contentHash: path, mtime: 0, size: 1 });
      const docA = docOf("Notes/a.md");
      const docB = docOf("Notes/b.md");
      // A's shared paragraph sits AFTER B's in chunk_index order, so a
      // census that leaked across documents would hand A B's vector first.
      const idsA = store.replaceChunks(docA, [chunkInput(0, "only-a"), chunkInput(1, "shared")]);
      const idsB = store.replaceChunks(docB, [chunkInput(0, "shared"), chunkInput(1, "only-b")]);
      idsA.forEach((id, i) =>
        store.vecUpsert(id, unitVector(i), STORE_MODEL, STORE_DIMENSION, `a-${i}`),
      );
      idsB.forEach((id, i) =>
        store.vecUpsert(id, unitVector(i + 2), STORE_MODEL, STORE_DIMENSION, `b-${i}`),
      );
      const oldRowidsA = vecMapRows(dbPath, docA).map((row) => row.split(":")[1]);
      const rowsB = vecMapRows(dbPath, docB);

      const replaced = store.replaceDocumentChunks(docA, [
        chunkInput(0, "only-a-edited"),
        chunkInput(1, "shared"),
      ]);
      expect(replaced.embeddingsReused).toBe(1);
      const carried = vecMapRows(dbPath, docA).map((row) => row.split(":")[1]);
      expect(carried).toHaveLength(1);
      for (const rowid of carried) expect(oldRowidsA).toContain(rowid);
      expect(vecMapRows(dbPath, docB)).toEqual(rowsB);
      const sharedA = replaced.chunkIds[1]!;
      expect(store.getEmbeddingHash(sharedA)).toBe("a-1");

      store.deleteDocument("Notes/b.md");
      expect(Array.from(store.embeddingForChunk(sharedA) ?? [])).toEqual(
        Array.from(Float32Array.from(unitVector(1))),
      );
      expect(store.semanticTopK(unitVector(1), { limit: 1 }).map((h) => h.chunkId)).toEqual([
        sharedA,
      ]);
      await store.close();
    },
  );
});

describe("an index run tallies carried vectors", () => {
  /** The offline local embedder, with chunks small enough that each section is its own. */
  function localRunConfig(): ResolvedSearchConfig {
    const base = makeConfig({
      vault,
      dbPath,
      semantic: {
        enabled: true,
        provider: "local",
        baseUrl: null,
        model: null,
        apiKey: null,
        dimension: 64,
        costGateUsd: 0,
      },
    });
    return { ...base, chunkSize: 60, chunkOverlap: 0, chunkMinSize: 1 };
  }

  const SECTIONS = [
    "# Alpha\n\nThe first section talks about compost and soil.",
    "# Beta\n\nThe second section talks about tomatoes in spring.",
    "# Gamma\n\nThe third section talks about watering at dawn.",
  ] as const;

  test.skipIf(!VEC_LOADABLE)(
    "an edit re-embeds only the changed chunk and reports the rest as reused",
    async () => {
      writeMd(vault, NOTE_PATH, SECTIONS.join("\n\n"));
      const cfg = localRunConfig();
      const first = await indexVault(cfg, { embeddings: true });
      expect(first.embeddingsReused).toBe(0);
      const chunks = first.embeddingsComputed;
      expect(chunks).toBeGreaterThanOrEqual(SECTIONS.length);

      writeMd(
        vault,
        NOTE_PATH,
        [SECTIONS[0], "# Beta\n\nThe second section now talks about peppers.", SECTIONS[2]].join(
          "\n\n",
        ),
      );
      const second = await indexVault(cfg, { embeddings: true });
      expect(second.embeddingsComputed).toBe(1);
      expect(second.embeddingsReused).toBe(chunks - 1);
    },
  );
});
