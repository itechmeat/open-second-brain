/**
 * Stale-claim detector (F3).
 *
 * Flags confirmed preferences whose newest supporting evidence
 * (`last_evidence_at`) is older than a configured age window. A
 * different axis than `temporal/stale-watch.ts`, which keys off file
 * mtime - this keys off the recorded evidence date. Pure and
 * deterministic with an injected clock; preferences with a missing or
 * unparseable evidence date are skipped (their absence is a separate
 * lint's concern), and a future-dated evidence is never stale.
 */

import { BRAIN_PREFERENCE_STATUS, type BrainPreferenceStatus } from "../types.ts";
import { parseIsoUtc } from "./iso-time.ts";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Narrow projection the detector needs; {@link BrainPreference} satisfies it. */
export interface PreferenceForStaleClaim {
  readonly id: string;
  readonly status: BrainPreferenceStatus;
  readonly last_evidence_at: string | null;
}

export interface StaleClaimFinding {
  readonly id: string;
  readonly lastEvidenceAt: string;
  readonly ageDays: number;
}

export interface DetectStaleClaimsOptions {
  readonly maxAgeDays: number;
  readonly now: Date;
}

export function detectStaleClaims(
  prefs: ReadonlyArray<PreferenceForStaleClaim>,
  opts: DetectStaleClaimsOptions,
): StaleClaimFinding[] {
  const nowMs = opts.now.getTime();
  const out: StaleClaimFinding[] = [];
  for (const p of prefs) {
    if (p.status !== BRAIN_PREFERENCE_STATUS.confirmed) continue;
    if (!p.last_evidence_at) continue;
    const evMs = parseIsoUtc(p.last_evidence_at);
    if (!Number.isFinite(evMs)) continue;
    const ageDays = Math.floor((nowMs - evMs) / DAY_MS);
    if (ageDays <= opts.maxAgeDays) continue;
    out.push({ id: p.id, lastEvidenceAt: p.last_evidence_at, ageDays });
  }
  out.sort((a, b) => b.ageDays - a.ageDays || a.id.localeCompare(b.id));
  return out;
}
