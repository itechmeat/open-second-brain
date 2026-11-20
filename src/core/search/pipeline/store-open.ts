/**
 * Read-open policy for the query hot path: how a stale, absent, or
 * unreadable index heals itself instead of failing the search.
 */

import { existsSync } from "node:fs";

import {
  enterStagingRead,
  IndexBuildingError,
  readIndexBuild,
  stagingIndexPath,
  stagingReadable,
  type IndexBuildProgress,
  type StagingReadTicket,
} from "../build-progress.ts";
import { Store } from "../store.ts";
import { SearchError } from "../types.ts";
import type { ResolvedSearchConfig, SearchErrorCode } from "../types.ts";

export interface OpenReadOptions {
  /**
   * While a rebuild builds the first index, answer from its staging file
   * (see {@link indexBuildServed}). Only a search opts in: it says so in
   * its warnings; a change probe or a neighbour probe must not read a
   * half-built index as the truth.
   */
  readonly serveBuilding?: boolean;
}

/** A store opened on a staging file: the build progress it was opened at, and its claim. */
interface ServedBuild {
  readonly progress: IndexBuildProgress;
  readonly ticket: StagingReadTicket;
}

/** The stores opened on a staging file. */
const servedBuilds = new WeakMap<Store, ServedBuild>();

/**
 * The build progress `store` was opened at when it is a staging file
 * served while the index is being built, else null.
 */
export function indexBuildServed(store: Store): IndexBuildProgress | null {
  return servedBuilds.get(store)?.progress ?? null;
}

/**
 * Close a store a search opened and, when it was a staging file, give up
 * its claim on it, so the rebuild can swap it in: a staging file is held
 * for one query, never longer.
 */
export async function closeServedStore(store: Store): Promise<void> {
  try {
    await store.close();
  } finally {
    servedBuilds.get(store)?.ticket.release();
  }
}

/** Longest a read waits for a rebuild to accept or recreate its staging file. */
const PREPARING_WAIT_MS = 10_000;

/**
 * Wait while the rebuild of `dbPath` prepares its staging file (a file
 * an interrupted build left may be abandoned, or hold records forgotten
 * since, until it is accepted or recreated), at most
 * {@link PREPARING_WAIT_MS}. Returns the build as it is then.
 */
async function awaitPrepared(dbPath: string): Promise<IndexBuildProgress | null> {
  const deadline = Date.now() + PREPARING_WAIT_MS;
  let build = readIndexBuild(dbPath);
  while (build?.phase === "preparing" && Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(FINISHING_POLL_MS);
    build = readIndexBuild(dbPath);
  }
  return build;
}

/** Longest a read waits for a finishing rebuild to swap its index in. */
const FINISHING_WAIT_MS = 20_000;

/** How often that wait looks for the swapped-in index. */
const FINISHING_POLL_MS = 50;

/**
 * Wait for a rebuild that is swapping its index in: the index appears, or
 * the build ends without one, or {@link FINISHING_WAIT_MS} passes.
 */
async function awaitSwap(dbPath: string): Promise<void> {
  const deadline = Date.now() + FINISHING_WAIT_MS;
  while (Date.now() < deadline && !existsSync(dbPath)) {
    if (readIndexBuild(dbPath)?.phase !== "finishing") return;
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(FINISHING_POLL_MS);
  }
}

/**
 * The staging file of a running rebuild, opened for reading and refusing
 * every write (`query_only`): the query cache and the other best-effort
 * writes a search makes must not land in a file the rebuild is writing and
 * will swap in. Null when it cannot be read yet.
 */
async function openStagingIndex(
  config: ResolvedSearchConfig,
  build: IndexBuildProgress,
): Promise<Store | null> {
  // The claim comes first: a rebuild that is finishing never renames the
  // file under a reader (`enterStagingRead`).
  const ticket = enterStagingRead(config.dbPath);
  if (ticket === null) return null;
  let store: Store;
  try {
    store = await Store.open(
      { ...config, dbPath: stagingIndexPath(config.dbPath) },
      { mode: "read" },
    );
  } catch {
    ticket.release();
    return null;
  }
  try {
    store.brainRecordsConnection().exec("PRAGMA query_only = ON");
  } catch {
    await store.close();
    ticket.release();
    return null;
  }
  servedBuilds.set(store, { progress: build, ticket });
  return store;
}

/**
 * The open failures a rebuild can actually repair: a stale schema, an
 * absent index, and an index that is present but unreadable - which now
 * includes one condemned by the structural integrity gate.
 */
const SELF_HEALABLE_CODES: ReadonlySet<SearchErrorCode> = new Set<SearchErrorCode>([
  "INDEX_MISSING",
  "SCHEMA_MISMATCH",
  "INDEX_UNREADABLE",
]);

/**
 * Open the index for reading, self-healing a stale, absent, or unreadable
 * index. After a plugin upgrade the on-disk index can be a different schema
 * version (`SCHEMA_MISMATCH`), not yet built (`INDEX_MISSING`), or corrupt
 * / truncated / non-OSB at the index path (`INDEX_UNREADABLE`); rather than
 * forcing the user to run `o2b search reindex` / `o2b search index`, heal
 * once and retry. An older schema is upgraded in place, so the stored
 * embeddings survive; only a state a migration cannot repair is rebuilt
 * (see `self-heal.ts`).
 *
 * A rebuild that fails is not swallowed. It may legitimately be a
 * concurrent writer already rebuilding (`INDEX_LOCKED`), in which case the
 * retry below succeeds and there is nothing to report - so its failure is
 * held rather than thrown. But if the retry ALSO fails, the retry's error
 * describes the symptom while the held one describes why the repair did not
 * happen, and a caller shown only the symptom would be sent back to the
 * command that just failed. Both are reported.
 */
export async function openReadOrSelfHeal(
  config: ResolvedSearchConfig,
  opts: OpenReadOptions = {},
): Promise<Store> {
  let openFailure: SearchError;
  try {
    return await Store.open(config, { mode: "read" });
  } catch (e) {
    if (!(e instanceof SearchError) || !SELF_HEALABLE_CODES.has(e.code)) throw e;
    openFailure = e;
  }

  // No index yet, and a rebuild is building one (the first start after the
  // brain moved into the brain store): a rebuild of our own would only
  // queue behind it and fail on its lock. A search answers from what the
  // build has indexed so far instead; every other read keeps the refusal,
  // now saying what is true.
  if (openFailure.code === "INDEX_MISSING") {
    // A staging file is never read before the rebuild accepted or
    // recreated it: a search waits out the preparation first.
    const build =
      opts.serveBuilding === true
        ? await awaitPrepared(config.dbPath)
        : readIndexBuild(config.dbPath);
    if (build !== null) {
      if (opts.serveBuilding === true && stagingReadable(build.phase)) {
        const staging = await openStagingIndex(config, build);
        if (staging !== null) return staging;
      }
      // The build is swapping its index in (or began to while this read
      // looked): that takes seconds, so wait for it rather than refuse.
      if (readIndexBuild(config.dbPath)?.phase === "finishing") {
        await awaitSwap(config.dbPath);
        try {
          return await Store.open(config, { mode: "read" });
        } catch (e) {
          if (!(e instanceof SearchError) || e.code !== "INDEX_MISSING") throw e;
        }
      }
      const now = readIndexBuild(config.dbPath);
      if (now !== null) throw new IndexBuildingError(config.dbPath, now);
      // The build ended without an index: the self-heal below decides.
    }
  }

  // Imported lazily so the hot path never pulls in the indexer and there
  // is no module cycle.
  const heal = await import("../self-heal.ts");
  let healFailure: string | null = null;
  let rebuild = true;

  // An older schema is migrated in place, keeping every stored vector and
  // its recorded identity (#256). A condemned or absent index, a newer
  // schema, and one the migration did not make readable still rebuild.
  if (openFailure.code === "SCHEMA_MISMATCH" && heal.inspectIndex(config) !== "rebuild") {
    let upgraded = true;
    try {
      // A concurrent healer may already have made it current; the
      // re-inspection skips a pointless write open.
      if (heal.inspectIndex(config) === "older-schema") await heal.upgradeIndexInPlace(config);
    } catch (e) {
      upgraded = false;
      if (e instanceof SearchError && e.code === "INDEX_LOCKED") {
        // Another writer holds the index; a rebuild would only queue behind
        // it to discard its work. Reported with the symptom if the final
        // retry fails.
        healFailure = e.message;
        rebuild = false;
      }
      // Any other failure (a migration rolled back) falls back to a rebuild.
    }
    if (upgraded) {
      try {
        return await Store.open(config, { mode: "read" });
      } catch (e) {
        if (!(e instanceof SearchError) || !SELF_HEALABLE_CODES.has(e.code)) throw e;
        openFailure = e;
      }
    }
  }

  if (rebuild) {
    try {
      await heal.rebuildIndexForSelfHeal(config);
    } catch (e) {
      healFailure = e instanceof Error ? e.message : String(e);
    }
  }

  try {
    return await Store.open(config, { mode: "read" });
  } catch (e) {
    if (healFailure === null) throw e;
    const code: SearchErrorCode = e instanceof SearchError ? e.code : "INDEX_UNREADABLE";
    const symptom = e instanceof Error ? e.message : String(e);
    throw new SearchError(
      code,
      `${symptom} (the automatic rebuild of ${config.dbPath} after ` +
        `${openFailure.code} also failed: ${healFailure})`,
    );
  }
}
