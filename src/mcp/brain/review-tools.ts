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
import { gatedOwnerScopeView } from "../../core/brain/owner-scope-view.ts";
import { brainArtifactSlug } from "../../core/brain/wikilink.ts";
import { OPERATION } from "../../core/brain/safeguard.ts";
import type { ProgressSink } from "../../core/brain/progress.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { vaultPathField } from "../vault-path-field.ts";
import { coerceIsoDate } from "../coerce.ts";
import { toolSafeguard } from "./shared.ts";

async function toolBrainIntentReview(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const nowDate = coerceIsoDate(args, "now");
  const report = buildIntentReview(ctx.vault, nowDate ? { now: nowDate } : {});
  // Deliberately unfiltered, and the reason is on the record rather than
  // implied by silence (a-label-is-not-a-boundary, U3). Every row here is
  // a fold over INBOX SIGNAL clusters - a topic, a decision, a count -
  // and a signal carries no `owner:` anywhere in this product, so there
  // is no ownership claim on disk for this surface to read. A filter
  // keyed on "does a preference of this topic exist and may you see it"
  // would withhold a row whose whole content came from artifacts the
  // caller is entitled to, which is a narrowing nobody asked for.
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
  // Each recommendation names a retired preference or a processed signal
  // by id and by vault-relative path (a-label-is-not-a-boundary, U3).
  const view = gatedOwnerScopeView(ctx.vault, ctx.agentName);
  return {
    schema_version: report.schema_version,
    generated_at: report.generated_at,
    summary: report.summary,
    recommendations: view
      .keep(report.recommendations, (r) => [r.path, r.id])
      .map((recommendation) => ({
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
  onProgress?: ProgressSink,
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
    // The projection is read-only, but it runs a full dry-run
    // consolidation pass to produce it - the same pass, and so the same
    // budget, as `brain_dream`.
    safeguard: toolSafeguard(ctx, OPERATION.dream),
    ...(onProgress ? { onProgress } : {}),
    ...(nowDate ? { now: nowDate } : {}),
    ...(searchConfig !== undefined ? { searchConfig } : {}),
  });
  // The projected rows name preferences that EXIST by the id they would
  // get after the pass, so `ret-<slug>` is resolved back through the
  // shared slug fold and both spellings are asked about
  // (a-label-is-not-a-boundary, U3).
  const view = gatedOwnerScopeView(ctx.vault, ctx.agentName);
  const bothSpellings = (id: string): ReadonlyArray<string> => {
    const slug = brainArtifactSlug(id);
    return [`pref-${slug}`, `ret-${slug}`];
  };
  // `clusters_below_threshold` and `intent_reviews` stay unfiltered, for
  // the reason `brain_intent_review` states above: both are keyed by a
  // topic over inbox signals, and signals carry no owner.
  return {
    // Signal rows name an inbox signal by id AND by vault-relative path.
    ...(report.signal_novelty !== undefined
      ? { signal_novelty: view.keep(report.signal_novelty, (s) => [s.path, s.id]) }
      : {}),
    // `would_create` names ids the pass has not written yet, so most of
    // them resolve to nothing and pass; asking anyway is what keeps a
    // projection over an id that DOES already exist from crossing.
    would_create: view.keep(report.would_create, (id) => bothSpellings(id)),
    // `would_promote` is the one that always names live pages: an
    // unconfirmed preference on disk, transitioning to confirmed.
    would_promote: view.keep(report.would_promote, (id) => bothSpellings(id)),
    would_retire: view
      .keep(report.would_retire, (r) => bothSpellings(r.id))
      .map((r) => ({
        id: r.id,
        reason: r.reason,
      })),
    would_supersede: view
      .keep(report.would_supersede, (r) => bothSpellings(r.id))
      .map((r) => ({
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
    gated_retires: view
      .keep(report.gated_retires, (g) => bothSpellings(g.pref_id))
      .map((g) => ({
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
  // Every stale row names its artifact by id, topic and vault-relative
  // path (a-label-is-not-a-boundary, U3). Log shards are named by date
  // and shared by construction, so they carry no ownership to read.
  const view = gatedOwnerScopeView(ctx.vault, ctx.agentName);
  return {
    vault_path: vaultPathField(ctx),
    thresholds: report.thresholds,
    stale_preferences: view.keep(report.stalePreferences, (r) => [r.path, r.prefId]),
    stale_signals: view.keep(report.staleSignals, (r) => [r.path, r.signalId]),
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
