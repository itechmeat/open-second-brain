/**
 * Evidence refresh and promotion planning (dream phase F4).
 *
 * Extracted from dream.ts. Scans apply-evidence log events (merge-
 * alias aware), recomputes per-preference counters, status
 * transitions (confirm, quarantine, context-driven retire), and
 * confidence - including the outcome-regression penalty. Pure
 * planning: callers apply the returned updates.
 */

import { BAND_RANK, computeConfidence, rebandConfidence } from "./confidence.ts";
import type { PlanState, ScanResult } from "./dream-plan.ts";
import { collectEvidenceForSlug } from "./evidence.ts";
import { listLogDates, readLogDay } from "./log-jsonl.ts";
import { isPinned } from "./pin.ts";
import { wouldRewritePreference } from "./preference.ts";
import { classifyFreshnessTrend } from "./temporal/freshness-trend.ts";
import { parseWikilink, renderPrefLink } from "./wikilink.ts";
import {
  BRAIN_APPLY_RESULT,
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_RETIRED_REASON,
  type BrainConfidence,
  type BrainConfig,
} from "./types.ts";

export interface RefreshUpdate {
  readonly slug: string;
  readonly topic: string;
  readonly scope?: string;
  readonly principle: string;
  readonly created_at: string;
  readonly unconfirmed_until: string;
  readonly status: (typeof BRAIN_PREFERENCE_STATUS)[keyof typeof BRAIN_PREFERENCE_STATUS];
  readonly evidenced_by: ReadonlyArray<string>;
  readonly confirmed_at: string | null;
  readonly applied_count: number;
  readonly violated_count: number;
  readonly last_evidence_at: string | null;
  readonly confidence: BrainConfidence;
  readonly confidence_value: number;
  readonly pinned: boolean;
  /**
   * Freshness trend (t_ee09a6ce), computed at PLAN time so the no-op
   * pre-flight (`wouldRewritePreference`) renders the same bytes the
   * write loop will stamp. Computing it only in the write loop would
   * make every stamped pref look like "needs rewrite" forever. Absent
   * when the stamp is withheld: a pref that has never carried the
   * field and is not being rewritten anyway stays byte-identical, so
   * legacy vaults keep their no-op dream guarantees.
   */
  readonly freshness_trend?: string;
}

/**
 * Pref → recorded band drop within the current dream pass. Captured
 * during refresh so the digest can render a `## Confidence drops`
 * section without re-deriving transitions from the log.
 */
/**
 * Outcome regression (t_d478df53): minimum applied-with-failure events
 * before a preference is flagged, and the multiplicative confidence
 * penalty a flagged preference receives. The penalty is part of the
 * deterministic confidence derivation, so reruns stay no-ops.
 */
export const OUTCOME_REGRESSION_MIN_FAILURES = 2;
export const OUTCOME_REGRESSION_PENALTY = 0.8;

export interface DreamOutcomeRegression {
  readonly id: string;
  readonly principle: string;
  readonly failures: number;
  readonly successes: number;
}

export interface RefreshBandDrop {
  readonly id: string;
  readonly principle: string;
  readonly previous: BrainConfidence;
  readonly next: BrainConfidence;
  readonly applied: number;
  readonly violated: number;
  readonly previous_value: number | null;
  readonly next_value: number;
}

export interface RefreshResult {
  /** Slugs transitioning unconfirmed → confirmed in THIS run. */
  readonly confirmed: Set<string>;
  /** Slug → full updated frontmatter to write. */
  readonly updated: Map<string, RefreshUpdate>;
  /**
   * Preferences whose `confidence` band dropped (e.g. `high → medium`)
   * during the refresh phase. Newest-first stable order (insertion
   * order at construction).
   */
  readonly bandDrops: RefreshBandDrop[];
  /** Preferences flagged by the outcome-regression rule (t_d478df53). */
  readonly outcomeRegressions: DreamOutcomeRegression[];
}

export interface ApplyEvidenceEntry {
  readonly pref_slug: string;
  readonly timestamp: string;
  readonly result: (typeof BRAIN_APPLY_RESULT)[keyof typeof BRAIN_APPLY_RESULT];
  /** Downstream outcome when recorded (t_d478df53). */
  readonly outcome?: "success" | "failure";
}

export function scanApplyEvidence(vault: string): ApplyEvidenceEntry[] {
  const out: ApplyEvidenceEntry[] = [];
  const mergeAliases = new Map<string, string>();
  // Shard-aware (Memory Integrity Suite): merged per-day reads.
  for (const date of listLogDates(vault)) {
    const { entries } = readLogDay(vault, date);
    for (const e of entries) {
      if (e.eventType === BRAIN_LOG_EVENT_KIND.merge) {
        const keep = parseWikilinkFromBodyValue(e.body["keep"]);
        const drop = parseWikilinkFromBodyValue(e.body["drop"]);
        if (keep?.startsWith("pref-") && drop?.startsWith("pref-")) {
          mergeAliases.set(
            drop.slice("pref-".length),
            resolveMergeAlias(keep.slice("pref-".length), mergeAliases),
          );
        }
        continue;
      }
      if (e.eventType !== BRAIN_LOG_EVENT_KIND.applyEvidence) continue;
      const prefRaw = e.body["preference"];
      const result = e.body["result"];
      if (typeof prefRaw !== "string" || typeof result !== "string") continue;
      if (
        result !== BRAIN_APPLY_RESULT.applied &&
        result !== BRAIN_APPLY_RESULT.violated &&
        result !== BRAIN_APPLY_RESULT.outdated
      )
        continue;
      // Parse `[[pref-slug]]` → slug.
      const target = parseWikilink(prefRaw);
      if (!target || !target.startsWith("pref-")) continue;
      out.push({
        pref_slug: target.slice("pref-".length),
        timestamp: e.timestamp,
        result: result as ApplyEvidenceEntry["result"],
        ...(e.body["outcome"] === "success" || e.body["outcome"] === "failure"
          ? { outcome: e.body["outcome"] as "success" | "failure" }
          : {}),
      });
    }
  }
  const resolved = out.map((entry) => ({
    ...entry,
    pref_slug: resolveMergeAlias(entry.pref_slug, mergeAliases),
  }));
  // Stable order: by timestamp ascending. Multiple entries at the same
  // second keep their parse order (parseLogDay returns insertion order).
  resolved.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  return resolved;
}

function parseWikilinkFromBodyValue(value: unknown): string | null {
  return typeof value === "string" ? parseWikilink(value) : null;
}

function resolveMergeAlias(slug: string, aliases: ReadonlyMap<string, string>): string {
  let current = slug;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const next = aliases.get(current);
    if (!next) return current;
    current = next;
  }
  return current;
}

export function planRefresh(
  vault: string,
  scan: ScanResult,
  evidence: ApplyEvidenceEntry[],
  cfg: BrainConfig,
  now: Date,
  plan: PlanState,
): RefreshResult {
  const confirmed = new Set<string>();
  const updated = new Map<string, RefreshUpdate>();
  const bandDrops: RefreshBandDrop[] = [];
  const outcomeRegressions: DreamOutcomeRegression[] = [];

  // Index evidence by slug.
  const bySlug = new Map<string, ApplyEvidenceEntry[]>();
  for (const e of evidence) {
    const arr = bySlug.get(e.pref_slug);
    if (arr) arr.push(e);
    else bySlug.set(e.pref_slug, [e]);
  }

  // Slugs that will retire this run — we skip refresh for those so the
  // retired/ snapshot reflects the pre-refresh counters (which is the
  // existing test expectation in moveToRetired).
  const retiringSlugs = new Set(plan.retires.map((r) => r.slug));

  for (const rec of scan.preferences) {
    const slug = rec.pref.id.startsWith("pref-") ? rec.pref.id.slice("pref-".length) : rec.pref.id;
    if (retiringSlugs.has(slug)) continue;

    const ev = bySlug.get(slug) ?? [];
    const applied = ev.filter((e) => e.result === BRAIN_APPLY_RESULT.applied).length;
    const violated = ev.filter((e) => e.result === BRAIN_APPLY_RESULT.violated).length;
    const outdatedCount = ev.filter((e) => e.result === BRAIN_APPLY_RESULT.outdated).length;
    const lastEvidence = ev.length > 0 ? ev[ev.length - 1]!.timestamp : null;
    const firstApplied = ev.find((e) => e.result === BRAIN_APPLY_RESULT.applied);

    // `outdated` is a context-driven retire signal: a single event
    // means the rule's scope still matches but the artifact shows
    // the rule itself is obsolete (framework migration, convention
    // change). Pin protects against decay-based retires but NOT
    // against context-driven ones — pinning means "I want this
    // rule"; an `outdated` event means "context says this rule no
    // longer applies anywhere." Honour the explicit signal.
    //
    // Idempotency: once retired, the pref moves to `retired/` and
    // future dream passes don't re-process it from `preferences/`.
    if (outdatedCount > 0) {
      plan.retires.push({
        slug,
        principle: rec.pref.principle,
        reason: BRAIN_RETIRED_REASON.supersededByContext,
      });
      continue;
    }

    let status = rec.pref.status;
    let confirmedAt = rec.pref.confirmed_at;
    if (status === BRAIN_PREFERENCE_STATUS.unconfirmed && firstApplied) {
      status = BRAIN_PREFERENCE_STATUS.confirmed;
      confirmedAt = firstApplied.timestamp;
      confirmed.add(slug);
    }

    // Quarantine transitions — only applicable to already-confirmed
    // and already-quarantined preferences. An unconfirmed pref still
    // promotes via the firstApplied branch above; quarantine entry is
    // measured against `confirmed` counts. Detailed semantics live on
    // `BRAIN_PREFERENCE_STATUS.quarantine` in `types.ts`.
    if (
      status === BRAIN_PREFERENCE_STATUS.confirmed &&
      violated >= applied &&
      applied > cfg.confidence.low_max_applied
    ) {
      status = BRAIN_PREFERENCE_STATUS.quarantine;
    } else if (status === BRAIN_PREFERENCE_STATUS.quarantine) {
      const newViolated = violated > rec.pref.violated_count;
      if (newViolated) {
        if (isPinned(rec.pref)) {
          plan.retainPinned.push({
            preference: renderPrefLink({
              id: rec.pref.id,
              principle: rec.pref.principle,
            }),
            reason: BRAIN_RETIRED_REASON.quarantineViolated,
          });
        } else {
          plan.retires.push({
            slug,
            principle: rec.pref.principle,
            reason: BRAIN_RETIRED_REASON.quarantineViolated,
          });
          // Skip refresh — moveToRetired will read the on-disk
          // counters when it builds the retired snapshot.
          continue;
        }
      } else if (applied > violated) {
        status = BRAIN_PREFERENCE_STATUS.confirmed;
      }
    }

    const baseConfidence = computeConfidence(applied, violated, lastEvidence, cfg, now);

    // Outcome regression (t_d478df53): applied events whose downstream
    // outcome was `failure` outnumbering `success` mean the rule looks
    // confirmed while actively hurting. The flag stages an explainable
    // finding and a multiplicative confidence penalty - retirement
    // still goes through the existing gates, never silently. The
    // penalty is a pure function of the evidence, so reruns converge.
    const appliedFailures = ev.filter(
      (e) => e.result === BRAIN_APPLY_RESULT.applied && e.outcome === "failure",
    ).length;
    const appliedSuccesses = ev.filter(
      (e) => e.result === BRAIN_APPLY_RESULT.applied && e.outcome === "success",
    ).length;
    const regressed =
      appliedFailures >= OUTCOME_REGRESSION_MIN_FAILURES && appliedFailures > appliedSuccesses;
    const confidence = regressed
      ? rebandConfidence(
          Math.round(baseConfidence.value * OUTCOME_REGRESSION_PENALTY * 10000) / 10000,
          cfg,
        )
      : baseConfidence;
    if (regressed) {
      outcomeRegressions.push({
        id: rec.pref.id,
        principle: rec.pref.principle,
        failures: appliedFailures,
        successes: appliedSuccesses,
      });
    }

    // Idempotency on a no-op rerun: skip refresh for prefs where
    // counters AND status are unchanged AND the on-disk body already
    // matches what we would render with current evidence. The second
    // half (body comparison) is what carries the v0.10.1 migration
    // forward — a pref whose counters are stable but whose body
    // still has the v0.9.x placeholder will fail the body check and
    // get rewritten on the next pass.
    const previousValue = rec.pref.confidence_value;
    // A `null` previous value (file not yet touched by dream) is
    // treated as "matches whatever we just computed" — the
    // body-bytes check in `wouldRewritePreference` is what triggers
    // the write that populates the field.
    const valueDifferent =
      previousValue !== null && Math.abs(previousValue - confidence.value) > 1e-6;
    const countersChanged =
      applied !== rec.pref.applied_count ||
      violated !== rec.pref.violated_count ||
      lastEvidence !== rec.pref.last_evidence_at ||
      status !== rec.pref.status ||
      confirmedAt !== rec.pref.confirmed_at ||
      confidence.band !== rec.pref.confidence ||
      valueDifferent;

    // Freshness trend (t_ee09a6ce): classified at PLAN time so the
    // no-op pre-flight below and the write loop render identical
    // bytes. The stamp is OPPORTUNISTIC: it lands when the pref is
    // being rewritten anyway (counters changed) or already carries
    // the field (then it refreshes on every consolidation pass, the
    // Hindsight contract). A never-stamped pref with unchanged
    // counters is left byte-identical so legacy vaults keep their
    // no-op dream guarantees.
    const stampTrend = countersChanged || rec.pref.freshness_trend !== undefined;
    let trendLabel: string | undefined;
    if (stampTrend) {
      const trendEv = collectEvidenceForSlug(vault, slug, {
        sinceIso: rec.pref.created_at,
        maxApplied: 1000,
        maxViolated: 1000,
      });
      trendLabel = classifyFreshnessTrend({
        createdAt: rec.pref.created_at,
        events: [...trendEv.applied, ...trendEv.violated].map((r) => ({
          at: r.timestamp,
          result: r.result,
        })),
        nowMs: now.getTime(),
      }).trend;
    }

    const prospective = {
      slug,
      topic: rec.pref.topic,
      ...(rec.pref.scope ? { scope: rec.pref.scope } : {}),
      principle: rec.pref.principle,
      created_at: rec.pref.created_at,
      unconfirmed_until: rec.pref.unconfirmed_until,
      status,
      evidenced_by: rec.pref.evidenced_by,
      confirmed_at: confirmedAt,
      applied_count: applied,
      violated_count: violated,
      last_evidence_at: lastEvidence,
      confidence: confidence.band,
      confidence_value: confidence.value,
      pinned: rec.pref.pinned,
      ...(trendLabel !== undefined ? { freshness_trend: trendLabel } : {}),
    };

    if (!countersChanged) {
      const ev2 = collectEvidenceForSlug(vault, slug, {
        sinceIso: rec.pref.created_at,
      });
      if (
        !wouldRewritePreference(vault, {
          ...prospective,
          recentApplied: ev2.applied,
          recentViolated: ev2.violated,
          // v0.12.0 Brain Integrity Suite: feed the existing
          // _revision and _content_hash into the pre-flight render
          // so the byte comparison matches the writePreferenceTxn
          // no-op semantic. Otherwise a refreshed pref written by a
          // prior pass (with _revision: N stamped) would look like
          // "needs rewrite" against a prospective render that omits
          // those fields, flipping changed=false runs into spurious
          // updates.
          // parsePreference defaults absent _revision to 0; treat 0
          // the same as "absent" for the pre-flight render so the
          // bytes-compare matches existing legacy starter files that
          // never had the field on disk.
          ...(rec.pref.revision !== undefined && rec.pref.revision > 0
            ? { revision: rec.pref.revision }
            : {}),
          ...(rec.pref.content_hash !== undefined ? { content_hash: rec.pref.content_hash } : {}),
        })
      ) {
        // Counters and body both unchanged — true no-op for this pref.
        continue;
      }
    }

    updated.set(slug, prospective);

    // Capture band drops for the digest. A drop is any transition
    // where the new band ranks lower than the previous (high →
    // medium, medium → low, high → low). Stable across re-runs as
    // long as the underlying counters do — the digest only renders
    // it when a real transition occurred in this pass.
    if (BAND_RANK[confidence.band] < BAND_RANK[rec.pref.confidence]) {
      bandDrops.push(
        Object.freeze({
          id: rec.pref.id,
          principle: rec.pref.principle,
          previous: rec.pref.confidence,
          next: confidence.band,
          applied,
          violated,
          previous_value: rec.pref.confidence_value,
          next_value: confidence.value,
        }),
      );
    }
  }

  return { confirmed, updated, bandDrops, outcomeRegressions };
}
