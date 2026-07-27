/**
 * Semantic health (v0.14.0): what the rule set MEANS, rather than
 * whether it parses.
 *
 * Contradictions, uncovered recurring concepts, claims nothing has
 * re-confirmed, and batches confirmed together without dedup. The
 * detectors live in `health/reconcile.ts`; this module supplies them
 * their corpus and turns their findings into doctor warnings.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  reconcileSemanticHealth,
  type PreferenceForHealth,
  type SemanticHealthReport,
} from "../health/reconcile.ts";
import { brainDirs } from "../paths.ts";
import { BRAIN_HEALTH_DEFAULTS, loadBrainConfigDetailed, resolveHealth } from "../policy.ts";
import { parseSignal } from "../signal.ts";
import type { DoctorIssue, ResolvedBrainHealthConfig } from "../types.ts";
import { readAllPreferenceRecords, type PreferenceRecord } from "./records.ts";

/**
 * Compute only the semantic-health report, skipping the structural
 * doctor sweep. `runDoctor` attaches the identical report via its inline
 * pass; a caller that needs nothing but the semantic findings (e.g.
 * vault vitals reading `conceptGaps` for gap pressure) can call this
 * directly instead of paying for the full config / signals / backlinks /
 * logs / entities sweep. Both paths route through the same
 * {@link checkSemanticHealth} detector over the same inputs
 * ({@link readAllPreferenceRecords}, `resolveHealth(cfg)` or the
 * defaults, and `now`), so the findings are byte-for-byte identical.
 *
 * Best-effort and never throws: returns `undefined` only when the pass
 * itself throws, mirroring `runDoctor`'s attach-on-success contract. Any
 * lint issues the pass would emit into the doctor stream are discarded
 * here, which is exactly what a report-only caller wants.
 */
export function computeSemanticHealth(
  vault: string,
  opts: { readonly now?: Date } = {},
): SemanticHealthReport | undefined {
  const now = opts.now ?? new Date();
  let cfg;
  try {
    cfg = loadBrainConfigDetailed(vault).config;
  } catch {
    cfg = undefined;
  }
  try {
    const prefRecords = readAllPreferenceRecords(vault);
    const health = cfg ? resolveHealth(cfg) : BRAIN_HEALTH_DEFAULTS;
    return checkSemanticHealth(vault, prefRecords, [], health, now);
  } catch {
    return undefined;
  }
}

/** Minimal signal projection the semantic-health pass needs. */
interface SignalSignRecord {
  readonly id: string;
  readonly sign: import("../types.ts").BrainSignalSign;
  readonly principle: string;
  readonly created_at: string;
}

/**
 * Read every `sig-*.md` across `inbox/` and `processed/`, projecting
 * each to its id, sign, and principle. Files that fail to parse are
 * skipped (their schema errors surface through the signal record check).
 */
function readAllSignalRecords(vault: string): ReadonlyArray<SignalSignRecord> {
  const dirs = brainDirs(vault);
  const out: SignalSignRecord[] = [];
  for (const dir of [dirs.inbox, dirs.processed]) {
    if (!existsSync(dir)) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".md") || !name.startsWith("sig-")) continue;
      try {
        const sig = parseSignal(join(dir, name));
        out.push({
          id: sig.id,
          sign: sig.signal,
          principle: sig.principle,
          created_at: sig.created_at,
        });
      } catch {
        // schema error - reported by the signal record check
      }
    }
  }
  return out;
}

/**
 * Run the semantic-health detectors, merge their findings into the
 * shared `issues` array as warnings, and return the structured report.
 * Confirmed preferences feed the contradiction and stale-claim passes;
 * signal + preference principles feed the concept-gap pass.
 */
export function checkSemanticHealth(
  vault: string,
  prefRecords: ReadonlyArray<PreferenceRecord>,
  issues: DoctorIssue[],
  health: ResolvedBrainHealthConfig,
  now: Date,
): SemanticHealthReport {
  const signals = readAllSignalRecords(vault);
  const signSignById = new Map(signals.map((s) => [s.id, s.sign]));
  const preferences: PreferenceForHealth[] = prefRecords.map(({ pref }) => pref);
  const corpusPrinciples = [
    ...signals.map((s) => s.principle),
    ...prefRecords.map((r) => r.pref.principle),
  ];
  // Aligned index-for-index with corpusPrinciples: the authored date of
  // each entry, so the baseline watermark can tell a concept gap that is
  // entirely old from one still mentioned in fresh memory.
  const corpusPrincipleDates: (string | null)[] = [
    ...signals.map((s) => s.created_at),
    ...prefRecords.map((r) => r.pref.created_at),
  ];
  const coveredTopics = prefRecords.map((r) => r.pref.topic);

  const report = reconcileSemanticHealth(
    { preferences, signSignById, corpusPrinciples, corpusPrincipleDates, coveredTopics },
    {
      contradictionJaccard: health.contradiction_jaccard,
      conceptGapMinFrequency: health.concept_gap_min_frequency,
      staleClaimMaxAgeDays: health.stale_claim_max_age_days,
      ...(health.silence_before !== null ? { silenceBefore: health.silence_before } : {}),
      now,
    },
  );

  for (const c of report.contradictions) {
    issues.push({
      severity: "warning",
      code: "contradictory-preferences",
      message:
        `[[${c.aId}]] (${c.aSign}) and [[${c.bId}]] (${c.bSign})` +
        `${c.scope ? ` in scope '${c.scope}'` : ""}` +
        ` look like contradictions (jaccard ${c.jaccard.toFixed(2)} of principle tokens,` +
        " opposite sign of record). Reconcile or retire one.",
    });
  }
  for (const g of report.conceptGaps) {
    issues.push({
      severity: "warning",
      code: "concept-gap",
      message:
        `term '${g.term}' recurs across ${g.frequency} entries but no preference topic covers it.` +
        " Consider capturing a dedicated preference.",
    });
  }
  for (const s of report.staleClaims) {
    issues.push({
      severity: "warning",
      code: "stale-claim",
      message:
        `[[${s.id}]] last saw evidence ${s.ageDays} days ago (${s.lastEvidenceAt}).` +
        " Re-confirm or retire it.",
    });
  }
  for (const b of report.batchInflation) {
    issues.push({
      severity: "warning",
      code: "batch-concept-inflation",
      message:
        `${b.count} preferences confirmed within one window (${b.windowStart} to ${b.windowEnd}): ` +
        `${b.ids.map((id) => `[[${id}]]`).join(", ")} across topics ${b.topics.join(", ")}. ` +
        "A batch this size confirmed together usually means dedup/consolidation was skipped - " +
        "review for near-duplicates or preferences that should merge before the next dream pass.",
    });
  }

  return report;
}
