/**
 * The `index_state` key/value table: every fact the index records about
 * itself (embedding identity, revision counter, index-run timestamps),
 * plus the synchronous read-only peeks that observe those facts without
 * opening a `Store`.
 *
 * The key namespace lives here in full so no two readers of the same
 * cell can spell its key differently.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

import { computeCorpusGeneration } from "../corpus-generation.ts";
import { LATEST_SCHEMA_VERSION, readSchemaVersion } from "../schema.ts";
import { nowIso } from "./sql.ts";

/**
 * `index_state` keys for the active embedding instruction prefixes
 * (memory-write-path-integrity B2). Recorded per index run so a later
 * stored-vs-configured mismatch can surface the reindex-required warning:
 * vectors embedded under one prefix pair are not comparable to queries
 * embedded under another.
 */
export const EMBEDDING_PREFIX_QUERY_STATE_KEY = "embedding_prefix_query";
export const EMBEDDING_PREFIX_PASSAGE_STATE_KEY = "embedding_prefix_passage";

/**
 * `index_state` keys behind the corpus-generation fingerprint. Named so
 * the class accessors and {@link readCorpusGenerationSync} cannot drift
 * into two spellings of the same key.
 */
export const EMBEDDING_MODEL_STATE_KEY = "embedding_model";
export const EMBEDDING_DIMENSION_STATE_KEY = "embedding_dimension";
export const INDEX_REVISION_STATE_KEY = "index_revision";

/**
 * sqlite-vec version the stored vectors were written against
 * (context-integrity-gates, Unit E). `SELECT vec_version()` was already
 * executed on every extension load and the row discarded every time;
 * this key is where it now lands, so the ABI the vectors were produced
 * under can be compared later instead of assumed.
 */
export const EMBEDDING_VEC_VERSION_STATE_KEY = "embedding_vec_version";

/**
 * `index_state` keys stamped by every index run (`last_indexed_at`) and
 * by a FORCED one only (`last_full_index_at`). Both carry the same ISO
 * instant when the run was forced, which is what makes their equality a
 * usable "the last run resolved the whole vault" predicate - the
 * precondition the broken-link ratchet verifies before it trusts a
 * dangling count (context-integrity-gates, unit G).
 */
export const LAST_INDEXED_AT_STATE_KEY = "last_indexed_at";
export const LAST_FULL_INDEX_AT_STATE_KEY = "last_full_index_at";

const SELECT_STATE_SQL = "SELECT value FROM index_state WHERE key = ?";

export function getState(db: Database, key: string): string | null {
  const row = db.query<{ value: string }, [string]>(SELECT_STATE_SQL).get(key);
  return row?.value ?? null;
}

export function setState(db: Database, key: string, value: string): void {
  db.run(
    "INSERT INTO index_state(key, value, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    [key, value, nowIso()],
  );
}

export function deleteState(db: Database, key: string): void {
  db.run("DELETE FROM index_state WHERE key = ?", [key]);
}

/**
 * A stored revision counter as a non-negative integer; anything absent,
 * unparseable or negative reads as 0. Shared by the store accessor and
 * the synchronous peek so a malformed cell cannot mean two different
 * generations depending on who read it.
 */
function parseIndexRevision(raw: string | null): number {
  const n = raw === null ? 0 : Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** A stored embedding dimension, or null when absent or unparseable. */
function parseEmbeddingDimension(raw: string | null): number | null {
  const dim = raw === null ? null : Number(raw);
  return dim !== null && Number.isFinite(dim) ? dim : null;
}

/** Monotonic counter bumped on every index mutation; 0 if never set. */
export function indexRevision(db: Database): number {
  return parseIndexRevision(getState(db, INDEX_REVISION_STATE_KEY));
}

/** Increment the index revision. Called after a mutating index run. */
export function bumpIndexRevision(db: Database): void {
  setState(db, INDEX_REVISION_STATE_KEY, String(indexRevision(db) + 1));
}

/**
 * Current corpus-generation fingerprint: embedding model + dimension +
 * schema version + index revision. The query cache gates on this so any
 * embedding change or content reindex invalidates cached results.
 */
export function corpusGeneration(db: Database): string {
  return computeCorpusGeneration({
    embeddingModel: getState(db, EMBEDDING_MODEL_STATE_KEY),
    embeddingDimension: parseEmbeddingDimension(getState(db, EMBEDDING_DIMENSION_STATE_KEY)),
    schemaVersion: LATEST_SCHEMA_VERSION,
    indexRevision: indexRevision(db),
  });
}

/**
 * Outcome of a synchronous peek at the index.
 *
 * ABSENT and UNREADABLE used to collapse to one `null`, which is wrong
 * for a stamp: "no index here" and "an index that exists and is corrupt"
 * are different states of the world, and a caller that records both as
 * unrecorded makes two such sides compare EQUAL - "two unrecorded sides
 * are not a finding" - so a corrupt index silently agrees with a missing
 * one. They are now separate arms and the caller chooses.
 */
export type IndexPeek<T> =
  | { readonly kind: "read"; readonly value: T }
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly detail: string };

/**
 * Run `read` against a read-only handle on the index, naming which of
 * the three outcomes occurred. Shared by the synchronous peeks so the
 * classification lives in one place rather than once per caller.
 */
export function peekReadonlyIndex<T>(
  dbPath: string,
  read: (state: (key: string) => string | null, db: Database) => T,
): IndexPeek<T> {
  if (!existsSync(dbPath)) return { kind: "absent" };
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch (e) {
    return { kind: "unreadable", detail: e instanceof Error ? e.message : String(e) };
  }
  try {
    return {
      kind: "read",
      value: read((key: string): string | null => getState(db, key), db),
    };
  } catch (e) {
    return { kind: "unreadable", detail: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      db.close();
    } catch {
      /* a close failure cannot change what was already read */
    }
  }
}

/**
 * {@link peekReadonlyIndex} collapsed to `T | null` for the callers that
 * genuinely cannot act on the distinction.
 */
export function withReadonlyIndex<T>(
  dbPath: string,
  read: (state: (key: string) => string | null, db: Database) => T,
): T | null {
  const peek = peekReadonlyIndex(dbPath, read);
  return peek.kind === "read" ? peek.value : null;
}

/**
 * Corpus-generation fingerprint read WITHOUT opening a `Store`.
 *
 * `Store.open` is async (the write path acquires a lock) and a read open
 * refuses a schema mismatch, so neither form is usable from a
 * synchronous caller that only wants to observe the index's identity and
 * must keep working when there is no index at all. The context pack's
 * provenance stamp (context-integrity-gates, Unit B) is exactly that
 * caller. It lives here rather than beside the caller because this
 * module is the single SQL boundary for the index.
 *
 * Returns `null` - "unrecorded", per `integrity/stamp.ts` - when the
 * index file is absent or cannot be read. That is DISTINCT from a
 * recorded generation string: a vault that gains or loses its index
 * drifts from `null` to a value (or back) and the stamp comparison names
 * it, rather than treating "nothing to compare" as agreement.
 *
 * The schema version comes from the file itself, not from
 * {@link LATEST_SCHEMA_VERSION}: an index still at an older schema is a
 * different corpus state, and folding it onto the current constant would
 * hide precisely that.
 */
export function readCorpusGenerationSync(dbPath: string): string | null {
  const peek = peekCorpusGenerationSync(dbPath);
  return peek.kind === "read" ? peek.value : null;
}

/**
 * {@link readCorpusGenerationSync} with the three outcomes kept apart, so
 * a caller that must not treat a corrupt index as "no index" can tell.
 */
export function peekCorpusGenerationSync(dbPath: string): IndexPeek<string | null> {
  return peekReadonlyIndex(dbPath, (read, db) =>
    computeCorpusGeneration({
      embeddingModel: read(EMBEDDING_MODEL_STATE_KEY),
      embeddingDimension: parseEmbeddingDimension(read(EMBEDDING_DIMENSION_STATE_KEY)),
      schemaVersion: readSchemaVersion(db),
      indexRevision: parseIndexRevision(read(INDEX_REVISION_STATE_KEY)),
    }),
  );
}
