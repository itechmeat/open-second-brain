/**
 * The dream pass's time-based retire decision.
 *
 * One reason to change: when a preference has outlived its usefulness.
 * Two clocks drive it — an unconfirmed pref that ran past
 * `unconfirmed_until`, and a confirmed/quarantine pref whose last evidence
 * is older than the stale window. A pinned pref never actually retires;
 * it records a `retain-pinned` decision instead.
 *
 * Reads the post-refresh shape where one exists, so a pref promoted in
 * THIS run is judged on the counters this run is about to write, not the
 * stale ones on disk.
 *
 * Pure: no I/O. It mutates the plan it is handed, and prunes any refresh
 * update made pointless by a retire.
 */

import { effectiveStaleThresholdDays, isLowRecallSupersededAncestor } from "./inject-governor.ts";
import { preferenceSlug, type PlanState, type ScanResult } from "./dream-plan.ts";
import type { RefreshResult } from "./dream-refresh.ts";
import { isPinned } from "./pin.ts";
import { renderPrefLink } from "./wikilink.ts";
import {
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
  type BrainConfig,
  type BrainPreference,
  type BrainRetiredReason,
} from "./types.ts";

const DAY_MS = 24 * 3600 * 1000;

export function planAutoRetires(
  scan: ScanResult,
  cfg: BrainConfig,
  now: Date,
  plan: PlanState,
  refresh: RefreshResult,
): void {
  for (const rec of scan.preferences) {
    const slug = preferenceSlug(rec.pref.id);
    // Already planned to retire (rebutted)? Skip.
    if (plan.retires.some((r) => r.slug === slug)) continue;

    // Use the refreshed status/confirmed_at if available — a pref
    // promoted to confirmed in THIS run should be eligible for stale
    // retire only if its (yet-to-be-refreshed) last_evidence_at is
    // actually old. We branch on the post-refresh shape.
    const refreshed = refresh.updated.get(slug);
    const effectiveStatus = refreshed ? refreshed.status : rec.pref.status;

    if (effectiveStatus === BRAIN_PREFERENCE_STATUS.unconfirmed) {
      const deadline = Date.parse(rec.pref.unconfirmed_until);
      if (Number.isFinite(deadline) && now.getTime() > deadline) {
        recordRetire(plan, refresh, rec.pref, slug, BRAIN_RETIRED_REASON.expiredUnconfirmed, false);
      }
      continue;
    }

    // Confirmed/quarantine → stale-no-evidence check. Quarantine
    // is "still active" (design summary §20) so the time-based decay
    // applies to it identically — a pref sitting idle with no
    // evidence eventually retires whether confidence was healthy or
    // probationary at the time the clock ran out.
    if (
      effectiveStatus !== BRAIN_PREFERENCE_STATUS.confirmed &&
      effectiveStatus !== BRAIN_PREFERENCE_STATUS.quarantine
    ) {
      continue;
    }

    // Belief lifecycle suite (A4): a low-recall superseded ancestor
    // decays on the accelerated window so it leaves the working set
    // faster than a live memory. Non-superseded / well-used prefs keep
    // the normal window, so a vault with no chains is byte-identical.
    const chainDecay = isLowRecallSupersededAncestor({
      supersededBy: rec.supersededBy,
      appliedCount: refreshed ? refreshed.applied_count : rec.pref.applied_count,
    });
    const staleDays = effectiveStaleThresholdDays(chainDecay, cfg.retire.stale_evidence_days);

    // Confirmed with no evidence at all? Shouldn't happen, but
    // gate on the same staleness rule using `confirmed_at`. We
    // measure from confirmation in that case (cheaper than a
    // hand-crafted invariant check). An empty string counts as absent,
    // same as a missing field.
    const effectiveLastEvidence = refreshed
      ? refreshed.last_evidence_at
      : rec.pref.last_evidence_at;
    const effectiveConfirmedAt = refreshed ? refreshed.confirmed_at : rec.pref.confirmed_at;
    const since = effectiveLastEvidence ? effectiveLastEvidence : effectiveConfirmedAt;
    if (!since) continue;

    if (daysBetween(Date.parse(since), now.getTime()) > staleDays) {
      recordRetire(plan, refresh, rec.pref, slug, BRAIN_RETIRED_REASON.staleNoEvidence, chainDecay);
    }
  }
}

/**
 * Record the decision for one due preference. A pinned pref yields a
 * `retain-pinned` entry and stays put; anything else retires and drops its
 * pending refresh update — there is no point writing a file immediately
 * before moving it to `retired/`.
 */
function recordRetire(
  plan: PlanState,
  refresh: RefreshResult,
  pref: BrainPreference,
  slug: string,
  reason: BrainRetiredReason,
  chainDecay: boolean,
): void {
  if (isPinned(pref)) {
    plan.retainPinned.push({
      preference: renderPrefLink({
        id: pref.id,
        principle: pref.principle,
      }),
      reason,
    });
    return;
  }
  plan.retires.push({
    slug,
    principle: pref.principle,
    reason,
    ...(chainDecay ? { chainDecay: true } : {}),
  });
  refresh.updated.delete(slug);
}

function daysBetween(thenMs: number, nowMs: number): number {
  if (!Number.isFinite(thenMs)) return 0;
  return (nowMs - thenMs) / DAY_MS;
}
