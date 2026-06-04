/**
 * Brain Integrity Suite (v0.12.0) - `brain_review_candidates`.
 *
 * Read-only projection over what the next `dream` invocation would
 * do. Calls `dream(vault, { dryRun: true })` and reshapes the
 * summary into a focused agent-facing report. No persistent state
 * is mutated; the underlying dry-run dream pass also skips the
 * workrun emission.
 *
 * The shape is intentionally narrow - just the fields an operator or
 * agent needs to decide "should I do anything before the dream pass
 * runs?". Callers that want the full DreamRunSummary should call
 * `brain_dream` with `dry_run: true` directly.
 */

import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import type { ResolvedSearchConfig } from "../search/types.ts";
import { dream } from "./dream.ts";
import type { BrainIntentReviewEntry } from "./intent-review.ts";
import { brainDirs } from "./paths.ts";
import { scoreSignalNovelty, sortByNovelty, type SignalNoveltyEntry } from "./surprisal.ts";
import { BRAIN_RETIRED_REASON, type BrainRetiredReason } from "./types.ts";

export interface ReviewCandidatesReport {
  /** `pref-<slug>` ids that the dream pass would create new. */
  readonly would_create: ReadonlyArray<string>;
  /** `pref-<slug>` ids transitioning unconfirmed -> confirmed. */
  readonly would_promote: ReadonlyArray<string>;
  /** Retire entries (id + reason). */
  readonly would_retire: ReadonlyArray<{
    readonly id: string;
    readonly reason: BrainRetiredReason;
  }>;
  /** Subset of `would_retire` whose reason is `superseded-by-context`. */
  readonly would_supersede: ReadonlyArray<{
    readonly id: string;
    readonly reason: BrainRetiredReason;
  }>;
  /**
   * Signal clusters held back by the self-approval guardrail. Mirror
   * of `DreamRunSummary.quarantined` plus a one-shot
   * `failed_gates` list.
   */
  readonly clusters_below_threshold: ReadonlyArray<{
    readonly topic: string;
    readonly signal_count: number;
    readonly distinct_agents: number;
    readonly age_days: number;
    readonly failed_gates: ReadonlyArray<string>;
  }>;
  /**
   * Retires the destructive-from-confirmed gate would skip. Mirror
   * of `DreamRunSummary.gated_retires`.
   */
  readonly gated_retires: ReadonlyArray<{
    readonly pref_id: string;
    readonly topic: string;
    readonly applied_count: number;
    readonly violated_count: number;
    readonly threshold: number;
    readonly attempted_reason: BrainRetiredReason;
  }>;
  /** Intent-review decisions for active signal clusters before main dream planning. */
  readonly intent_reviews: ReadonlyArray<BrainIntentReviewEntry>;
  /**
   * Surprisal annotation (t_fddfe64a): inbox signals ranked by
   * embedding-space novelty, highest first. Present ONLY when a
   * search config was provided AND at least one signal actually
   * scored - vec-less vaults keep the report byte-identical.
   */
  readonly signal_novelty?: ReadonlyArray<SignalNoveltyEntry>;
}

export interface BuildReviewCandidatesOptions {
  /** Wall clock for the underlying dream pass. */
  readonly now?: Date;
  /**
   * When provided, annotate the report with surprisal novelty over
   * the existing vec index (t_fddfe64a). Read-only; absent or
   * unembedded indexes leave the report unchanged.
   */
  readonly searchConfig?: ResolvedSearchConfig;
}

/** Active inbox signal files as (id, relPath) refs. */
function listInboxSignalRefs(vault: string): Array<{ id: string; relPath: string }> {
  const inbox = brainDirs(vault).inbox;
  if (!existsSync(inbox)) return [];
  const inboxRel = relative(vault, inbox);
  return readdirSync(inbox)
    .filter((n) => n.startsWith("sig-") && n.endsWith(".md"))
    .toSorted()
    .map((n) => ({ id: n.replace(/\.md$/, ""), relPath: join(inboxRel, n) }));
}

export async function buildReviewCandidates(
  vault: string,
  opts: BuildReviewCandidatesOptions = {},
): Promise<ReviewCandidatesReport> {
  const summary = dream(vault, {
    dryRun: true,
    ...(opts.now ? { now: opts.now } : {}),
  });

  let signalNovelty: ReadonlyArray<SignalNoveltyEntry> | undefined;
  if (opts.searchConfig !== undefined) {
    const refs = listInboxSignalRefs(vault);
    if (refs.length > 0) {
      const scored = await scoreSignalNovelty(opts.searchConfig, refs);
      if (scored.some((s) => s.novelty !== null)) {
        signalNovelty = sortByNovelty(scored);
      }
    }
  }

  return Object.freeze({
    ...(signalNovelty !== undefined ? { signal_novelty: signalNovelty } : {}),
    would_create: Object.freeze([...summary.new_unconfirmed]),
    would_promote: Object.freeze([...summary.confirmed]),
    would_retire: Object.freeze(
      summary.retired.map((r) => Object.freeze({ id: r.id, reason: r.reason })),
    ),
    would_supersede: Object.freeze(
      summary.retired
        .filter((r) => r.reason === BRAIN_RETIRED_REASON.supersededByContext)
        .map((r) => Object.freeze({ id: r.id, reason: r.reason })),
    ),
    clusters_below_threshold: Object.freeze(
      summary.quarantined.map((q) =>
        Object.freeze({
          topic: q.topic,
          signal_count: q.signal_count,
          distinct_agents: q.distinct_agents,
          age_days: q.age_days,
          failed_gates: Object.freeze([...q.failed_gates]),
        }),
      ),
    ),
    gated_retires: Object.freeze(
      summary.gated_retires.map((g) =>
        Object.freeze({
          pref_id: g.pref_id,
          topic: g.topic,
          applied_count: g.applied_count,
          violated_count: g.violated_count,
          threshold: g.threshold,
          attempted_reason: g.attempted_reason,
        }),
      ),
    ),
    intent_reviews: Object.freeze(
      summary.intent_reviews.map((review) => Object.freeze({ ...review })),
    ),
  } satisfies ReviewCandidatesReport);
}
