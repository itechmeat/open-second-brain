/**
 * The automatic Brain managed-file upgrade, run off the start-up path.
 *
 * `ensureVaultCurrent` used to plan and apply a pending `_brain.yaml` /
 * `_BRAIN.md` upgrade inside the process that called it - the full-scope
 * MCP server and the `SessionStart` hook. Both calls were written as
 * fire-and-forget, but planning, the pre-apply snapshot and the rewrite are
 * synchronous, so all of it ran before the server read its first request:
 * seconds on a large `Brain/`, and past the host's connect timeout when the
 * snapshot was big enough to fail (GitHub #216).
 *
 * Now the caller claims a per-vault worker lock and starts a detached
 * `o2b brain upgrade --self-heal <token>`, which runs {@link runSelfHealUpgrade}
 * in its own process. The upgrade itself is unchanged - the same
 * `planUpgrade` / `applyUpgrade`, the same pre-apply snapshot, the same
 * writer lock that snapshot takes on the derived store - so the guarantees
 * the in-process path relied on hold in the worker; the worker lock adds
 * one it never had: one automatic upgrade per vault per machine at a time.
 *
 * ## What a run records
 *
 * A failed attempt writes the failure marker (`self-heal-upgrade-state.ts`)
 * that `o2b doctor`, `o2b brain status` and `o2b brain upgrade --dry-run`
 * read, and starts a cooldown before the next automatic attempt. Applied and
 * failed attempts also append one row to the `self_heal_upgrade` metrics
 * surface, the log of what the worker did. An attempt that finds nothing
 * pending writes nothing, so a start on a current vault leaves no trace.
 */

import { existsSync } from "node:fs";

import { appendMetric } from "../brain/metrics.ts";
import { brainConfigPath } from "../brain/paths.ts";
import { applyUpgrade, planUpgrade } from "../brain/upgrade.ts";
import {
  claimSelfHealUpgradeLock,
  clearSelfHealUpgradeFailure,
  ownsSelfHealUpgradeLock,
  readSelfHealUpgradeFailure,
  recordSelfHealUpgradeFailure,
  releaseSelfHealUpgradeLock,
  selfHealUpgradeBackoffActive,
} from "./self-heal-upgrade-state.ts";

/** Metrics surface the worker's applied and failed attempts go to. */
export const SELF_HEAL_UPGRADE_SURFACE = "self_heal_upgrade";

/** How one automatic upgrade attempt ended. */
export const SELF_HEAL_UPGRADE_OUTCOME = Object.freeze({
  /** Pending files were rewritten. */
  applied: "applied",
  /** Nothing was pending; any recorded failure was cleared. */
  current: "current",
  /** The plan or the apply failed; the failure marker was written. */
  failed: "failed",
  /** The plan has errors (a malformed `_brain.yaml`): left for the operator, as before. */
  planErrors: "plan_errors",
  /** A recorded failure's cooldown has not run out. */
  backoff: "backoff",
  /** Another worker holds this vault's lock. */
  running: "running",
  /** The vault is not (or no longer) initialised; nothing was touched. */
  notInitialized: "not_initialized",
} as const);

export type SelfHealUpgradeOutcome =
  (typeof SELF_HEAL_UPGRADE_OUTCOME)[keyof typeof SELF_HEAL_UPGRADE_OUTCOME];

export interface SelfHealUpgradeRun {
  readonly outcome: SelfHealUpgradeOutcome;
  /** Vault-relative paths rewritten; empty unless `applied`. */
  readonly filesUpdated: ReadonlyArray<string>;
  /** The failure; null unless `failed`. */
  readonly error: string | null;
}

export interface RunSelfHealUpgradeOptions {
  /** Clock for the backoff and the marker. Defaults to wall clock. */
  readonly now?: Date;
  /**
   * The lock claim a parent made and handed over (`--self-heal <token>`).
   * Absent, the run claims the lock itself.
   */
  readonly lockToken?: string;
}

function message(e: unknown): string {
  return e instanceof Error ? (e.message ?? String(e)) : String(e);
}

function run(
  outcome: SelfHealUpgradeOutcome,
  filesUpdated: ReadonlyArray<string> = [],
  error: string | null = null,
): SelfHealUpgradeRun {
  return Object.freeze({ outcome, filesUpdated: Object.freeze([...filesUpdated]), error });
}

/**
 * One automatic upgrade attempt for `vault`. Never throws: it runs where
 * nothing is left to catch (a detached worker with its streams ignored),
 * and every way it can end is an outcome.
 */
export function runSelfHealUpgrade(
  vault: string,
  opts: RunSelfHealUpgradeOptions = {},
): SelfHealUpgradeRun {
  const now = opts.now ?? new Date();
  let token: string | null;
  if (opts.lockToken !== undefined) {
    // A claim taken over as stale while this worker was starting is no
    // longer ours; the process that took it over does the work.
    token = ownsSelfHealUpgradeLock(vault, opts.lockToken) ? opts.lockToken : null;
  } else {
    try {
      token = claimSelfHealUpgradeLock(vault, now);
    } catch (e) {
      return run(SELF_HEAL_UPGRADE_OUTCOME.failed, [], `worker lock: ${message(e)}`);
    }
  }
  if (token === null) return run(SELF_HEAL_UPGRADE_OUTCOME.running);
  if (opts.lockToken !== undefined) {
    // A claim handed to a worker process covers that whole process, not
    // just this call: whatever the process still does on its way out is
    // part of the run whose end the lock's release announces.
    const held = token;
    process.once("exit", () => releaseSelfHealUpgradeLock(vault, held));
    return attempt(vault, now);
  }
  try {
    return attempt(vault, now);
  } finally {
    releaseSelfHealUpgradeLock(vault, token);
  }
}

function attempt(vault: string, now: Date): SelfHealUpgradeRun {
  // A vault removed or moved since the spawn: writing a marker would
  // recreate a directory nobody wants, so nothing is written at all.
  if (!existsSync(brainConfigPath(vault))) return run(SELF_HEAL_UPGRADE_OUTCOME.notInitialized);
  if (selfHealUpgradeBackoffActive(readSelfHealUpgradeFailure(vault), now)) {
    return run(SELF_HEAL_UPGRADE_OUTCOME.backoff);
  }
  const started = performance.now();
  let pending: string[] = [];
  try {
    const plan = planUpgrade(vault);
    if (plan.errors > 0) return run(SELF_HEAL_UPGRADE_OUTCOME.planErrors);
    if (plan.pending === 0) {
      clearSelfHealUpgradeFailure(vault);
      return run(SELF_HEAL_UPGRADE_OUTCOME.current);
    }
    pending = plan.files.filter((f) => f.status === "update").map((f) => f.path);
    const applied = applyUpgrade(vault, { now });
    clearSelfHealUpgradeFailure(vault);
    recordRow(vault, {
      outcome: SELF_HEAL_UPGRADE_OUTCOME.applied,
      duration_ms: Math.round(performance.now() - started),
      files: [...applied.files_updated],
    });
    return run(SELF_HEAL_UPGRADE_OUTCOME.applied, applied.files_updated);
  } catch (e) {
    const error = message(e);
    try {
      recordSelfHealUpgradeFailure(vault, error, pending, now);
    } catch {
      // The marker could not be written (read-only vault, full disk).
      // The metrics row below is the remaining record.
    }
    recordRow(vault, {
      outcome: SELF_HEAL_UPGRADE_OUTCOME.failed,
      duration_ms: Math.round(performance.now() - started),
      files: pending,
      error,
    });
    return run(SELF_HEAL_UPGRADE_OUTCOME.failed, [], error);
  }
}

function recordRow(vault: string, payload: Readonly<Record<string, unknown>>): void {
  try {
    appendMetric(vault, {
      surface: SELF_HEAL_UPGRADE_SURFACE,
      runAt: new Date().toISOString(),
      payload,
    });
  } catch {
    // Observability never fails the pass it observes.
  }
}
