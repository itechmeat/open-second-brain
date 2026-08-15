/**
 * Hands-off post-upgrade maintenance. After the plugin is updated, the on-disk
 * state of an already-initialised vault can lag the running version and would
 * otherwise need manual commands (`o2b search reindex`, `o2b brain upgrade`).
 * `ensureVaultCurrent` brings it current automatically and is safe to call on
 * every startup: it NEVER throws, and in `background` mode never blocks the
 * caller on a slow reindex.
 *
 * It is STATE-DRIVEN, not version-stamped: each step keys off actual on-disk
 * state (search index `schema_version`, `_brain.yaml` pending-changes plan).
 * This is deliberate - the vault is often synced across devices (e.g.
 * Syncthing), so a stamp written into the vault would let one device mark a
 * migration done and make another skip its own per-device work (the search
 * index is per-device). State checks are cheap reads and also handle
 * interrupted migrations and downgrades correctly.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Database } from "bun:sqlite";

import { defaultConfigPath } from "../config.ts";
import { brainConfigPath } from "../brain/paths.ts";
import { planUpgrade, applyUpgrade } from "../brain/upgrade.ts";
import { resolveSearchConfig } from "../search/index.ts";
import { reindexVault } from "../search/indexer.ts";
import { LATEST_SCHEMA_VERSION, readSchemaVersion } from "../search/schema.ts";
import { isWriterLockHeld } from "../search/store/writer-lock.ts";
import type { ResolvedSearchConfig } from "../search/types.ts";
import {
  mintSelfHealRunId,
  recordSelfHealSpawn,
  SELF_HEAL_SPAWN,
  type SelfHealSpawnDecision,
} from "./self-heal-reindex.ts";

/**
 * The flag that tells the child to record its own terminal outcome. It
 * takes the run id this run's rows pair on, so the child never has to
 * invent one the parent could not have written.
 */
const SELF_HEAL_FLAG = "--self-heal";

export interface EnsureCurrentResult {
  /** Vault-relative paths of Brain managed files migrated this run. */
  readonly brainUpgraded: ReadonlyArray<string>;
  /** A search reindex was started (background) or completed (foreground). */
  readonly reindexTriggered: boolean;
  /**
   * In `background` mode, what was done about a reindex this run found
   * necessary. `null` when none was needed, or when the run was in the
   * foreground and there was no child to decide about.
   */
  readonly reindexSpawn: SelfHealSpawnDecision | null;
  /** Non-empty when nothing ran, e.g. "not-initialized". */
  readonly skipped: string;
  /** Best-effort: per-step failures, never thrown. */
  readonly errors: ReadonlyArray<string>;
}

export interface EnsureCurrentOptions {
  /** When true (default for startup), a needed reindex runs detached and the
   * call returns immediately. When false, the reindex is awaited (used by
   * tests and explicit callers). */
  readonly background?: boolean;
  /** Plugin config path to resolve search settings from. Defaults to
   * `defaultConfigPath()`. Threading this ensures the index that is checked and
   * (re)built matches the one the caller's server actually uses, e.g. under
   * `o2b mcp --config <custom>`. */
  readonly configPath?: string;
}

function message(e: unknown): string {
  return e instanceof Error ? (e.message ?? String(e)) : String(e);
}

/** Cheap, read-only check: is the search index absent or on a stale schema? */
function indexNeedsRebuild(config: ResolvedSearchConfig): boolean {
  if (!existsSync(config.dbPath)) return true;
  let db: Database;
  try {
    db = new Database(config.dbPath, { readonly: true });
  } catch {
    return true; // unreadable -> rebuild
  }
  try {
    return readSchemaVersion(db) !== LATEST_SCHEMA_VERSION;
  } catch {
    return true; // corrupt / non-OSB file -> rebuild
  } finally {
    db.close();
  }
}

/** Path to this checkout's `scripts/o2b` (current plugin version). */
function o2bScriptPath(): string {
  // src/core/maintenance/ensure-current.ts -> repo root
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  return join(repo, "scripts", "o2b");
}

/**
 * Start a reindex without blocking, unless the writer lock is already held.
 *
 * Spawns a detached `o2b search reindex` so the rebuild survives a
 * short-lived caller (a SessionStart hook process) and does not tie up a
 * long-lived one (the MCP server).
 *
 * ## The probe is advisory, and this is not mutual exclusion
 *
 * A schema bump makes every session that starts afterwards find the index
 * stale at once, so N sessions used to spawn N children; one took the lock
 * and the rest spun three seconds and died with their stderr pointed at
 * nothing. {@link isWriterLockHeld} is checked FIRST so a child that can
 * already be seen to lose is never started.
 *
 * That check is a read of an instant, not a claim on it. Two callers can
 * both find the lock free and both spawn - the window between the probe and
 * the child's own `acquireWriterLock` is not closed by anything here, and
 * closing it would mean holding the lock across a spawn, which would hand a
 * detached child a lock its parent owns. `reindexVault`'s lock remains the
 * only exclusion in the system; this only thins the herd, and the loser of
 * a real race now records why it lost.
 *
 * ## How wide that window is, measured, and what the probe therefore buys
 *
 * The window is a cold Bun start plus module load, flag parse and config
 * resolution before `reindexVault` reaches its lock. Measured on a 400-note
 * vault, spawn to lock-held was 710, 753, 723, 737, 710 ms over five runs.
 * So the probe thins NOTHING among callers that probe inside those ~0.7 s:
 * four parents released from one barrier all found the lock free and all
 * spawned (measured 4/4).
 *
 * What it does buy is every caller that arrives AFTER a child has the lock,
 * and on a real vault that is most of them: a rebuild that takes minutes is
 * a minutes-long window in which each new `SessionStart` / `PostCompact`
 * hook is a caller that now starts nothing (measured: a parent 1.5 s behind
 * the first records `skipped_writer_lock`). The simultaneous burst this
 * module's opening paragraph describes is exactly the case it does not
 * help; closing that one needs a claim the parent can make before the
 * spawn, which is a lock with its own staleness policy, not a probe.
 * `tests/core/maintenance/self-heal-reindex.test.ts` pins both halves.
 *
 * The child's streams stay ignored: it is detached and there is no terminal
 * to write to. Its terminal outcome goes to the `self_heal_reindex` metrics
 * surface instead, which `--self-heal <run-id>` arms - the same run id this
 * function records on the spawn row, so the two rows pair without a pid;
 * see `self-heal-reindex.ts` for why the parent cannot record the outcome.
 */
function startSelfHealReindex(
  vault: string,
  configPath: string,
  dbPath: string,
  errors: string[],
): SelfHealSpawnDecision {
  let lockHeld = false;
  try {
    lockHeld = isWriterLockHeld(dbPath);
  } catch (e) {
    // The probe could not answer. That is reported, not swallowed - and
    // the spawn goes ahead anyway: declining to self-heal because a stat
    // failed would leave a stale index behind with nobody told, while a
    // child that turns out to lose the race now records why.
    errors.push(`writer-lock-probe: ${message(e)}`);
  }
  if (lockHeld) {
    recordSelfHealSpawn(vault, SELF_HEAL_SPAWN.skippedWriterLock);
    return SELF_HEAL_SPAWN.skippedWriterLock;
  }
  // Minted BEFORE the spawn: it is what the child is told to write on its
  // own terminal row, so the pair exists whichever process writes first.
  const runId = mintSelfHealRunId();
  const proc = Bun.spawn(
    [
      o2bScriptPath(),
      "search",
      "reindex",
      "--vault",
      vault,
      "--config",
      configPath,
      SELF_HEAL_FLAG,
      runId,
    ],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  proc.unref();
  recordSelfHealSpawn(vault, SELF_HEAL_SPAWN.spawned, runId);
  return SELF_HEAL_SPAWN.spawned;
}

export async function ensureVaultCurrent(
  vault: string,
  opts: EnsureCurrentOptions = {},
): Promise<EnsureCurrentResult> {
  const background = opts.background ?? true;
  const errors: string[] = [];
  let brainUpgraded: ReadonlyArray<string> = [];
  let reindexTriggered = false;
  let reindexSpawn: SelfHealSpawnDecision | null = null;

  // Only an already-initialised vault is an upgrade target. A missing
  // `_brain.yaml` means "not set up yet" - that is `o2b init`'s job, not ours.
  if (!existsSync(brainConfigPath(vault))) {
    return {
      brainUpgraded: [],
      reindexTriggered: false,
      reindexSpawn: null,
      skipped: "not-initialized",
      errors: [],
    };
  }

  // 1. Brain managed-file upgrade - idempotent; only when changes are pending
  //    and the plan is clean (a half-mergeable plan is left for the operator).
  try {
    const plan = planUpgrade(vault);
    if (plan.errors === 0 && plan.pending > 0) {
      brainUpgraded = applyUpgrade(vault).files_updated;
    }
  } catch (e) {
    errors.push(`brain-upgrade: ${message(e)}`);
  }

  // 2. Search index - rebuild if absent or on a stale schema.
  try {
    const configPath = opts.configPath ?? defaultConfigPath();
    const config = resolveSearchConfig({ vault, configPath });
    if (indexNeedsRebuild(config)) {
      if (background) {
        reindexSpawn = startSelfHealReindex(vault, configPath, config.dbPath, errors);
        // A run that declined to spawn started nothing, and saying it did
        // would report a rebuild that is not this run's.
        reindexTriggered = reindexSpawn === SELF_HEAL_SPAWN.spawned;
      } else {
        await reindexVault(config);
        reindexTriggered = true;
      }
    }
  } catch (e) {
    errors.push(`search-reindex: ${message(e)}`);
  }

  return { brainUpgraded, reindexTriggered, reindexSpawn, skipped: "", errors };
}
