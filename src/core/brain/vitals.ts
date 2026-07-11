/**
 * Vault vitals — aggregate governance health scorecard.
 *
 * The existing hygiene surfaces (`doctor`, `health`, `moc-audit`) are
 * all per-item: one warning per duplicate pair, one finding per
 * contradiction, one bucket per MOC hub. None of them answer "is the
 * preference set as a whole spreading thin, well-evidenced, and
 * keeping up with its own gap backlog?" — a single scorecard over the
 * full `Brain/preferences/` set, four numbers:
 *
 *   - `domain_diversity`   — normalised Shannon entropy of the `scope`
 *                            distribution (0 = every preference shares
 *                            one scope, 1 = evenly spread).
 *   - `connectivity_index` — mean `evidenced_by.length` per confirmed
 *                            preference (how well individual rules are
 *                            backed by originating signals).
 *   - `orphan_preferences` — confirmed preferences below the evidence
 *                            threshold (thin backing, candidates for
 *                            re-confirmation or retirement).
 *   - `gap_pressure`       — open `concept-gap` findings (reused from
 *                            {@link runDoctor}'s semantic-health pass,
 *                            not recomputed here) divided by preference
 *                            count: are gaps piling up faster than
 *                            they're being distilled into preferences?
 *
 * Pure aggregation, no new detector logic and no filesystem writes.
 * Read-only; scope limited to `confirmed` preferences so trial
 * (`unconfirmed`) and `quarantine` records don't skew the averages —
 * same convention `checkLowEvidenceConfirmed` uses.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { brainDirs } from "./paths.ts";
import { parsePreference } from "./preference.ts";
import { runDoctor } from "./doctor.ts";
import { BRAIN_PREFERENCE_STATUS, type BrainPreference } from "./types.ts";

export interface VaultVitalsOptions {
  /** `evidenced_by.length` strictly below this counts as an orphan. Default 2. */
  readonly orphanThreshold?: number;
}

export interface VaultVitalsOrphan {
  readonly id: string;
  readonly scope: string | undefined;
  readonly evidence_count: number;
}

export interface VaultVitalsScopeCount {
  readonly scope: string;
  readonly count: number;
}

export interface VaultVitalsReport {
  readonly preferences_scanned: number;
  readonly domain_diversity: number;
  readonly connectivity_index: number;
  readonly orphan_preferences: ReadonlyArray<VaultVitalsOrphan>;
  readonly gap_pressure: number;
  readonly scope_distribution: ReadonlyArray<VaultVitalsScopeCount>;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Confirmed preferences only — mirrors `checkLowEvidenceConfirmed`'s scope. */
function readConfirmedPreferences(vault: string): BrainPreference[] {
  const dir = brainDirs(vault).preferences;
  if (!existsSync(dir)) return [];
  const out: BrainPreference[] = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".md") || !name.startsWith("pref-")) continue;
    let pref: BrainPreference;
    try {
      pref = parsePreference(join(dir, name));
    } catch {
      continue; // schema errors are already surfaced by `o2b brain doctor`
    }
    if (pref.status === BRAIN_PREFERENCE_STATUS.confirmed) out.push(pref);
  }
  return out;
}

/** Normalised Shannon entropy of `scope` (missing scope groups as `"unscoped"`). */
function scopeDiversity(prefs: ReadonlyArray<BrainPreference>): {
  diversity: number;
  distribution: VaultVitalsScopeCount[];
} {
  const counts = new Map<string, number>();
  for (const p of prefs) {
    const scope = p.scope ?? "unscoped";
    counts.set(scope, (counts.get(scope) ?? 0) + 1);
  }
  const distribution = [...counts.entries()]
    .map(([scope, count]) => ({ scope, count }))
    .toSorted((a, b) => b.count - a.count || a.scope.localeCompare(b.scope));

  if (prefs.length === 0 || counts.size <= 1) return { diversity: 0, distribution };
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / prefs.length;
    entropy -= p * Math.log2(p);
  }
  const entropyMax = Math.log2(counts.size);
  return { diversity: entropyMax > 0 ? round2(entropy / entropyMax) : 0, distribution };
}

/**
 * Compute the vault vitals scorecard. `gap_pressure`'s numerator reuses
 * {@link runDoctor}'s semantic-health `conceptGaps` count rather than
 * re-running the detector — one source of truth for "how many gaps are
 * open". A doctor failure degrades `gap_pressure` to `0` rather than
 * failing the whole report: vitals is observability, not correctness.
 */
export function computeVaultVitals(vault: string, opts: VaultVitalsOptions = {}): VaultVitalsReport {
  const orphanThreshold = opts.orphanThreshold ?? 2;
  const prefs = readConfirmedPreferences(vault);
  const { diversity, distribution } = scopeDiversity(prefs);

  const connectivity =
    prefs.length > 0
      ? round2(prefs.reduce((sum, p) => sum + p.evidenced_by.length, 0) / prefs.length)
      : 0;

  const orphans: VaultVitalsOrphan[] = prefs
    .filter((p) => p.evidenced_by.length < orphanThreshold)
    .map((p) => ({ id: p.id, scope: p.scope, evidence_count: p.evidenced_by.length }))
    .toSorted((a, b) => a.evidence_count - b.evidence_count || a.id.localeCompare(b.id));

  let gapCount = 0;
  try {
    gapCount = runDoctor(vault).semantic_health?.conceptGaps.length ?? 0;
  } catch {
    // Vitals is observability, not correctness — a doctor failure
    // should not block the rest of the report.
  }
  const gapPressure = prefs.length > 0 ? round2(gapCount / prefs.length) : 0;

  return {
    preferences_scanned: prefs.length,
    domain_diversity: diversity,
    connectivity_index: connectivity,
    orphan_preferences: orphans,
    gap_pressure: gapPressure,
    scope_distribution: distribution,
  };
}
