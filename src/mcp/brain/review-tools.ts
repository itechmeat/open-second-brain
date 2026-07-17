/**
 * Lifecycle review: pre-dream intent review, retention lifecycle, dream dry-run preview, and staleness scan.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { resolveSearchConfig } from "../../core/search/index.ts";
import { buildTimelineIndex } from "../../core/brain/temporal/build-index.ts";
import { findStaleEntries } from "../../core/brain/temporal/stale-watch.ts";
import { loadTemporalConfigSafe } from "../../core/brain/policy.ts";
import { buildIntentReview } from "../../core/brain/intent-review.ts";
import { buildRetentionReview } from "../../core/brain/retention.ts";
import { buildReviewCandidates } from "../../core/brain/review-candidates.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { coerceIsoDate } from "../coerce.ts";

async function toolBrainIntentReview(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const nowDate = coerceIsoDate(args, "now");
  const report = buildIntentReview(ctx.vault, nowDate ? { now: nowDate } : {});
  return {
    schema_version: report.schema_version,
    generated_at: report.generated_at,
    reviews: report.reviews.map((review) => ({
      topic: review.topic,
      decision: review.decision,
      signal_count: review.signal_count,
      risk_band: review.risk_band,
      risk_score: review.risk_score,
      reasons: [...review.reasons],
    })),
  };
}

async function toolBrainRetention(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const nowDate = coerceIsoDate(args, "now");
  const report = buildRetentionReview(ctx.vault, nowDate ? { now: nowDate } : {});
  return {
    schema_version: report.schema_version,
    generated_at: report.generated_at,
    summary: report.summary,
    recommendations: report.recommendations.map((recommendation) => ({
      id: recommendation.id,
      artifact_type: recommendation.artifact_type,
      action: recommendation.action,
      reason: recommendation.reason,
      path: recommendation.path,
    })),
  };
}

async function toolBrainReviewCandidates(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const nowDate = coerceIsoDate(args, "now");
  // Surprisal annotation (t_fddfe64a) is best-effort: a resolvable
  // search config adds novelty ranking, anything else degrades to the
  // plain report.
  let searchConfig: ReturnType<typeof resolveSearchConfig> | undefined;
  try {
    searchConfig = resolveSearchConfig({
      vault: ctx.vault,
      configPath: ctx.configPath ?? undefined,
    });
  } catch {
    searchConfig = undefined;
  }
  const report = await buildReviewCandidates(ctx.vault, {
    ...(nowDate ? { now: nowDate } : {}),
    ...(searchConfig !== undefined ? { searchConfig } : {}),
  });
  return {
    ...(report.signal_novelty !== undefined ? { signal_novelty: report.signal_novelty } : {}),
    would_create: [...report.would_create],
    would_promote: [...report.would_promote],
    would_retire: report.would_retire.map((r) => ({
      id: r.id,
      reason: r.reason,
    })),
    would_supersede: report.would_supersede.map((r) => ({
      id: r.id,
      reason: r.reason,
    })),
    clusters_below_threshold: report.clusters_below_threshold.map((c) => ({
      topic: c.topic,
      signal_count: c.signal_count,
      distinct_agents: c.distinct_agents,
      age_days: c.age_days,
      failed_gates: [...c.failed_gates],
    })),
    gated_retires: report.gated_retires.map((g) => ({
      pref_id: g.pref_id,
      topic: g.topic,
      applied_count: g.applied_count,
      violated_count: g.violated_count,
      threshold: g.threshold,
      attempted_reason: g.attempted_reason,
    })),
    intent_reviews: report.intent_reviews.map((review) => ({
      topic: review.topic,
      decision: review.decision,
      signal_count: review.signal_count,
      risk_band: review.risk_band,
      risk_score: review.risk_score,
      reasons: [...review.reasons],
    })),
  };
}

// ----- brain_apply_evidence ------------------------------------------------

/**
 * `brain_stale_scan` - structural staleness report for preferences,
 * signals, and log files. Thresholds come from the `temporal:` config
 * block.
 */
async function toolBrainStaleScan(
  ctx: ServerContext,
  _args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  void _args;
  const cfg = loadTemporalConfigSafe(ctx.vault);
  const index = buildTimelineIndex(ctx.vault, {});
  const report = findStaleEntries(index, ctx.vault, cfg);
  return {
    vault_path: ctx.vault,
    thresholds: report.thresholds,
    stale_preferences: report.stalePreferences,
    stale_signals: report.staleSignals,
    stale_log_files: report.staleLogFiles,
    generated_at: report.generatedAt,
  };
}

export const REVIEW_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_intent_review",
    description:
      "Read-only pre-dream intent review over active signal clusters. Returns each topic's decision, signal count, risk band, risk score, and reasons without mutating files.",
    inputSchema: {
      type: "object",
      properties: {
        now: {
          type: "string",
          description:
            "Optional ISO-8601 timestamp used as the wall clock for the review (testing / replay).",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainIntentReview,
  },
  {
    name: "brain_retention",
    description:
      "Recommendation-only lifecycle review over retired preferences and processed signals. Returns keep/improve/park/prune candidates and never deletes or moves artifacts.",
    inputSchema: {
      type: "object",
      properties: {
        now: {
          type: "string",
          description:
            "Optional ISO-8601 timestamp used as the wall clock for the review (testing / replay).",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainRetention,
  },
  {
    name: "brain_review_candidates",
    description:
      "Read-only preview of the next `brain_dream` pass: would_create / would_promote / would_retire / would_supersede, clusters below threshold, gated retires, and intent reviews. Mutates nothing.",
    inputSchema: {
      type: "object",
      properties: {
        now: {
          type: "string",
          description:
            "Optional ISO-8601 timestamp used as the wall clock for the dry-run (testing / replay).",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainReviewCandidates,
  },
  {
    name: "brain_stale_scan",
    description:
      "Structural staleness report: preferences, signals, and Brain/log files inactive longer than the configured `temporal:` thresholds (stale_pref_days / stale_signal_days / stale_log_days). Read-only.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: toolBrainStaleScan,
  },
]);
