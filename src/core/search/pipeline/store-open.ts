/**
 * Read-open policy for the query hot path: how a stale, absent, or
 * unreadable index heals itself instead of failing the search.
 */

import { existsSync } from "node:fs";

import {
  enterStagingRead,
  IndexBuildingError,
  IndexBuildStartFailedError,
  IndexBuildStartingError,
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

/**
 * Longest a search that started the first build itself waits for it to
 * answer: the child's start and its preparation, and, on a small vault,
 * the whole build.
 */
const STARTED_BUILD_WAIT_MS = 10_000;

/**
 * How long such a search waits for the finished index before it answers
 * from the staging file: a small vault is built well within it, so its
 * first search answers from the whole index, as when the search built it.
 */
const STARTED_BUILD_GRACE_MS = 3_000;

/**
 * Whether a missing index of `config` is built by a detached background
 * rebuild rather than by the search that found it missing, and the vault
 * and machine config that rebuild is started for. That is a store-aware
 * index (the first build after the switch to the brain store reads the
 * whole store, minutes on a large one) that the child the session start
 * spawns would build itself: `o2b search reindex --vault <vault> --config
 * <config>` resolves the very same index path. A config the child would
 * not resolve the same way (a caller's own overrides) keeps the build in
 * the search, as before.
 */
async function backgroundBuildTarget(
  config: ResolvedSearchConfig,
): Promise<{ readonly vault: string; readonly configPath: string } | null> {
  if (config.vault === null || config.brainStore === null || config.brainStore === undefined) {
    return null;
  }
  const { defaultConfigPath } = await import("../../config.ts");
  const { resolveSearchConfig } = await import("../index.ts");
  const configPath = config.configPath ?? defaultConfigPath();
  try {
    const child = resolveSearchConfig({ vault: config.vault, configPath });
    return indexShape(child) === indexShape(config) ? { vault: config.vault, configPath } : null;
  } catch {
    return null;
  }
}

/**
 * Everything of `config` that decides what a build writes into the index:
 * where it lives, which vault and store it reads, which notes it walks
 * and how it cuts and tokenises them. Two configs with the same shape
 * build the same index; a caller whose own overrides change any of it
 * builds in the search instead of handing the build to a child that
 * reads the config file.
 */
function indexShape(config: ResolvedSearchConfig): string {
  return JSON.stringify([
    config.dbPath,
    config.vault,
    config.brainStore?.root ?? null,
    config.brainStore?.partitions ?? null,
    config.scopeRules,
    config.chunkSize,
    config.chunkOverlap,
    config.chunkMinSize,
    config.ftsTokenize,
  ]);
}

/**
 * Start the background rebuild a session start would start for a missing
 * index (`ensure-current.ts`, the same writer-lock probe and the same
 * `self_heal_reindex` rows), then wait for it: until the index is swapped
 * in (a small vault), or until the build answers from its staging file
 * and {@link STARTED_BUILD_GRACE_MS} passed, at most
 * {@link STARTED_BUILD_WAIT_MS}. Returns whether the index exists now.
 * Null when the search should build the index itself (no target).
 */
async function startBackgroundBuild(config: ResolvedSearchConfig): Promise<boolean | null> {
  // Eligibility first: a search whose own settings would not build the
  // child's index never joins a start, it builds in the search.
  const target = await backgroundBuildTarget(config);
  if (target === null) return null;
  // Concurrent searches of one process (an MCP server) share one start,
  // only when they would build the same index.
  const key = indexShape(config);
  const inFlight = startingBuilds.get(key);
  if (inFlight !== undefined) return await inFlight;
  const start = startAndAwaitBuild(config, target);
  startingBuilds.set(key, start);
  try {
    return await start;
  } finally {
    startingBuilds.delete(key);
  }
}

/** The background build starts this process is waiting on, by index shape ({@link indexShape}). */
const startingBuilds = new Map<string, Promise<boolean>>();

async function startAndAwaitBuild(
  config: ResolvedSearchConfig,
  target: { readonly vault: string; readonly configPath: string },
): Promise<boolean> {
  const { startSelfHealReindex } = await import("../../maintenance/ensure-current.ts");
  const errors: string[] = [];
  try {
    startSelfHealReindex(target.vault, target.configPath, config.dbPath, errors);
  } catch (e) {
    // The spawn itself failed (its metrics row is fail-soft and never
    // throws, so a started child is never started twice): no build runs,
    // and saying one does would send every search into the same wait.
    throw new IndexBuildStartFailedError(config.dbPath, e instanceof Error ? e.message : String(e));
  }
  const startedMs = Date.now();
  const deadline = startedMs + STARTED_BUILD_WAIT_MS;
  while (Date.now() < deadline) {
    if (existsSync(config.dbPath)) return true;
    const build = readIndexBuild(config.dbPath);
    if (build?.phase === "finishing") {
      // Within what is left of this wait, never the full swap budget.
      // eslint-disable-next-line no-await-in-loop
      await awaitSwap(config.dbPath, deadline - Date.now());
      return existsSync(config.dbPath);
    }
    if (
      build !== null &&
      stagingReadable(build.phase) &&
      Date.now() - startedMs >= STARTED_BUILD_GRACE_MS
    ) {
      return false;
    }
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(FINISHING_POLL_MS);
  }
  return existsSync(config.dbPath);
}

/** Longest a read waits for a finishing rebuild to swap its index in. */
const FINISHING_WAIT_MS = 20_000;

/** How often that wait looks for the swapped-in index. */
const FINISHING_POLL_MS = 50;

/**
 * Wait for a rebuild that is swapping its index in: the index appears, or
 * the build ends without one, or {@link FINISHING_WAIT_MS} passes.
 */
async function awaitSwap(dbPath: string, budgetMs: number = FINISHING_WAIT_MS): Promise<void> {
  const deadline = Date.now() + Math.max(0, Math.min(budgetMs, FINISHING_WAIT_MS));
  while (Date.now() < deadline && !existsSync(dbPath)) {
    if (readIndexBuild(dbPath)?.phase !== "finishing") return;
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(FINISHING_POLL_MS);
  }
}

/**
 * Longest a read waits for the staging file of a build that announced it
 * to become openable. The build publishes the readiness of its staging
 * file before the file carries its schema (`IndexBuildRecorder.ready`),
 * so a read that lands in that window finds a file it cannot read yet;
 * the build makes it readable within a moment, and the read waits for
 * that instead of refusing the query.
 */
const STAGING_READY_WAIT_MS = 5_000;

/**
 * The staging file of the build at `build`, opened for reading once it
 * can be opened. The wait ends when the file opens, when the live index
 * appears (the build swapped it in), when the build stops announcing a
 * staging file (it is swapping its index in, and no new reader may open
 * the staging file), or after {@link STAGING_READY_WAIT_MS}. Null when
 * the staging file could not be read.
 */
async function awaitStagingIndex(
  config: ResolvedSearchConfig,
  build: IndexBuildProgress,
): Promise<Store | null> {
  const deadline = Date.now() + STAGING_READY_WAIT_MS;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop
    const staging = await openStagingIndex(config, build);
    if (staging !== null) return staging;
    if (Date.now() >= deadline) return null;
    // The build swapped its index in while this read waited: the live
    // index answers now, not the staging file.
    if (existsSync(config.dbPath)) return null;
    const current = readIndexBuild(config.dbPath);
    if (current === null || !stagingReadable(current.phase)) return null;
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
    let build =
      opts.serveBuilding === true
        ? await awaitPrepared(config.dbPath)
        : readIndexBuild(config.dbPath);
    // No build runs yet (the first search after the switch, before any
    // session start began one): a search starts the background build a
    // session start would start, instead of building the whole store in
    // its own process, and answers from what it has indexed so far.
    let backgrounded = false;
    if (build === null && opts.serveBuilding === true) {
      const built = await startBackgroundBuild(config);
      backgrounded = built !== null;
      if (built === true) {
        // What the store gained since the build read it (this start's own
        // spawn row, a sync) is caught up before the read opens: a write
        // open beside an open read cannot fold its log on close.
        const { catchUpBrainStore } = await import("../brain-store/catch-up.ts");
        await catchUpBrainStore(config, { force: true });
        return await Store.open(config, { mode: "read" });
      }
      if (built === false) {
        build = await awaitPrepared(config.dbPath);
        // Nothing to answer from yet: say so instead of building here.
        if (build === null) throw new IndexBuildStartingError(config.dbPath);
      }
    }
    if (build !== null) {
      if (opts.serveBuilding === true && stagingReadable(build.phase)) {
        const staging = await awaitStagingIndex(config, build);
        if (staging !== null) return staging;
      }
      // The build swapped its index in while this read waited for the
      // staging file: the live index answers now.
      if (existsSync(config.dbPath)) {
        try {
          return await Store.open(config, { mode: "read" });
        } catch (e) {
          if (!(e instanceof SearchError) || e.code !== "INDEX_MISSING") throw e;
        }
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
    // A build this search started in the background is never replaced by
    // one in the search, also when it ended without an index: the next
    // start or search starts it again.
    if (backgrounded && !existsSync(config.dbPath))
      throw new IndexBuildStartingError(config.dbPath);
  }

  // Imported lazily so the hot path never pulls in the indexer and there
  // is no module cycle.
  const heal = await import("../self-heal.ts");
  let healFailure: string | null = null;
  let rebuild = true;

  // An older schema is migrated in place, keeping every stored vector and
  // its recorded identity (#256). A condemned or absent index, a newer
  // schema, and one the migration did not make readable still rebuild.
  //
  // The plan is the ONE decision about what a stale index needs (see
  // `planIndexRepair`): the status surface and the post-upgrade
  // maintenance read the same one, so none of them can tell the user to
  // rebuild what a read upgrades in place.
  if (openFailure.code === "SCHEMA_MISMATCH") {
    const plan = heal.planIndexRepair(config);
    if (plan.kind !== "rebuild") {
      let upgraded = true;
      try {
        // A concurrent healer may already have made it current; the
        // re-inspection skips a pointless write open.
        if (plan.kind === "upgrade-in-place") await heal.upgradeIndexInPlace(config);
      } catch (e) {
        upgraded = false;
        if (!heal.rebuildRepairsUpgradeFailure(e)) {
          // Another writer holds the index; a rebuild would only queue behind
          // it to discard its work. Reported with the symptom if the final
          // retry fails.
          healFailure = e instanceof Error ? e.message : String(e);
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
