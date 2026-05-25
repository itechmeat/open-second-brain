/**
 * Glue layer that gathers vault-maintenance signals (page-dedup
 * candidates, lint demotions / merged-link rewrites, token-footprint
 * excess) and hands them to the pure `scoreActions` function.
 *
 * Lives in `maintenance/` so the pure scorer stays I/O-free and both
 * `digest.ts` (read-only summary) and the `brain_doctor` MCP tool
 * can share the same collection logic without depending on each
 * other.
 */

import { lintConsolidate } from "../lint-consolidate.ts";
import { findDuplicateCandidates } from "../page-dedup.ts";
import { computeTokenFootprint } from "../token-footprint.ts";
import { scoreActions, type ActionItem } from "./action-scorer.ts";

export function collectMaintenanceActions(
  vault: string,
): ReadonlyArray<ActionItem> {
  let dedupCandidates: Array<{ canonicalId: string; secondaryCount: number }> = [];
  let staleByLifecycle: Array<{ id: string; ageDays: number }> = [];
  let brokenLinks: Array<{ path: string; from: string }> = [];
  let tokenFootprint: { total: number; warnThreshold: number } | undefined;

  try {
    const dedup = findDuplicateCandidates(vault);
    dedupCandidates = dedup.candidates.map((c) => ({
      canonicalId: c.canonical.id,
      secondaryCount: c.secondaries.length,
    }));
  } catch {
    // Best-effort: a vault scan failure must not break the consumer.
  }
  try {
    const lint = lintConsolidate(vault, { apply: false });
    staleByLifecycle = lint.demotions.map((d) => ({
      id: d.id,
      ageDays: d.ageDays,
    }));
    brokenLinks = lint.fixes.map((f) => ({ path: f.path, from: f.from }));
  } catch {
    // ignore
  }
  try {
    const footprint = computeTokenFootprint(vault);
    tokenFootprint = {
      total: footprint.total,
      warnThreshold: footprint.warnThreshold,
    };
  } catch {
    // ignore
  }

  return scoreActions({
    dedupCandidates,
    staleByLifecycle,
    brokenLinks,
    ...(tokenFootprint ? { tokenFootprint } : {}),
  });
}
