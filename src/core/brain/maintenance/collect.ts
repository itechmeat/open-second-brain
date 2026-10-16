/**
 * Glue layer that gathers vault-maintenance signals (page-dedup
 * candidates, lint demotions / merged-link rewrites, token-footprint
 * excess) and hands them to the pure `scoreActions` function.
 *
 * Lives in `maintenance/` so the pure scorer stays I/O-free and both
 * `digest.ts` (read-only summary) and the `brain_doctor` MCP tool
 * can share the same collection logic without depending on each
 * other.
 *
 * The collection is fail-soft per signal, and the failures it absorbs
 * are NAMED: each failed scan is handed to the `onError` observer as a
 * {@link MaintenanceCollectError} while the remaining signals still
 * collect and the actions still return. A signal that fails
 * contributes no actions either way - what the observer buys is the
 * difference between a thin report because the vault is healthy and a
 * thin report because a scan refused.
 */

import { lintConsolidate } from "../lint-consolidate.ts";
import { findDuplicateCandidates } from "../page-dedup.ts";
import { computeTokenFootprint } from "../token-footprint.ts";
import { scoreActions, type ActionItem } from "./action-scorer.ts";

/** The maintenance scans this module collects, named for the failure report. */
export type MaintenanceCollectSignal = "dedup" | "lint" | "token-footprint";

/** One signal's collection failure: the named scan and the error it raised. */
export interface MaintenanceCollectError {
  readonly signal: MaintenanceCollectSignal;
  readonly message: string;
  /** The errno code the scan failed with, when the error carried one. */
  readonly code?: string;
}

/**
 * The same failure with a closed message: the scan name plus the errno
 * code, never the raised message, which can carry a host path (an
 * `ENOENT: ... open '/home/...'`). For every surface that answers a
 * caller below local reach.
 */
export function closedCollectError(error: MaintenanceCollectError): MaintenanceCollectError {
  return {
    signal: error.signal,
    message: `${error.signal} scan failed (${error.code ?? "error"})`,
    ...(error.code !== undefined ? { code: error.code } : {}),
  };
}

export interface CollectMaintenanceActionsOptions {
  /**
   * Observes each per-signal collection failure as it is absorbed. The scan
   * stays fail-soft either way; the doctor, digest and operator-summary
   * surfaces pass a collector and render what refused as a named
   * `collect_errors` row (review M10), so a thin report because the vault
   * is healthy is no longer indistinguishable from a thin report because a
   * scan refused.
   */
  readonly onError?: (error: MaintenanceCollectError) => void;
}

/**
 * Run one signal's scan, absorbing a failure as a named collected error
 * instead of a bare swallow. `undefined` means the signal contributes
 * nothing this run.
 */
function collectSignal<T>(
  signal: MaintenanceCollectSignal,
  onError: (error: MaintenanceCollectError) => void,
  run: () => T,
): T | undefined {
  try {
    return run();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    onError({
      signal,
      message: (err as Error)?.message ?? String(err),
      ...(typeof code === "string" ? { code } : {}),
    });
    return undefined;
  }
}

export function collectMaintenanceActions(
  vault: string,
  opts: CollectMaintenanceActionsOptions = {},
): ReadonlyArray<ActionItem> {
  const onError = opts.onError ?? (() => {});
  let dedupCandidates: Array<{ canonicalId: string; secondaryCount: number }> = [];
  let staleByLifecycle: Array<{ id: string; ageDays: number }> = [];
  let brokenLinks: Array<{ path: string; from: string }> = [];
  let tokenFootprint: { total: number; warnThreshold: number } | undefined;

  const dedup = collectSignal("dedup", onError, () => findDuplicateCandidates(vault));
  if (dedup !== undefined) {
    dedupCandidates = dedup.candidates.map((c) => ({
      canonicalId: c.canonical.id,
      secondaryCount: c.secondaries.length,
    }));
  }
  const lint = collectSignal("lint", onError, () => lintConsolidate(vault, { apply: false }));
  if (lint !== undefined) {
    staleByLifecycle = lint.demotions.map((d) => ({
      id: d.id,
      ageDays: d.ageDays,
    }));
    brokenLinks = lint.fixes.map((f) => ({ path: f.path, from: f.from }));
  }
  const footprint = collectSignal("token-footprint", onError, () => computeTokenFootprint(vault));
  if (footprint !== undefined) {
    tokenFootprint = {
      total: footprint.total,
      warnThreshold: footprint.warnThreshold,
    };
  }

  return scoreActions({
    dedupCandidates,
    staleByLifecycle,
    brokenLinks,
    ...(tokenFootprint ? { tokenFootprint } : {}),
  });
}
