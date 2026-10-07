/**
 * Vector carry-over on edit (t_82c3b275): the rule that lets a chunk
 * replacement keep the stored vector of a chunk whose text did not
 * change, so an edit to one paragraph re-embeds, and re-pays for, that
 * paragraph alone.
 *
 * The key is `content_hash` within one document. The embedded text is
 * exactly `chunks.content` and `content_hash = sha256(content)`, so two
 * chunks with one hash embed to one vector. The query and passage
 * prefixes are store-level, and any change to them already clears every
 * vector through `ensureEmbeddingModel`, so they need no place in the key.
 *
 * The guard is provenance: an old row is carried only when its
 * `embeddings.model` and `dimension` equal the identity `index_state`
 * records. When that identity is unrecorded, nothing is carried - there
 * is no recorded claim to vouch for the old rows, and a carried vector
 * that does not belong to the active model would be silent garbage.
 */

import { Database } from "bun:sqlite";

import { SearchError } from "../types.ts";
import { EMBEDDING_DIMENSION_STATE_KEY, EMBEDDING_MODEL_STATE_KEY, getState } from "./state.ts";
import { nowIso } from "./sql.ts";

/** One stored vector of the document being replaced, eligible to be carried. */
export interface CarryCandidate {
  /** The old chunk id the vector is attached to before the replacement. */
  readonly chunkId: number;
  readonly contentHash: string;
  readonly vecRowid: number;
  readonly model: string;
  readonly dimension: number;
  readonly embeddingHash: string;
  readonly createdAt: string;
}

/** A new chunk position paired with the old vector it keeps. */
export interface CarriedVector<C> {
  /** Index into the replacement chunk list, not `chunk_index`. */
  readonly position: number;
  readonly candidate: C;
}

/**
 * Pair each new chunk hash with an unused old candidate of the same
 * hash. Duplicated hashes match as a multiset: the k-th occurrence of a
 * hash in the new list takes the k-th old candidate of that hash, both
 * in list order (the caller hands candidates in `chunk_index` order).
 * Pure, so the pairing rule is testable without a store.
 */
export function matchCarriedVectors<C extends { readonly contentHash: string }>(
  candidates: ReadonlyArray<C>,
  newHashes: ReadonlyArray<string>,
): Array<CarriedVector<C>> {
  const queues = new Map<string, C[]>();
  for (const candidate of candidates) {
    const queue = queues.get(candidate.contentHash);
    if (queue === undefined) queues.set(candidate.contentHash, [candidate]);
    else queue.push(candidate);
  }
  const matches: Array<CarriedVector<C>> = [];
  newHashes.forEach((hash, position) => {
    const candidate = queues.get(hash)?.shift();
    if (candidate !== undefined) matches.push({ position, candidate });
  });
  return matches;
}

/** The embedding identity `index_state` records, or null when either half is absent. */
function recordedIdentity(db: Database): { model: string; dimension: number } | null {
  const model = getState(db, EMBEDDING_MODEL_STATE_KEY);
  const rawDimension = getState(db, EMBEDDING_DIMENSION_STATE_KEY);
  if (model === null || rawDimension === null) return null;
  const dimension = Number(rawDimension);
  if (!Number.isInteger(dimension) || dimension <= 0) return null;
  return { model, dimension };
}

/**
 * The stored vectors of one document that a replacement may carry, in
 * `chunk_index` order. Empty when sqlite-vec is not loaded (there is no
 * vector table to keep rows in, and the replacement behaves as it always
 * did), when the identity is unrecorded, and for every row whose model
 * or dimension differs from the recorded identity.
 */
export function readCarryCandidates(
  db: Database,
  vecLoaded: boolean,
  documentId: number,
): CarryCandidate[] {
  if (!vecLoaded) return [];
  const identity = recordedIdentity(db);
  if (identity === null) return [];
  return db
    .query<
      {
        chunk_id: number;
        content_hash: string;
        vec_rowid: number;
        model: string;
        dimension: number;
        embedding_hash: string;
        created_at: string;
      },
      [number, string, number]
    >(
      "SELECT c.id AS chunk_id, c.content_hash AS content_hash, m.vec_rowid AS vec_rowid, e.model AS model, " +
        "       e.dimension AS dimension, e.embedding_hash AS embedding_hash, e.created_at AS created_at " +
        "FROM chunks c " +
        "JOIN chunk_vec_map m ON m.chunk_id = c.id " +
        "JOIN embeddings e ON e.chunk_id = c.id " +
        "WHERE c.document_id = ? AND e.model = ? AND e.dimension = ? " +
        "ORDER BY c.chunk_index",
    )
    .all(documentId, identity.model, identity.dimension)
    .map((r) => ({
      chunkId: r.chunk_id,
      contentHash: r.content_hash,
      vecRowid: r.vec_rowid,
      model: r.model,
      dimension: r.dimension,
      embeddingHash: r.embedding_hash,
      createdAt: r.created_at,
    }));
}

/**
 * Re-attach carried vectors to the new chunk ids: one `chunk_vec_map`
 * row pointing at the kept `chunk_vec` row, and one `embeddings` row
 * copying the old provenance. `created_at` keeps the instant the vector
 * was computed; `updated_at` records the carry. Runs inside the
 * caller's transaction.
 */
export function restoreCarriedVectors(
  db: Database,
  newChunkIds: ReadonlyArray<number>,
  matches: ReadonlyArray<CarriedVector<CarryCandidate>>,
): void {
  if (matches.length === 0) return;
  const insertMap = db.prepare<unknown, [number, number]>(
    "INSERT INTO chunk_vec_map(chunk_id, vec_rowid) VALUES (?, ?)",
  );
  const insertEmbedding = db.prepare<unknown, [number, string, number, string, string, string]>(
    "INSERT INTO embeddings(chunk_id, model, dimension, embedding_hash, created_at, updated_at) " +
      "VALUES (?, ?, ?, ?, ?, ?)",
  );
  const now = nowIso();
  for (const { position, candidate } of matches) {
    const chunkId = newChunkIds[position];
    if (chunkId === undefined) {
      throw new SearchError(
        "INDEX_UNREADABLE",
        `carried vector position ${position} has no new chunk id`,
      );
    }
    insertMap.run(chunkId, candidate.vecRowid);
    insertEmbedding.run(
      chunkId,
      candidate.model,
      candidate.dimension,
      candidate.embeddingHash,
      candidate.createdAt,
      now,
    );
  }
}
