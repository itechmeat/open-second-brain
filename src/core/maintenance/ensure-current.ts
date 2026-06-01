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
import type { ResolvedSearchConfig } from "../search/types.ts";

export interface EnsureCurrentResult {
  /** Vault-relative paths of Brain managed files migrated this run. */
  readonly brainUpgraded: ReadonlyArray<string>;
  /** A search reindex was started (background) or completed (foreground). */
  readonly reindexTriggered: boolean;
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
 * Start a reindex without blocking. Spawns a detached `o2b search reindex` so
 * it survives a short-lived caller (e.g. a SessionStart hook process), and
 * does not tie up a long-lived one (the MCP server). `reindexVault` is
 * lock-guarded, so a concurrent rebuild is serialised, not duplicated.
 */
function spawnDetachedReindex(vault: string): void {
  const proc = Bun.spawn([o2bScriptPath(), "search", "reindex", "--vault", vault], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  proc.unref();
}

export async function ensureVaultCurrent(
  vault: string,
  opts: EnsureCurrentOptions = {},
): Promise<EnsureCurrentResult> {
  const background = opts.background ?? true;
  const errors: string[] = [];
  let brainUpgraded: ReadonlyArray<string> = [];
  let reindexTriggered = false;

  // Only an already-initialised vault is an upgrade target. A missing
  // `_brain.yaml` means "not set up yet" - that is `o2b init`'s job, not ours.
  if (!existsSync(brainConfigPath(vault))) {
    return { brainUpgraded: [], reindexTriggered: false, skipped: "not-initialized", errors: [] };
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
    const config = resolveSearchConfig({ vault, configPath: defaultConfigPath() });
    if (indexNeedsRebuild(config)) {
      reindexTriggered = true;
      if (background) {
        spawnDetachedReindex(vault);
      } else {
        await reindexVault(config);
      }
    }
  } catch (e) {
    errors.push(`search-reindex: ${message(e)}`);
  }

  return { brainUpgraded, reindexTriggered, skipped: "", errors };
}
