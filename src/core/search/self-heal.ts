/**
 * Index self-heal policy shared by the read path, the session-start check
 * and the detached self-heal child: upgrade in place first, rebuild only
 * when an upgrade cannot help (#256).
 *
 * An index on an OLDER schema is migratable: the write open runs
 * `applyMigrations` in one transaction under the writer lock, and every
 * stored vector, the recorded embedding model and its prefixes survive
 * untouched. A full rebuild (`reindexVault`) starts from an empty index
 * and, without paid provider calls, cannot recompute the vectors - so it
 * is kept for the states a migration cannot repair: a missing or
 * unreadable file, a NEWER schema than this build knows, chunks cut by
 * older chunking rules, and an index whose tables are still missing after
 * the migration.
 *
 * Concurrency: the in-place upgrade takes the same writer lock every
 * writer takes, and `applyMigrations` re-reads the version under it, so a
 * second process that waited for the lock finds the index current and
 * migrates nothing. A process that gives up on the lock re-inspects the
 * index instead of assuming the upgrade failed.
 */

import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

import { closeDatabase } from "../sqlite-close.ts";
import { CHUNKER_VERSION } from "./chunker.ts";
import { countStoredEmbeddings, reindexVaultUnless, type IndexVaultOptions } from "./indexer.ts";
import { findSchemaGaps, LATEST_SCHEMA_VERSION, readSchemaVersion } from "./schema.ts";
import { consolidateWal, openWriteDatabase } from "./store/lifecycle.ts";
import { CHUNKER_VERSION_STATE_KEY, INTEGRITY_FAULT_STATE_KEY } from "./store/state.ts";
import { SearchError, type IndexStats, type ResolvedSearchConfig } from "./types.ts";

/**
 * What a cheap read-only look at the index file says:
 * - `current`: nothing to do.
 * - `older-schema`: a migratable older schema with current chunks.
 * - `rebuild`: absent, unreadable, newer than this build, chunked by
 *   older rules, condemned by a recorded integrity fault, or stamped
 *   current with tables or columns missing.
 */
export type IndexCondition = "current" | "older-schema" | "rebuild";

/**
 * Whether the index holds chunks cut by older chunking rules: documents
 * are present and the recorded CHUNKER_VERSION is not this binary's (or
 * was never recorded). An unchanged file is never re-chunked by an
 * incremental run, so only a rebuild replaces those chunks.
 */
function chunksAreStale(db: Database): boolean {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM index_state WHERE key = ? LIMIT 1")
    .get(CHUNKER_VERSION_STATE_KEY);
  if (row?.value === String(CHUNKER_VERSION)) return false;
  return db.query<{ one: number }, []>("SELECT 1 AS one FROM documents LIMIT 1").get() !== null;
}

/** Whether a completed integrity check recorded a fault against the file. */
function hasRecordedIntegrityFault(db: Database): boolean {
  return (
    db
      .query<{ value: string }, [string]>("SELECT value FROM index_state WHERE key = ? LIMIT 1")
      .get(INTEGRITY_FAULT_STATE_KEY) !== null
  );
}

/** Classify the index at `config.dbPath` with read-only queries. */
export function inspectIndex(config: ResolvedSearchConfig): IndexCondition {
  if (!existsSync(config.dbPath)) return "rebuild";
  let db: Database;
  try {
    db = new Database(config.dbPath, { readonly: true });
  } catch {
    return "rebuild";
  }
  try {
    const version = readSchemaVersion(db);
    if (version > LATEST_SCHEMA_VERSION || chunksAreStale(db)) return "rebuild";
    // A file a completed integrity check condemned refuses every open, so
    // it is not current whatever its schema says; the rebuild is its exit.
    if (hasRecordedIntegrityFault(db)) return "rebuild";
    if (version < LATEST_SCHEMA_VERSION) return "older-schema";
    return findSchemaGaps(db).length > 0 ? "rebuild" : "current";
  } catch {
    return "rebuild"; // corrupt / non-Open Second Brain file
  } finally {
    closeDatabase(db);
  }
}

/**
 * Migrate the index in place: a write open (which runs `applyMigrations`
 * under the writer lock) and an orderly close. Nothing else runs - in
 * particular not the embedding-identity check - so the stored vectors and
 * their recorded model and prefixes are left exactly as they were,
 * whatever the caller's semantic configuration. Throws what the open
 * throws (`INDEX_LOCKED`, a failed migration rolled back).
 */
export async function upgradeIndexInPlace(config: ResolvedSearchConfig): Promise<void> {
  const opened = await openWriteDatabase(config, true);
  try {
    consolidateWal(opened.db);
    closeDatabase(opened.db);
  } finally {
    await opened.release();
  }
}

/**
 * The full rebuild a self-heal falls back to, which names the vectors it
 * could not carry over. A rebuild without `embeddings` computes none, so
 * every vector of the replaced index is gone from the live one; saying so
 * once, with where the old index went and how to restore the vectors, is
 * the difference between a visible cost and a silent downgrade to
 * keyword-only search.
 *
 * The rebuild re-inspects the index once it holds the writer lock and
 * returns `null` without building when the index is already current - a
 * concurrent healer finished first - so two self-heals never rebuild in a
 * row over each other's work.
 */
export async function rebuildIndexForSelfHeal(
  config: ResolvedSearchConfig,
  opts?: IndexVaultOptions,
): Promise<IndexStats | null> {
  const before = countStoredEmbeddings(config.dbPath);
  const stats = await reindexVaultUnless(config, () => inspectIndex(config) === "current", opts);
  if (stats === null) return null;
  if (before > 0) {
    const dropped = before - countStoredEmbeddings(config.dbPath);
    if (dropped > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `search index rebuilt: ${dropped} stored embedding(s) were not carried over ` +
          `(the previous index is kept at ${config.dbPath}.bak until the next rebuild); ` +
          `restore them with: o2b search index --embeddings`,
      );
    }
  }
  return stats;
}

/** What {@link healIndex} did. */
export type HealOutcome =
  | { readonly kind: "current" }
  | { readonly kind: "migrated" }
  | { readonly kind: "rebuilt"; readonly stats: IndexStats };

/**
 * Bring the index current: migrate an older schema in place, and rebuild
 * only when the index still needs it afterwards. A failed upgrade is not
 * fatal - the re-inspection decides, so an upgrade another process
 * finished while this one waited for the lock counts as done. An upgrade
 * that could not take the lock and finds the index still old is rethrown
 * rather than rebuilt over: another writer holds the index, and a
 * rebuild would only queue behind it to discard what it just did.
 */
export async function healIndex(
  config: ResolvedSearchConfig,
  opts?: IndexVaultOptions,
): Promise<HealOutcome> {
  let condition = inspectIndex(config);
  if (condition === "current") return { kind: "current" };
  if (condition === "older-schema") {
    try {
      await upgradeIndexInPlace(config);
    } catch (e) {
      if (inspectIndex(config) === "current") return { kind: "migrated" };
      if (e instanceof SearchError && e.code === "INDEX_LOCKED") throw e;
      // eslint-disable-next-line no-console
      console.error(
        `in-place upgrade of ${config.dbPath} failed, rebuilding instead: ` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
    }
    condition = inspectIndex(config);
    if (condition === "current") return { kind: "migrated" };
  }
  const stats = await rebuildIndexForSelfHeal(config, opts);
  return stats === null ? { kind: "current" } : { kind: "rebuilt", stats };
}
