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
import { CHUNKER_VERSION, ENTITY_ONLY_CHUNKER_VERSIONS } from "./chunker.ts";
import { refreshEntitiesInPlace } from "./entity-refresh.ts";
import { countStoredEmbeddings, reindexVaultUnless, type IndexVaultOptions } from "./indexer.ts";
import { findSchemaGaps, LATEST_SCHEMA_VERSION, readSchemaVersion } from "./schema.ts";
import { Store } from "./store.ts";
import { consolidateWal, openWriteDatabase, restoreFromBakIfMissing } from "./store/lifecycle.ts";
import { CHUNKER_VERSION_STATE_KEY, INTEGRITY_FAULT_STATE_KEY } from "./store/state.ts";
import { SearchError, type IndexStats, type ResolvedSearchConfig } from "./types.ts";

/**
 * What a cheap read-only look at the index file says:
 * - `current`: nothing to do.
 * - `older-schema`: a migratable older schema with current chunks.
 * - `entities-stale`: current chunks whose entity rows were extracted by
 *   older rules (chunker version 3): refreshed in place when the index
 *   holds stored embeddings, rebuilt otherwise.
 * - `rebuild`: absent, unreadable, newer than this build, chunked by
 *   older rules, condemned by a recorded integrity fault, or stamped
 *   current with tables or columns missing.
 *
 * An older schema is `older-schema` whatever its chunks: it is upgraded in
 * place first, so a search answers from it at once, and what the upgraded
 * index still needs (a refresh or a rebuild) is the background heal's.
 */
export type IndexCondition = "current" | "older-schema" | "entities-stale" | "rebuild";

/**
 * Whether the index holds chunks cut by older chunking rules: documents
 * are present and the recorded CHUNKER_VERSION is not this binary's (or
 * was never recorded). An unchanged file is never re-chunked by an
 * incremental run, so only a rebuild replaces those chunks.
 */
function chunkState(db: Database): "current" | "entities-stale" | "stale" {
  const row = db
    .query<{ value: string }, [string]>("SELECT value FROM index_state WHERE key = ? LIMIT 1")
    .get(CHUNKER_VERSION_STATE_KEY);
  if (row?.value === String(CHUNKER_VERSION)) return "current";
  if (db.query<{ one: number }, []>("SELECT 1 AS one FROM documents LIMIT 1").get() === null) {
    return "current";
  }
  return row !== null && ENTITY_ONLY_CHUNKER_VERSIONS.has(row.value) ? "entities-stale" : "stale";
}

/** Whether a completed integrity check recorded a fault against the file. */
function hasRecordedIntegrityFault(db: Database): boolean {
  return (
    db
      .query<{ value: string }, [string]>("SELECT value FROM index_state WHERE key = ? LIMIT 1")
      .get(INTEGRITY_FAULT_STATE_KEY) !== null
  );
}

/**
 * Classify the index at `config.dbPath` with read-only queries, after the
 * crash restore every open runs: a rebuild that died between the renames
 * of its swap leaves the previous index parked with no live index, and
 * that index is put back rather than judged absent (and then rebuilt over
 * with its stored embeddings uncounted).
 */
export function inspectIndex(config: ResolvedSearchConfig): IndexCondition {
  restoreFromBakIfMissing(config.dbPath);
  if (!existsSync(config.dbPath)) return "rebuild";
  let db: Database;
  try {
    db = new Database(config.dbPath, { readonly: true });
  } catch {
    return "rebuild";
  }
  try {
    const version = readSchemaVersion(db);
    if (version > LATEST_SCHEMA_VERSION) return "rebuild";
    // A file a completed integrity check condemned refuses every open, so
    // it is not current whatever its schema says; the rebuild is its exit.
    if (hasRecordedIntegrityFault(db)) return "rebuild";
    if (version < LATEST_SCHEMA_VERSION) return "older-schema";
    if (findSchemaGaps(db).length > 0) return "rebuild";
    const chunks = chunkState(db);
    return chunks === "stale" ? "rebuild" : chunks;
  } catch {
    return "rebuild"; // corrupt / non-Open Second Brain file
  } finally {
    closeDatabase(db);
  }
}

/**
 * What an index that is not current needs, decided ONCE and read by every
 * caller that has to act on it: the read path (which upgrades an older
 * schema in place and answers), the status surface (which must not send
 * the user to a rebuild an upgrade replaces) and the post-upgrade
 * maintenance (which must not start a background rebuild for an index a
 * read repairs in place).
 *
 * - `current`: nothing to do.
 * - `upgrade-in-place`: an older schema; a write open migrates it under
 *   the writer lock and every stored vector survives. A read repairs
 *   this index, so nothing else needs to.
 * - `refresh-in-place`: current chunks whose entity rows were extracted
 *   by older rules; the entity rows are refreshed in place (which also
 *   keeps every stored embedding) when the index holds any, and rebuilt
 *   when it holds none.
 * - `rebuild`: no in-place repair exists - an absent, unreadable or
 *   newer-than-this-build index, one cut by older chunking rules, or one
 *   stamped current with tables missing.
 */
export type IndexRepairPlan =
  | { readonly kind: "current" }
  | { readonly kind: "upgrade-in-place" }
  | { readonly kind: "refresh-in-place" }
  | { readonly kind: "rebuild" };

/**
 * The repair the index at `config.dbPath` needs, by the rule above. The
 * one decision the read path, the status surface and the maintenance
 * share, so they cannot disagree about what a stale index needs: an
 * in-place upgrade when one exists, a rebuild only when it does not.
 */
export function planIndexRepair(config: ResolvedSearchConfig): IndexRepairPlan {
  const condition = inspectIndex(config);
  if (condition === "current") return { kind: "current" };
  if (condition === "older-schema") return { kind: "upgrade-in-place" };
  if (condition === "entities-stale") {
    // The same rule {@link healIndex} applies: an index with no stored
    // vectors cannot be refreshed into the compact layout, so it is
    // rebuilt; one whose vectors cannot be counted may hide some, and is
    // refreshed in place so none is lost.
    const vectors = countStoredEmbeddings(config.dbPath);
    return vectors === 0 ? { kind: "rebuild" } : { kind: "refresh-in-place" };
  }
  return { kind: "rebuild" };
}

/**
 * Whether the index at `config.dbPath` owes a repair BEYOND the schema
 * upgrade: entity rows extracted by older rules (refreshed in place) or
 * chunks cut by older chunking rules (rebuilt).
 *
 * Read past the schema version, because the chunker stamp is independent
 * of it: an index on an older schema can already owe this repair, and
 * {@link inspectIndex} reports the schema first, so the plan alone cannot
 * see it. The background heal owns that repair - it upgrades, re-plans and
 * repairs - while the reader that upgrades the schema does not: the read
 * path answers from the index it upgraded.
 */
export function owesRepairBeyondUpgrade(config: ResolvedSearchConfig): boolean {
  if (!existsSync(config.dbPath)) return false;
  let db: Database;
  try {
    db = new Database(config.dbPath, { readonly: true });
  } catch {
    return false; // unreadable: the plan says what to do with that file
  }
  try {
    return chunkState(db) !== "current";
  } catch {
    return false;
  } finally {
    closeDatabase(db);
  }
}

/**
 * Whether a REBUILD can repair a failed in-place upgrade - the one
 * decision the query path and the read-only surfaces share, so neither can
 * send the user to a rebuild that cannot help.
 *
 * A lock failure (`INDEX_LOCKED`) is not one: another writer holds the
 * index - and may be performing this very upgrade - so a rebuild would only
 * queue behind it to discard its work. Every other failure (a migration
 * that rolled back) is one a rebuild replaces: the query path rebuilds, and
 * a read-only surface names the rebuild as the remedy.
 */
export function rebuildRepairsUpgradeFailure(upgradeError: unknown): boolean {
  return !(upgradeError instanceof SearchError && upgradeError.code === "INDEX_LOCKED");
}

/**
 * Open the index for reading, upgrading an older schema in place first -
 * the SAME in-place upgrade the query path performs, decided by the SAME
 * plan. A read-only surface that opens the index this way can never tell
 * the user to rebuild what an upgrade replaces.
 *
 * A refusal no upgrade can repair (a newer schema than this build, an
 * index stamped current with tables missing, a corrupt file) is the
 * caller's to report, unchanged: the rebuild advice is right for those.
 *
 * An index another process made current between the refused open and the
 * plan is answered, not refused: the read is retried, the way the query
 * path retries it, and the stale mismatch - which named an old schema
 * version of an index that now answers - is not reported.
 *
 * A failed upgrade is reported the way the query path reports the same
 * two failures ({@link rebuildRepairsUpgradeFailure} is the decision both
 * paths read): a lock failure stays a lock error, because a rebuild would
 * not help; any other failure is the refusal the read started with - the
 * schema mismatch and the rebuild advice that answers it - with the
 * failure that stopped the upgrade kept as its cause, so the reason the
 * upgrade did not work is not lost.
 */
export async function openReadWithUpgrade(config: ResolvedSearchConfig): Promise<Store> {
  try {
    return await Store.open(config, { mode: "read" });
  } catch (e) {
    if (!(e instanceof SearchError) || e.code !== "SCHEMA_MISMATCH") throw e;
    const plan = planIndexRepair(config);
    // A plan no in-place repair exists for (`rebuild`): the caller's
    // refusal is right for it, and the rebuild advice it carries stands.
    if (plan.kind === "rebuild") throw e;
    // `upgrade-in-place`: the index is upgraded in place, exactly as the
    // query path upgrades it.
    if (plan.kind === "upgrade-in-place") {
      try {
        await upgradeIndexInPlace(config);
      } catch (upgradeError) {
        // A lock failure stays a lock error: another writer holds the
        // index, and a rebuild would only queue behind it.
        if (!rebuildRepairsUpgradeFailure(upgradeError)) throw upgradeError;
        // The refusal the read started with is what surfaces - a rebuild
        // is what repairs a failed migration - with the failure that
        // stopped the upgrade as its cause, so the reason it did not work
        // is not lost.
        throw new SearchError(e.code, e.message, { cause: upgradeError });
      }
    }
    // `current`: another process made the index current between the
    // refused open and this plan. It is readable now, so the read is
    // retried: the mismatch that named an old schema version is stale
    // advice about an index that answers.
    return await Store.open(config, { mode: "read" });
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
  } finally {
    closeDatabase(opened.db);
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
  // An unknown count before is not zero: the rebuild kept the previous
  // index (it never removes one it cannot count), and the notice says so.
  if (before === null || before > 0) {
    const after = countStoredEmbeddings(config.dbPath) ?? 0;
    // A verified rebuild keeps the richer parked index under the name it
    // was parked at, `.bak` or `.old`: the notice names what is there.
    const kept =
      [".bak", ".old"]
        .map((s) => config.dbPath + s)
        .filter((p) => existsSync(p))
        .join(" and ") || `${config.dbPath}.bak`;
    const dropped = before === null ? null : before - after;
    if (dropped === null) {
      // eslint-disable-next-line no-console
      console.error(
        "search index rebuilt: the stored embeddings of the previous index could not be counted, " +
          `so it is kept at ${kept}; if it held any, restore them with: ` +
          "o2b search index --embeddings",
      );
    } else if (dropped > 0) {
      // eslint-disable-next-line no-console
      console.error(
        `search index rebuilt: ${dropped} stored embedding(s) were not carried over ` +
          `(the previous index, which still holds them, is kept at ${kept}); ` +
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
  let plan = planIndexRepair(config);
  if (plan.kind === "current") return { kind: "current" };
  if (plan.kind === "upgrade-in-place") {
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
    plan = planIndexRepair(config);
    if (plan.kind === "current") return { kind: "migrated" };
  }
  // Entity rows of older rules over current chunks: a refresh in place keeps
  // every stored embedding, which a keyword-only rebuild would drop; an
  // index with none is rebuilt, which also writes the compact layout.
  if (plan.kind === "refresh-in-place") {
    await refreshEntitiesInPlace(config);
    if (inspectIndex(config) === "current") return { kind: "migrated" };
  }
  const stats = await rebuildIndexForSelfHeal(config, opts);
  return stats === null ? { kind: "current" } : { kind: "rebuilt", stats };
}
