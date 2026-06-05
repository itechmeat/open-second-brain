/**
 * MCP tool registrations for the Brain layer.
 *
 * Exposes the Brain operations that are safe to invoke from an agent
 * harness:
 *
 *   - `brain_feedback`        — record a single taste signal (or a
 *                                directly-confirmed preference when
 *                                `force_confirmed: true`).
 *   - `brain_dream`           — run the deterministic learning pass.
 *   - `brain_apply_evidence`  — record whether a preference was applied
 *                                or violated on a freshly-produced
 *                                artifact.
 *   - `brain_digest`          — render a human-readable summary of the
 *                                last activity window.
 *   - `brain_query`           — read-only aggregation by preference id,
 *                                topic, or time window.
 *   - `brain_agent_query`     — read-only aggregation by source agent.
 *   - `brain_agent_diff`      — read-only comparison between source agents.
 *   - `brain_doctor`          — invariant / schema health check.
 *   - `brain_backlinks`       — read-only inbound reference lookup.
 *   - `brain_pinned_context`  — current-task scratchpad read/write/clear.
 *   - `brain_context`         — pull-bootstrap of `Brain/active.md`.
 *
 * The five Brain commands that remain CLI-only on purpose
 * (`init`, `reject`, `pin`, `unpin`, `rollback`) deliberately do *not*
 * have MCP wrappers — see design doc §9.1 "absence from MCP protects
 * against autonomous mistakes". Their handler functions live in
 * `src/core/brain/*` and `src/cli/*` for shell-side use.
 *
 * Each handler delegates to the corresponding `src/core/brain/*`
 * function so the contract stays byte-identical to the CLI. Arguments
 * are coerced/validated locally with the same helpers the legacy tools
 * use; we re-implement the small ones here rather than re-exporting
 * private functions from `tools.ts` to keep the dependency direction
 * one-way (Brain tools may grow their own coercion rules later).
 */

import { isAbsolute, join, relative, resolve } from "node:path";

import { existsSync, readFileSync } from "node:fs";

import {
  resolveAgentName,
  resolveLinkOutputFormat,
  resolveSearchFocusContextPack,
  resolveTriggerCooldownDays,
} from "../core/config.ts";
import { indexVault, resolveSearchConfig } from "../core/search/index.ts";
import { Store } from "../core/search/store.ts";
import {
  assignNoteLabel,
  LabelVocabularyError,
  readLabels,
  removeNoteLabel,
} from "../core/brain/labels.ts";
import { loadSchemaPack } from "../core/brain/schema-pack.ts";
import { listSecrets } from "../core/brain/secrets/store.ts";
import { runWithSecret, SecretExecDeniedError } from "../core/brain/secrets/exec.ts";
import { currentLease } from "../core/brain/maintenance/lease.ts";
import { listJournal } from "../core/brain/maintenance/journal.ts";
import { runMaintenance, type DailyWindow } from "../core/brain/maintenance/lane.ts";
import { writeFrontmatterAtomic } from "../core/vault.ts";
import type { FrontmatterMap } from "../core/types.ts";
import { readActiveSessionFocus } from "../core/search/session-focus.ts";
import { brainActivePath, brainDirs } from "../core/brain/paths.ts";
import { regenerateActive, type RegenerateActiveResult } from "../core/brain/active.ts";
import { parseFrontmatter } from "../core/vault.ts";
import {
  appendApplyEvidence,
  BrainPreferenceNotFoundError,
  type AppendApplyEvidenceInput,
} from "../core/brain/apply-evidence.ts";
import { buildBacklinkIndex } from "../core/brain/backlinks.ts";
import { EntityAmbiguityError, getEntity, listEntities } from "../core/brain/entities/registry.ts";
import { validateEntityCategory } from "../core/brain/entities/canonical.ts";
import { readPrefAudit } from "../core/brain/pref-audit.ts";
import { buildMorningBrief } from "../core/brain/morning-brief.ts";
import { deliverBriefTriggers, renderTriggerBriefSection } from "../core/brain/triggers/brief.ts";
import { scanTriggers } from "../core/brain/triggers/scan.ts";
import { createTriggers, listTriggers, transitionTrigger } from "../core/brain/triggers/store.ts";
import { deepSynthesis, synthesisCandidates } from "../core/brain/deep-synthesis.ts";
import { discoverIdeas, ideaCandidates } from "../core/brain/idea-discovery.ts";
import { listGateTelemetry, summarizeGateTelemetry } from "../core/brain/gate-telemetry.ts";
import { isTriggerStatus, type TriggerRecord } from "../core/brain/triggers/types.ts";
import { aggregateSources } from "../core/brain/portability/sources.ts";
import { switchProfile, listProfiles } from "../core/brain/portability/profiles.ts";
import { defaultConfigPath } from "../core/config.ts";
import { findUnlinkedMentions } from "../core/brain/link-graph/unlinked-mentions.ts";
import { buildConceptCluster } from "../core/brain/link-graph/concept-cluster.ts";
import { auditMoc, MocAuditError } from "../core/brain/link-graph/moc-audit.ts";
import { readVaultInstructionFile } from "../core/brain/vault-instruction-file.ts";
import { buildTimelineIndex } from "../core/brain/temporal/build-index.ts";
import { selectEvents } from "../core/brain/temporal/select-events.ts";
import { buildBeliefEvolution } from "../core/brain/temporal/belief-evolution.ts";
import { findStaleEntries } from "../core/brain/temporal/stale-watch.ts";
import { buildDailyBrief } from "../core/brain/temporal/daily-brief.ts";
import { buildWeeklySynthesis } from "../core/brain/temporal/weekly-brief.ts";
import { loadTemporalConfigSafe } from "../core/brain/policy.ts";
import { isBrainLogEventKind, type BrainLogEventKind } from "../core/brain/types.ts";
import { packContext } from "../core/brain/context-pack.ts";
import {
  listIntentions,
  moveIntentionToHistory,
  setIntention,
  showIntention,
} from "../core/brain/intentions.ts";
import { buildPreCompressPack } from "../core/brain/pre-compress-pack.ts";
import {
  getContextReceipt,
  isContextReceiptTrigger,
  listContextReceipts,
  summarizeContextReceipt,
  type ContextReceiptOptions,
} from "../core/brain/context-receipts.ts";
import {
  isRecallTelemetryMode,
  isRecallTelemetryStatus,
  listRecallTelemetry,
  summarizeRecallTelemetry,
  type RecallTelemetryFilter,
  type RecallTelemetryMode,
  type RecallTelemetryOptions,
  type RecallTelemetryStatus,
} from "../core/brain/recall-telemetry.ts";
import {
  diffContextPreset,
  getContextPreset,
  listContextPresets,
  suggestContextPreset,
  type ContextPresetCurrentConfig,
} from "../core/brain/context-presets.ts";
import { extractPreCompactRecords } from "../core/brain/pre-compact-extract.ts";
import {
  describeSessionRecall,
  expandSessionRecall,
  searchSessionRecall,
} from "../core/brain/session-recall.ts";
import {
  acceptSkillProposal,
  learnSkillProposals,
  listPendingSkillProposals,
  rejectSkillProposal,
} from "../core/brain/skill-proposals.ts";
import {
  listProceduralMemory,
  markProceduralMemoryUsed,
  reconcileProceduralMemory,
} from "../core/brain/procedural-memory.ts";
import { readProceduralGraph, rebuildProceduralGraph } from "../core/brain/procedural-graph.ts";
import { readProceduralHints, rebuildProceduralHints } from "../core/brain/procedural-hints.ts";
import {
  applyRecurrenceEvidence,
  getRecurrenceEntry,
  listRecurrenceEntries,
  purgeRecurrenceSource,
} from "../core/brain/recurrence.ts";
import {
  evaluateAttentionFlow,
  listAttentionFlows,
  renderAttentionFlow,
} from "../core/brain/attention-flows.ts";
import { collectMaintenanceActions } from "../core/brain/maintenance/collect.ts";
import { normaliseWikilinkTarget } from "../core/brain/wikilink.ts";
import { renderDigest, type DigestFormat } from "../core/brain/digest.ts";
import { dream } from "../core/brain/dream.ts";
import { buildIntentReview } from "../core/brain/intent-review.ts";
import { buildRetentionReview } from "../core/brain/retention.ts";
import { buildMonthlyReview, normalizeMonthlyReviewMonth } from "../core/brain/monthly-review.ts";
import { buildReviewCandidates } from "../core/brain/review-candidates.ts";
import { runDoctor } from "../core/brain/doctor.ts";
import { buildOperatorSummary } from "../core/brain/trust/operator-summary.ts";
import { BRAIN_ROLES } from "../core/brain/trust/role.ts";
import {
  BrainNotFoundError,
  queryByLogSince,
  queryByPreference,
  queryByTopic,
} from "../core/brain/query.ts";
import { diffAgentSources, type AgentSourceDiffMode } from "../core/brain/agent-source/diff.ts";
import { queryAgentSources } from "../core/brain/agent-source/query.ts";
import type { AgentSourceContributionKind } from "../core/brain/agent-source/types.ts";
import { writeSignal } from "../core/brain/signal.ts";
import { writePreference } from "../core/brain/preference.ts";
import { validateBrainFeedbackInput } from "../core/brain/sessions/validate-feedback.ts";
import { isoDate, isoSecond } from "../core/brain/time.ts";
import { slugify } from "../core/vault.ts";
import { normalizeAgentArgument } from "../core/agent-identity.ts";
import {
  BRAIN_LOG_EVENT_KIND,
  BRAIN_PREFERENCE_STATUS,
  BRAIN_APPLY_RESULT,
  type BrainApplyResult,
  type BrainPreference,
  type BrainRetired,
  type BrainSignal,
  type BrainSignalSign,
} from "../core/brain/types.ts";
import { normalizeEntityName } from "../core/brain/entities/canonical.ts";
import { listDeadEnds, recordDeadEnd } from "../core/brain/dead-ends.ts";
import { buildForesight, FORESIGHT_HORIZON_DAYS } from "../core/brain/temporal/foresight.ts";
import { aggregateQuantities } from "../core/brain/truth/aggregate.ts";
import { detectAgentCollisions } from "../core/brain/truth/collision.ts";
import { computeTruthStateWithConflicts } from "../core/brain/truth/conflicts.ts";
import { appendClaimEvent, readClaimEvents } from "../core/brain/truth/store.ts";
import { appendLogEvent } from "../core/brain/log.ts";
import type { BrainLogEntry } from "../core/brain/log.ts";
import { appendBrainNote } from "../core/brain/note.ts";
import { mirrorSignal, resolveSharedNamespace } from "../core/brain/shared-namespace.ts";
import {
  WriteSessionRequestError,
  abandonSession,
  approveSession,
  openArtifactSession,
  sessionEnvelope,
} from "../core/brain/write-session/engine.ts";
import { dispatchSubmit, openPanelSession } from "../core/brain/write-session/panel.ts";
import { listWriteSessions, readWriteSession } from "../core/brain/write-session/store.ts";
import type { WriteSessionEnvelope } from "../core/brain/write-session/types.ts";
import { buildMcpLandscape } from "../core/graph/mcp-config.ts";
import {
  appendPinnedContext,
  clearPinnedContext,
  readPinnedContext,
  writePinnedContext,
  type PinnedContext,
} from "../core/brain/pinned.ts";

import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "./protocol.ts";
import { deprecatedAlias, type ServerContext, type ToolDefinition } from "./tools.ts";
import { MCP_PREVIEW_BUDGET } from "./preview-budget.ts";
import {
  coerceStr,
  coerceStrList,
  coerceBool,
  coerceBoolOptional,
  coerceIsoDate,
  coerceFormat,
  coerceInt,
  coerceStringOptional,
} from "./coerce.ts";
import { emitGatedTelemetry } from "../core/brain/continuity/emit.ts";
import { emitRecallTelemetry } from "../core/brain/recall-telemetry.ts";

// ----- brain_feedback ------------------------------------------------------

/**
 * Build the slug used in the signal / preference filename. We never let
 * the agent decide the slug directly — taking `topic` as the slug stem
 * is what the design doc §9.2 prescribes (slugs are deterministic from
 * topic). The slug is run through `slugify` defensively so a slightly
 * mis-shaped topic still yields a filesystem-safe basename.
 */
function deriveSlug(topic: string): string {
  return slugify(topic);
}

async function toolBrainFeedback(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Single source of truth for the brain_feedback payload contract —
  // session-replay (sessions/import.ts) and the MCP live path now go
  // through the same validator so rule shape cannot drift between the
  // two surfaces.
  const validated = validateBrainFeedbackInput(args);
  if (!validated.ok) {
    throw new MCPError(INVALID_PARAMS, validated.reason);
  }
  const {
    topic,
    signal: signalRaw,
    principle,
    scope,
    raw,
    source,
    force_confirmed,
  } = validated.value;
  const forceConfirmed = force_confirmed ?? false;

  // Agent-fallback stays MCP-side: validator just hands back the user-
  // supplied value (or undefined); the live path resolves via config
  // when absent.
  const agent =
    normalizeAgentArgument(validated.value.agent ?? null) ??
    resolveAgentName(ctx.configPath ?? undefined);
  const now = new Date();
  const date = isoDate(now);
  const createdAt = isoSecond(now);
  const slug = deriveSlug(topic);

  // 1. Always write the signal to inbox/. Mirrors the CLI handler so the
  //    audit trail in `Brain/log/` and `inbox/processed/` stays consistent
  //    across CLI and MCP entry points. `--force-confirmed` ADDITIONALLY
  //    creates a confirmed pref below.
  const signalInput = {
    topic,
    signal: signalRaw as BrainSignalSign,
    agent,
    principle,
    created_at: createdAt,
    date,
    slug,
    ...(scope ? { scope } : {}),
    ...(source && source.length > 0 ? { source: [...source] } : {}),
    ...(raw ? { raw } : {}),
  };
  const sigResult = writeSignal(ctx.vault, signalInput);
  // t_936a1a61: fail-soft mirror into the shared namespace AFTER the
  // primary write; `mirror` is reported only when the key is configured.
  const sharedNamespace = resolveSharedNamespace(ctx.configPath);
  const mirror =
    sharedNamespace === null ? undefined : mirrorSignal(sharedNamespace, ctx.vault, signalInput);

  try {
    appendLogEvent(ctx.vault, {
      timestamp: createdAt,
      eventType: BRAIN_LOG_EVENT_KIND.feedback,
      body: {
        signal: `[[${sigResult.id}]]`,
        topic: topic.trim(),
        sign: signalRaw,
        agent,
      },
    });
  } catch (err) {
    process.stderr.write(`warning: append feedback log failed: ${(err as Error).message}\n`);
  }

  let prefResult: { path: string; id: string } | null = null;
  if (forceConfirmed) {
    // Escape hatch: skip the dream pass and create the confirmed rule now.
    // `confirmed_at` is now; `unconfirmed_until` is also now so the trial
    // window collapses on inspection. The just-written signal is recorded
    // as the rule's origin under `evidenced_by`.
    prefResult = writePreference(ctx.vault, {
      slug,
      topic: topic.trim(),
      principle: principle.trim(),
      created_at: createdAt,
      unconfirmed_until: createdAt,
      status: BRAIN_PREFERENCE_STATUS.confirmed,
      evidenced_by: [`[[${sigResult.id}]]`],
      confirmed_at: createdAt,
      ...(scope ? { scope } : {}),
    });
    try {
      // Offset by 1s so the force-confirmed event sorts after the feedback
      // event on the same UTC second (parseLogDay is stable on ties, but a
      // visible chronology reads cleaner).
      appendLogEvent(ctx.vault, {
        timestamp: isoSecond(new Date(now.getTime() + 1000)),
        eventType: BRAIN_LOG_EVENT_KIND.forceConfirmed,
        body: {
          preference: `[[${prefResult.id}]]`,
          agent,
        },
      });
    } catch (err) {
      process.stderr.write(
        `warning: append force-confirmed log failed: ${(err as Error).message}\n`,
      );
    }
  }

  return {
    kind: prefResult ? "preference" : "signal",
    ...(mirror !== undefined ? { mirror } : {}),
    signal_path: vaultRelativeSafe(ctx.vault, sigResult.path),
    signal_absolute_path: resolve(sigResult.path),
    signal_id: sigResult.id,
    ...(prefResult
      ? {
          preference_path: vaultRelativeSafe(ctx.vault, prefResult.path),
          preference_absolute_path: resolve(prefResult.path),
          preference_id: prefResult.id,
          // Back-compat: top-level `path`/`id` previously pointed at the
          // pref on the force-confirmed branch. Keep them aligned for
          // callers that look at the bare fields.
          path: vaultRelativeSafe(ctx.vault, prefResult.path),
          absolute_path: resolve(prefResult.path),
          id: prefResult.id,
        }
      : {
          path: vaultRelativeSafe(ctx.vault, sigResult.path),
          absolute_path: resolve(sigResult.path),
          id: sigResult.id,
        }),
    agent,
  };
}

// ----- brain_dream ---------------------------------------------------------

async function toolBrainDream(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const dryRun = coerceBool(args, "dry_run");
  const nowDate = coerceIsoDate(args, "now");
  const agentArg = coerceStr(args, "agent", false);
  const agent = normalizeAgentArgument(agentArg) ?? resolveAgentName(ctx.configPath ?? undefined);

  const summary = dream(ctx.vault, {
    dryRun,
    ...(nowDate ? { now: nowDate } : {}),
    ...(agent ? { agentName: agent } : {}),
  });

  // The summary is already a Plain Old Frozen Object — JSON-serialise
  // verbatim. We surface `snapshot_path` / `log_path` as vault-relative
  // for caller convenience while preserving the absolute path as well.
  return {
    run_id: summary.run_id,
    changed: summary.changed,
    dry_run: dryRun,
    new_unconfirmed: [...summary.new_unconfirmed],
    confirmed: [...summary.confirmed],
    retired: summary.retired.map((r) => ({ id: r.id, reason: r.reason })),
    contradictions: [...summary.contradictions],
    moved_to_processed: [...summary.moved_to_processed],
    suppressed: [...summary.suppressed],
    warnings: summary.warnings.map((w) => ({
      code: w.code,
      message: w.message,
    })),
    uncertain: summary.uncertain.map((u) => ({
      code: u.code,
      ...(u.topic !== undefined ? { topic: u.topic } : {}),
      message: u.message,
    })),
    quarantined: summary.quarantined.map((q) => ({
      topic: q.topic,
      signal_count: q.signal_count,
      distinct_agents: q.distinct_agents,
      age_days: q.age_days,
      failed_gates: [...q.failed_gates],
    })),
    snapshot_path: summary.snapshot_path
      ? vaultRelativeSafe(ctx.vault, summary.snapshot_path)
      : null,
    log_path: summary.log_path ? vaultRelativeSafe(ctx.vault, summary.log_path) : null,
  };
}

// ----- brain_review_candidates --------------------------------------------

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

async function toolBrainMonthlyReview(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const monthRaw = args["month"];
  let month: string | undefined;
  if (monthRaw !== undefined && monthRaw !== null) {
    if (typeof monthRaw !== "string") {
      throw new MCPError(INVALID_PARAMS, "brain_monthly_review: month must be YYYY-MM");
    }
    try {
      month = normalizeMonthlyReviewMonth(monthRaw);
    } catch {
      throw new MCPError(INVALID_PARAMS, "brain_monthly_review: month must be YYYY-MM");
    }
  }
  const report = buildMonthlyReview(ctx.vault, month ? { month } : {});
  return {
    schema_version: report.schema_version,
    generated_at: report.generated_at,
    month: report.month,
    window: report.window,
    summary: report.summary,
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

async function toolBrainApplyEvidence(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const prefId = coerceStr(args, "pref_id", true)!;
  const artifact = coerceStr(args, "artifact", true)!;
  const resultRaw = coerceStr(args, "result", true)!;
  if (
    resultRaw !== BRAIN_APPLY_RESULT.applied &&
    resultRaw !== BRAIN_APPLY_RESULT.violated &&
    resultRaw !== BRAIN_APPLY_RESULT.outdated
  ) {
    throw new MCPError(
      INVALID_PARAMS,
      `argument 'result' must be 'applied', 'violated', or 'outdated'`,
    );
  }
  const agentArg = coerceStr(args, "agent", false);
  const note = coerceStr(args, "note", false);
  const outcomeRaw = coerceStr(args, "outcome", false);
  if (
    outcomeRaw !== null &&
    outcomeRaw !== "success" &&
    outcomeRaw !== "failure" &&
    outcomeRaw !== "unknown"
  ) {
    throw new MCPError(
      INVALID_PARAMS,
      `argument 'outcome' must be 'success', 'failure', or 'unknown'`,
    );
  }

  const agent = normalizeAgentArgument(agentArg) ?? resolveAgentName(ctx.configPath ?? undefined);

  const input: AppendApplyEvidenceInput = {
    pref_id: prefId,
    artifact,
    result: resultRaw as BrainApplyResult,
    agent,
    ...(outcomeRaw !== null ? { outcome: outcomeRaw } : {}),
    ...(note ? { note } : {}),
  };

  // Surface BrainPreferenceNotFoundError as a tool-level error envelope
  // (isError: true) rather than an MCP protocol error. The design doc
  // says "not an error condition" — the agent should see an informative
  // payload that explains what to do next, not a JSON-RPC error frame.
  // v0.10.16: assert applier role at the MCP boundary so the structural
  // permission gate fires before any I/O.
  try {
    const res = appendApplyEvidence(ctx.vault, input, {
      role: BRAIN_ROLES.applier,
    });
    return {
      logged_at: res.logged_at,
      log_path: vaultRelativeSafe(ctx.vault, res.log_path),
      absolute_log_path: resolve(res.log_path),
      agent,
    };
  } catch (exc) {
    if (exc instanceof BrainPreferenceNotFoundError) {
      // Re-throw as a non-MCPError so `server.handleToolsCall` packs it
      // into a `toolError` envelope (isError: true, single-text content).
      // This matches the pay-memory "pending request not found" pattern.
      throw new Error(exc.message, { cause: exc });
    }
    throw exc;
  }
}

// ----- brain_note (§32B, v0.10.8) ------------------------------------------

/**
 * Append one narrative-milestone line to today's Brain log. Agents
 * record release / merged-PR / discovered-fact lines under the `note`
 * event kind in `Brain/log/<today>.md` (and the JSONL sidecar).
 *
 * The body lives in `appendBrainNote` so the CLI verb (`o2b brain
 * note`) and this MCP handler share one code path. Validation errors
 * land in MCP's `INVALID_PARAMS` envelope here; the CLI wrapper
 * pre-validates usage shape and surfaces the same condition as exit 2.
 */
async function toolBrainNote(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rawText = coerceStr(args, "text", true)!;
  const agentArg = coerceStr(args, "agent", false);

  let res;
  try {
    res = appendBrainNote({
      vault: ctx.vault,
      text: rawText,
      ...(agentArg ? { agent: agentArg } : {}),
      ...(ctx.configPath ? { configPath: ctx.configPath } : {}),
    });
  } catch (err) {
    // `appendBrainNote` throws one validation error ("text is required");
    // any other failure is an I/O / filesystem fault from `appendLogEvent`
    // and must not be reported as a client-side INVALID_PARAMS.
    const message = (err as Error).message ?? String(err);
    const code = message.startsWith("brain_note:") ? INVALID_PARAMS : INTERNAL_ERROR;
    throw new MCPError(code, message);
  }
  return {
    logged_at: res.logged_at,
    log_path: res.log_path,
    absolute_log_path: res.absolute_log_path,
    agent: res.agent,
  };
}

// ----- brain_write_session (Agent Write Contract Suite, v0.41.0) ------------

/**
 * One agent-facing surface for the write-session kernel: `op`
 * discriminates the lifecycle operation, `kind` (open only) picks
 * artifact vs panel. Envelopes are the same JSON the CLI prints -
 * status, step, prompt, errors, attempts_left, expires_at, target.
 * Structured request failures surface as INVALID_PARAMS with the
 * machine-readable error list in the message.
 */
async function toolBrainWriteSession(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const op = coerceStr(args, "op", true)!;
  const sessionId = coerceStr(args, "session_id", false);
  const requireSessionId = (): string => {
    if (!sessionId) {
      throw new MCPError(INVALID_PARAMS, `brain_write_session: op '${op}' requires session_id`);
    }
    return sessionId;
  };
  try {
    switch (op) {
      case "open": {
        const kind = coerceStr(args, "kind", false) ?? "artifact";
        const agent =
          normalizeAgentArgument(coerceStr(args, "agent", false) ?? null) ??
          resolveAgentName(ctx.configPath ?? undefined);
        const requireReview = args["require_review"] === true;
        if (kind === "panel") {
          const topic = coerceStr(args, "topic", true)!;
          const personasRaw = args["personas"];
          const personas = Array.isArray(personasRaw)
            ? personasRaw.filter((x): x is string => typeof x === "string")
            : undefined;
          const target = coerceStr(args, "target", false);
          return asRecord(
            openPanelSession(ctx.vault, {
              agent,
              topic,
              requireReview,
              ...(personas && personas.length > 0 ? { personas } : {}),
              ...(target ? { targetPath: target } : {}),
            }),
          );
        }
        if (kind !== "artifact") {
          throw new MCPError(
            INVALID_PARAMS,
            `brain_write_session: kind must be 'artifact' or 'panel', got '${kind}'`,
          );
        }
        const target = coerceStr(args, "target", true)!;
        const intent = coerceStr(args, "intent", false) ?? "create";
        if (intent !== "create" && intent !== "overwrite" && intent !== "merge") {
          throw new MCPError(
            INVALID_PARAMS,
            `brain_write_session: intent must be create|overwrite|merge, got '${intent}'`,
          );
        }
        const schemaType = coerceStr(args, "schema_type", false);
        const prompt = coerceStr(args, "prompt", false);
        const retryCap = args["retry_cap"];
        return asRecord(
          openArtifactSession(ctx.vault, {
            agent,
            targetPath: target,
            intent,
            requireReview,
            ...(schemaType ? { schemaType } : {}),
            ...(prompt ? { prompt } : {}),
            ...(typeof retryCap === "number" ? { retryCap } : {}),
          }),
        );
      }
      case "submit": {
        const id = requireSessionId();
        const text = coerceStr(args, "text", true)!;
        return asRecord(dispatchSubmit(ctx.vault, { sessionId: id, text }));
      }
      case "approve":
        return asRecord(approveSession(ctx.vault, { sessionId: requireSessionId() }));
      case "abandon":
        return asRecord(abandonSession(ctx.vault, { sessionId: requireSessionId() }));
      case "status": {
        const id = requireSessionId();
        const probe = readWriteSession(ctx.vault, id, new Date().toISOString());
        if (probe.error !== null) throw new MCPError(INVALID_PARAMS, probe.error);
        if (probe.session === null) {
          throw new MCPError(INVALID_PARAMS, `unknown write-session: ${id}`);
        }
        return asRecord(sessionEnvelope(probe.session));
      }
      case "list": {
        const limit = coerceInt(args, "limit", 100, 1, 500);
        const sessions = listWriteSessions(ctx.vault, new Date().toISOString());
        return {
          total: sessions.length,
          sessions: sessions.slice(0, limit).map((rec) => asRecord(sessionEnvelope(rec))),
        };
      }
      default:
        throw new MCPError(
          INVALID_PARAMS,
          `brain_write_session: op must be open|submit|approve|abandon|status|list, got '${op}'`,
        );
    }
  } catch (err) {
    if (err instanceof WriteSessionRequestError) {
      // Preserve the {code, path, message} boundary contract: the
      // structured list rides MCPError's data slot, the message stays
      // human-readable prose.
      throw new MCPError(
        INVALID_PARAMS,
        err.message,
        err.errors.length > 0 ? { errors: err.errors } : undefined,
      );
    }
    throw err;
  }
}

function asRecord(envelope: WriteSessionEnvelope): Record<string, unknown> {
  return { ...envelope };
}

// ----- brain_context (v0.10.10) --------------------------------------------

type PinnedContextOperation = "read" | "write" | "append" | "clear";

function coercePinnedContextOperation(args: Record<string, unknown>): PinnedContextOperation {
  const operation = coerceStr(args, "operation", false) ?? "read";
  if (
    operation !== "read" &&
    operation !== "write" &&
    operation !== "append" &&
    operation !== "clear"
  ) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_pinned_context operation must be one of: read, write, append, clear",
    );
  }
  return operation;
}

function serializePinnedContext(
  ctx: ServerContext,
  pinned: PinnedContext,
  operation?: PinnedContextOperation,
): Record<string, unknown> {
  return {
    ...(operation ? { operation } : {}),
    present: pinned.present,
    path: vaultRelativeSafe(ctx.vault, pinned.path),
    absolute_path: pinned.path,
    content: pinned.content,
  };
}

async function toolBrainPinnedContext(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = coercePinnedContextOperation(args);
  let pinned: PinnedContext;
  if (operation === "read") {
    pinned = readPinnedContext(ctx.vault);
  } else if (operation === "write") {
    pinned = writePinnedContext(ctx.vault, coerceStr(args, "content", true)!);
  } else if (operation === "append") {
    pinned = appendPinnedContext(ctx.vault, coerceStr(args, "content", true)!);
  } else {
    pinned = clearPinnedContext(ctx.vault);
  }
  return serializePinnedContext(ctx, pinned, operation);
}

function appendPinnedToContextContent(activeContent: string, pinnedContent: string): string {
  if (pinnedContent.length === 0) return activeContent;
  const pinnedBlock = `## Pinned context\n\n${pinnedContent}`;
  const trimmedActive = activeContent.trimEnd();
  if (trimmedActive.length === 0) return `${pinnedBlock}\n`;
  return `${trimmedActive}\n\n${pinnedBlock}\n`;
}

type BrainContextCounts = RegenerateActiveResult["counts"];

const EMPTY_CONTEXT_COUNTS: BrainContextCounts = {
  confirmed: 0,
  quarantine: 0,
  retired_recent: 0,
  most_applied_30d: 0,
};

/**
 * Read-only pull-bootstrap of `Brain/active.md` + the active-preference
 * counts. Built for runtimes that have no `SessionStart` hook (Cursor,
 * Aider, raw Claude API): one tool call gives the agent the same
 * shortcut card the SessionStart-aware runtimes get injected
 * automatically.
 *
 * Behaviour matrix:
 *   - Brain/ absent           → present:false, content:"", zero counts.
 *   - Brain/ present, active.md absent → call regenerateActive (idempotent)
 *                                        and read the regenerated file.
 *   - Brain/ present, active.md fresh  → idempotent regenerate is a no-op
 *                                        rewrite; the on-disk body is
 *                                        returned verbatim.
 */
async function toolBrainContext(ctx: ServerContext): Promise<Record<string, unknown>> {
  const dirs = brainDirs(ctx.vault);
  const activePath = brainActivePath(ctx.vault);
  const pinned = readPinnedContext(ctx.vault);
  if (!existsSync(dirs.brain)) {
    return {
      vault_path: ctx.vault,
      present: false,
      active_path: activePath,
      content: "",
      counts: EMPTY_CONTEXT_COUNTS,
      generated_at: null,
      pinned: serializePinnedContext(ctx, pinned),
    };
  }

  let counts: BrainContextCounts = EMPTY_CONTEXT_COUNTS;
  let error: string | undefined;
  try {
    counts = regenerateActive(ctx.vault).counts;
  } catch (err) {
    error = (err as Error)?.message ?? String(err);
  }

  // After a successful regenerateActive, active.md is guaranteed to
  // exist (the function either wrote it or confirmed an equal body
  // already on disk). A read failure here is an unrelated filesystem
  // race, not a missing-file branch — handle it in the same `error`
  // slot the regenerate failure uses.
  let content = "";
  let generatedAt: string | null = null;
  if (!error) {
    try {
      content = readFileSync(activePath, "utf8");
      const [meta] = parseFrontmatter(activePath);
      const v = meta["generated_at"];
      if (typeof v === "string" && v.trim().length > 0) {
        generatedAt = v;
      }
    } catch (err) {
      error = (err as Error)?.message ?? String(err);
      content = "";
      generatedAt = null;
    }
  }
  content = appendPinnedToContextContent(content, pinned.content);

  // Optional vault-root instruction file (v0.10.17). Absent file =
  // field omitted so hosts that strip unknown fields stay
  // byte-identical. Read errors are silently swallowed - this is a
  // best-effort enrichment, not a hard contract.
  let vaultInstruction: ReturnType<typeof readVaultInstructionFile> = null;
  try {
    vaultInstruction = readVaultInstructionFile(ctx.vault);
  } catch {
    vaultInstruction = null;
  }

  return {
    vault_path: ctx.vault,
    present: true,
    active_path: activePath,
    content,
    counts,
    generated_at: generatedAt,
    pinned: serializePinnedContext(ctx, pinned),
    ...(error ? { error } : {}),
    ...(vaultInstruction
      ? {
          vault_instruction: {
            path: vaultInstruction.path,
            content: vaultInstruction.content,
            lines: vaultInstruction.lines,
          },
        }
      : {}),
  };
}

// ----- brain_digest --------------------------------------------------------

async function toolBrainDigest(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const since = coerceIsoDate(args, "since");
  const until = coerceIsoDate(args, "until");
  const format = coerceFormat(args) satisfies DigestFormat;

  const result = renderDigest(ctx.vault, {
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    format,
    linkOutputFormat: resolveLinkOutputFormat(ctx.configPath ?? undefined),
  });

  return {
    format,
    empty: result.empty,
    content: result.content,
  };
}

// ----- brain_query ---------------------------------------------------------

async function toolBrainQuery(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const preference = coerceStr(args, "preference", false);
  const topic = coerceStr(args, "topic", false);
  const since = coerceIsoDate(args, "since");
  // `format` is accepted for forward-compat (design doc §9.2 names it),
  // but the structured response shape is identical regardless — the
  // caller serialises however they want. We validate the value to catch
  // typos early.
  coerceFormat(args);

  const supplied = [preference, topic, since].filter((v) => v !== null).length;
  if (supplied === 0) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_query requires exactly one of: preference, topic, since",
    );
  }
  if (supplied > 1) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_query accepts at most one of: preference, topic, since",
    );
  }

  // Recall telemetry (t_405b8053): per-call opt-in mirroring
  // brain_search. The payload carries the query KIND only - never the
  // supplied preference id / topic slug / timestamp value.
  const telemetry = coerceBoolOptional(args, "telemetry") ?? false;
  const telemetryHost = coerceStringOptional(args, "telemetry_host", 200) ?? "mcp";
  const telemetrySessionId = coerceStringOptional(args, "session_id", 512);
  const telemetryTurnId = coerceStringOptional(args, "turn_id", 512);
  const queryKind = preference !== null ? "preference" : topic !== null ? "topic" : "since";
  const startedAtMs = Date.now();
  const emitQueryTelemetry = (status: "ok" | "empty" | "error", resultCount: number): void => {
    // Lazy emit kernel (t_5d7aa7c5): gate off = thunk never runs; a
    // throwing continuity write can never fail the query itself.
    emitGatedTelemetry(telemetry || undefined, () =>
      emitRecallTelemetry(ctx.vault, {
        host: telemetryHost,
        ...(telemetrySessionId !== undefined ? { sessionId: telemetrySessionId } : {}),
        ...(telemetryTurnId !== undefined ? { turnId: telemetryTurnId } : {}),
        mode: "query",
        status,
        durationMs: Date.now() - startedAtMs,
        resultCount,
        gaps:
          status === "error" ? ["query_error"] : status === "empty" ? ["no_matching_context"] : [],
        metadata: { query_kind: queryKind },
      }),
    );
  };

  try {
    if (preference !== null) {
      try {
        const res = queryByPreference(ctx.vault, preference);
        emitQueryTelemetry(res.evidence.length > 0 ? "ok" : "empty", res.evidence.length);
        return {
          mode: "preference",
          preference: serializePreference(res.preference),
          evidence: res.evidence.map(serializeLogEntry),
        };
      } catch (exc) {
        if (exc instanceof BrainNotFoundError) {
          throw new Error(exc.message, { cause: exc });
        }
        throw exc;
      }
    }

    if (topic !== null) {
      const res = queryByTopic(ctx.vault, topic);
      const resultCount = res.signals.length + res.all_log_events.length;
      emitQueryTelemetry(resultCount > 0 ? "ok" : "empty", resultCount);
      return {
        mode: "topic",
        topic,
        signals: res.signals.map(serializeSignal),
        preference: res.preference ? serializePreference(res.preference) : null,
        all_log_events: res.all_log_events.map(serializeLogEntry),
      };
    }

    // since
    const res = queryByLogSince(ctx.vault, since!);
    emitQueryTelemetry(res.length > 0 ? "ok" : "empty", res.length);
    return {
      mode: "since",
      since: since!.toISOString(),
      events: res.map(serializeLogEntry),
    };
  } catch (exc) {
    emitQueryTelemetry("error", 0);
    throw exc;
  }
}

// ----- brain_agent_query / brain_agent_diff --------------------------------

async function toolBrainAgentQuery(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const topic = coerceStr(args, "topic", false);
  const query = coerceStr(args, "query", false);
  const kind = coerceAgentContributionKind(args, "kind");
  return queryAgentSources(ctx.vault, {
    agents: coerceStrList(args, "agents"),
    ...(topic !== null ? { topic } : {}),
    ...(query !== null ? { query } : {}),
    ...(kind !== null ? { kind } : {}),
    limit: coerceInt(args, "limit", 50, 1, 500),
  }) as unknown as Record<string, unknown>;
}

async function toolBrainAgentDiff(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const mode = coerceAgentDiffMode(args, "mode");
  const topic = coerceStr(args, "topic", false);
  const query = coerceStr(args, "query", false);
  const kind = coerceAgentContributionKind(args, "kind");
  return diffAgentSources(ctx.vault, {
    ...(mode !== null ? { mode } : {}),
    agents: coerceStrList(args, "agents"),
    ...(topic !== null ? { topic } : {}),
    ...(query !== null ? { query } : {}),
    ...(kind !== null ? { kind } : {}),
    limit: coerceInt(args, "limit", 50, 1, 500),
  }) as unknown as Record<string, unknown>;
}

function coerceAgentContributionKind(
  args: Record<string, unknown>,
  key: string,
): AgentSourceContributionKind | null {
  const raw = coerceStr(args, key, false);
  if (raw === null) return null;
  if (raw !== "signal" && raw !== "preference" && raw !== "log") {
    throw new MCPError(
      INVALID_PARAMS,
      `argument '${key}' must be 'signal', 'preference', or 'log'`,
    );
  }
  return raw;
}

function coerceAgentDiffMode(
  args: Record<string, unknown>,
  key: string,
): AgentSourceDiffMode | null {
  const raw = coerceStr(args, key, false);
  if (raw === null) return null;
  if (raw !== "browse" && raw !== "search" && raw !== "diff" && raw !== "map") {
    throw new MCPError(
      INVALID_PARAMS,
      `argument '${key}' must be 'browse', 'search', 'diff', or 'map'`,
    );
  }
  return raw;
}

// ----- brain_backlinks -----------------------------------------------------

/** Serialize one entity for the MCP payload (no absolute paths). */
function entityToPayload(
  entity: import("../core/brain/entities/types.ts").BrainEntity,
): Record<string, unknown> {
  return {
    id: entity.id,
    category: entity.category,
    name: entity.name,
    aliases: [...entity.aliases],
    status: entity.status,
    ...(entity.source_agent !== undefined ? { source_agent: entity.source_agent } : {}),
    ...(entity.confidence !== undefined ? { confidence: entity.confidence } : {}),
    created_at: entity.created_at,
    updated_at: entity.updated_at,
    ...(entity.archived_at !== undefined ? { archived_at: entity.archived_at } : {}),
    relations: entity.relations.map((r) => ({ relation: r.relation, target: r.target })),
    body: entity.body,
  };
}

async function toolBrainEntity(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Argument validation happens at the boundary so INVALID_PARAMS is
  // reserved for genuine client-input errors; unexpected registry
  // failures (malformed entity file, I/O) surface as INTERNAL_ERROR.
  const view = coerceStr(args, "view", true)!;
  if (view !== "get" && view !== "list") {
    throw new MCPError(INVALID_PARAMS, `brain_entity: unknown view '${view}' (get | list)`);
  }
  const category = coerceStr(args, "category", false);
  if (category !== null) {
    try {
      validateEntityCategory(category);
    } catch (err) {
      throw new MCPError(INVALID_PARAMS, `brain_entity: ${(err as Error).message}`);
    }
  }
  const status = coerceStr(args, "status", false);
  if (status !== null && status !== "active" && status !== "archived") {
    throw new MCPError(INVALID_PARAMS, "brain_entity: status must be 'active' or 'archived'");
  }
  const query = view === "get" ? coerceStr(args, "query", true)! : null;

  try {
    if (view === "get") {
      const entity = getEntity(ctx.vault, {
        query: query!,
        ...(category !== null ? { category } : {}),
      });
      if (entity === null) return { found: false, query: query! };
      return { found: true, ...entityToPayload(entity) };
    }
    const entities = listEntities(ctx.vault, {
      ...(category !== null ? { category } : {}),
      ...(status !== null ? { status } : {}),
    });
    return { entities: entities.map(entityToPayload), total: entities.length };
  } catch (err) {
    if (err instanceof MCPError) throw err;
    if (err instanceof EntityAmbiguityError) {
      // A category-less query hitting several categories is a
      // client-resolvable input problem, not a server fault.
      throw new MCPError(INVALID_PARAMS, `brain_entity: ${err.message}`);
    }
    throw new MCPError(INTERNAL_ERROR, `brain_entity: ${(err as Error).message}`);
  }
}

async function toolBrainBacklinks(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = coerceStr(args, "id", true)!;
  // The index is keyed by normalised wikilink targets. Run callers'
  // input through the same normaliser so `pref-foo`, `[[pref-foo]]`,
  // `[[pref-foo|Alias]]`, and `Brain/preferences/pref-foo.md` all
  // resolve to the same lookup.
  const target = normaliseWikilinkTarget(id);
  const index = buildBacklinkIndex(ctx.vault);
  const refs = index.get(target) ?? [];
  return {
    id: target,
    count: refs.length,
    refs: refs.map((r) => ({
      source: r.source,
      source_kind: r.sourceKind,
      field: r.field,
      ...(r.timestamp !== undefined ? { timestamp: r.timestamp } : {}),
    })),
  };
}

async function toolBrainAudit(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const raw = coerceStr(args, "pref_id", true)!;
  // The trail is keyed by the original `pref-<slug>` id. Run the input
  // through the shared wikilink normaliser first (handles `[[id]]`,
  // `[[id|Alias]]`, and `Brain/.../id.md` forms), then strip the
  // pref-/ret- prefix so every reference resolves to one trail.
  const slug = normaliseWikilinkTarget(raw)
    .replace(/^(?:pref-|ret-)/, "")
    .trim();
  if (slug.length === 0) {
    throw new Error(`brain_audit: empty preference slug after normalising '${raw}'`);
  }
  const prefId = `pref-${slug}`;
  const { records, warnings } = readPrefAudit(ctx.vault, prefId);
  return {
    pref_id: prefId,
    count: records.length,
    records,
    warnings: warnings.map((w) => w.message),
  };
}

async function toolBrainMorningBrief(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const topK = optionalPositiveInt(args, "top_k", "brain_morning_brief") ?? 10;
  const lookbackDays = optionalPositiveInt(args, "lookback_days", "brain_morning_brief") ?? 7;
  const maxCharsPerMemory = optionalPositiveInt(
    args,
    "max_chars_per_memory",
    "brain_morning_brief",
  );
  const maxTotalChars = optionalPositiveInt(args, "max_total_chars", "brain_morning_brief");
  const now = new Date();
  const brief = buildMorningBrief(ctx.vault, {
    now,
    topK,
    lookbackDays,
    ...(maxCharsPerMemory !== undefined ? { maxCharsPerMemory } : {}),
    ...(maxTotalChars !== undefined ? { maxTotalChars } : {}),
  });
  // Pending-trigger section (t_cd1fee79): renders only when a trigger
  // scan persisted surfaceable triggers; included triggers are marked
  // delivered so a prompt shows once per cooldown window. Fail-soft -
  // a broken queue never breaks the brief.
  let triggerSection: ReturnType<typeof renderTriggerBriefSection> | null = null;
  try {
    triggerSection = renderTriggerBriefSection(ctx.vault, {
      now,
      cooldownDays: resolveTriggerCooldownDays(ctx.configPath ?? undefined),
    });
    if (triggerSection.triggers.length > 0) deliverBriefTriggers(ctx.vault, triggerSection, now);
  } catch {
    triggerSection = null;
  }
  const text =
    triggerSection !== null && triggerSection.text !== ""
      ? `${brief.text}${brief.text.length > 0 ? "\n\n" : ""}${triggerSection.text}`
      : brief.text;
  return {
    text,
    preferences: brief.preferences,
    open_questions: brief.openQuestions,
    recent_notes: brief.recentNotes,
    total_chars: brief.totalChars,
    ...(triggerSection !== null && triggerSection.triggers.length > 0
      ? {
          triggers: triggerSection.triggers.map((t) => ({
            id: t.id,
            kind: t.kind,
            urgency: t.urgency,
            reason: t.reason,
          })),
        }
      : {}),
  };
}

async function toolBrainSources(
  ctx: ServerContext,
  _args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  void _args;
  const report = aggregateSources(ctx.vault);
  return {
    sources: report.sources,
    total_active: report.total_active,
    total_processed: report.total_processed,
  };
}

async function toolBrainSwitchVault(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const name = coerceStr(args, "name", true)!;
  const configPath = ctx.configPath ?? defaultConfigPath();
  try {
    switchProfile(configPath, name);
  } catch (err) {
    throw new Error(`brain_switch_vault: ${(err as Error).message ?? String(err)}`, {
      cause: err,
    });
  }
  // The running server keeps its already-resolved vault; the switch
  // takes effect for the next server launch / CLI invocation.
  return {
    active: name,
    profiles: listProfiles(configPath).profiles,
    note: "active profile updated; takes effect on next server launch",
  };
}

// ----- brain_doctor --------------------------------------------------------

async function toolBrainDoctor(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const strict = coerceBool(args, "strict");
  const format = coerceFormat(args);

  const result = runDoctor(ctx.vault, {
    strict,
    dbPath: resolveSearchConfig({ vault: ctx.vault, configPath: ctx.configPath ?? undefined })
      .dbPath,
  });

  // Decide a single ok flag — `strict` only changes the CLI exit code,
  // so we mirror that semantic here: with `strict`, warnings demote ok
  // to false. Errors always do.
  const ok = result.errors.length === 0 && (!strict || result.warnings.length === 0);

  return {
    format,
    ok,
    strict,
    errors: result.errors.map((i) => ({
      severity: i.severity,
      code: i.code,
      message: i.message,
      ...(i.path !== undefined ? { path: vaultRelativeSafe(ctx.vault, i.path) } : {}),
    })),
    warnings: result.warnings.map((i) => ({
      severity: i.severity,
      code: i.code,
      message: i.message,
      ...(i.path !== undefined ? { path: vaultRelativeSafe(ctx.vault, i.path) } : {}),
    })),
    // v0.10.15: ranked maintenance actions surfaced as a parallel
    // signal to errors/warnings. The list is independent of `strict`
    // because nothing here downgrades the `ok` flag - actions are
    // suggestions, not invariant violations.
    suggested_actions: collectMaintenanceActions(ctx.vault).map((a) => ({
      id: a.id,
      category: a.category,
      title: a.title,
      impact: a.impact,
      ...(a.target !== undefined ? { target: a.target } : {}),
    })),
    // v0.10.16: trust-layer fields. `trust_verdict` is always populated
    // by runDoctor; `verification_delta_summary` only when the caller
    // threads a dream summary through (not exposed via this tool's
    // surface, so it stays absent here). `instruction_file_warnings`
    // surfaces vault-root instruction files exceeding the configured
    // ceiling.
    ...(result.trust_verdict !== undefined ? { trust_verdict: result.trust_verdict } : {}),
    instruction_file_warnings: (result.instruction_file_warnings ?? []).map((w) => ({
      path: w.path,
      lines: w.lines,
      ceiling: w.ceiling,
    })),
  };
}

// ----- brain_health --------------------------------------------------------

async function toolBrainHealth(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const format = coerceFormat(args);
  const result = runDoctor(ctx.vault);
  const sh = result.semantic_health;
  return {
    format,
    verdict: sh?.verdict ?? "clean",
    contradictions: (sh?.contradictions ?? []).map((c) => ({
      a: c.aId,
      b: c.bId,
      ...(c.scope !== null ? { scope: c.scope } : {}),
      jaccard: c.jaccard,
      a_sign: c.aSign,
      b_sign: c.bSign,
    })),
    concept_gaps: (sh?.conceptGaps ?? []).map((g) => ({
      term: g.term,
      frequency: g.frequency,
    })),
    stale_claims: (sh?.staleClaims ?? []).map((s) => ({
      id: s.id,
      last_evidence_at: s.lastEvidenceAt,
      age_days: s.ageDays,
    })),
  };
}

// ----- Serializers ---------------------------------------------------------

function serializeSignal(s: BrainSignal): Record<string, unknown> {
  return {
    kind: s.kind,
    id: s.id,
    created_at: s.created_at,
    topic: s.topic,
    signal: s.signal,
    agent: s.agent,
    principle: s.principle,
    tags: [...s.tags],
    ...(s.scope !== undefined ? { scope: s.scope } : {}),
    ...(s.source !== undefined ? { source: [...s.source] } : {}),
    ...(s.raw !== undefined ? { raw: s.raw } : {}),
  };
}

function serializePreference(p: BrainPreference | BrainRetired): Record<string, unknown> {
  if (p.kind === "brain-retired") {
    return {
      kind: p.kind,
      id: p.id,
      status: p.status,
      retired_at: p.retired_at,
      retired_reason: p.retired_reason,
      retired_by: p.retired_by,
      ...(p.superseded_by !== undefined ? { superseded_by: p.superseded_by } : {}),
      created_at: p.created_at,
      topic: p.topic,
      ...(p.scope !== undefined ? { scope: p.scope } : {}),
      principle: p.principle,
      evidenced_by: [...p.evidenced_by],
      applied_count: p.applied_count,
      violated_count: p.violated_count,
      last_evidence_at: p.last_evidence_at,
      confidence: p.confidence,
      confidence_value: p.confidence_value,
      pinned: p.pinned,
      tags: [...p.tags],
      ...(p.aliases !== undefined ? { aliases: [...p.aliases] } : {}),
    };
  }
  return {
    kind: p.kind,
    id: p.id,
    created_at: p.created_at,
    confirmed_at: p.confirmed_at,
    unconfirmed_until: p.unconfirmed_until,
    topic: p.topic,
    ...(p.scope !== undefined ? { scope: p.scope } : {}),
    status: p.status,
    principle: p.principle,
    evidenced_by: [...p.evidenced_by],
    applied_count: p.applied_count,
    violated_count: p.violated_count,
    last_evidence_at: p.last_evidence_at,
    confidence: p.confidence,
    confidence_value: p.confidence_value,
    pinned: p.pinned,
    tags: [...p.tags],
    ...(p.supersedes !== undefined ? { supersedes: p.supersedes } : {}),
    ...(p.aliases !== undefined ? { aliases: [...p.aliases] } : {}),
  };
}

function serializeLogEntry(e: BrainLogEntry): Record<string, unknown> {
  // Preserve the structured payload verbatim (array values stay arrays).
  // JSON.stringify handles `ReadonlyArray<string>` and string values
  // identically. `Object.entries` widens the value type to `unknown` for
  // generic-keyed records under `verbatimModuleSyntax`; narrow explicitly.
  const body: Record<string, string | ReadonlyArray<string>> = {};
  for (const [k, v] of Object.entries(e.body) as ReadonlyArray<
    readonly [string, string | ReadonlyArray<string>]
  >) {
    body[k] = Array.isArray(v) ? [...v] : v;
  }
  return {
    timestamp: e.timestamp,
    event_type: e.eventType,
    body,
  };
}

// ----- Misc ----------------------------------------------------------------

/**
 * Produce a vault-relative path, swallowing errors (Pay Memory uses the
 * same defensive pattern for output rendering). Exported for unit tests
 * — internal callers stay inside this module.
 *
 * @internal
 */
export function vaultRelativeSafe(vault: string, target: string): string {
  const absVault = resolve(vault);
  const absTarget = resolve(target);
  // Use Node's path.relative so the separator handling matches the host
  // OS (forward-slashes on POSIX, back-slashes on Windows). The prior
  // implementation hard-coded `"/"` and silently broke on Windows when
  // the vault sat under e.g. `C:\Users\...`.
  const rel = relative(absVault, absTarget);
  if (rel === "") return "";
  // `relative()` returns a path starting with `..` (or, in rare drive-
  // mismatch cases on Windows, an absolute path) when the target sits
  // outside the vault. In both situations we return the original target
  // unchanged — callers treat that as "not under vault" and render it
  // as-is.
  if (rel.startsWith("..") || isAbsolute(rel)) return target;
  return rel;
}

// ----- Tool registration ---------------------------------------------------

const PINNED_CONTEXT_OUTPUT_SCHEMA: NonNullable<ToolDefinition["outputSchema"]> = {
  type: "object",
  required: ["present", "path", "absolute_path", "content"],
  properties: {
    operation: { type: "string", enum: ["read", "write", "append", "clear"] },
    present: { type: "boolean" },
    path: { type: "string" },
    absolute_path: { type: "string" },
    content: { type: "string" },
  },
  additionalProperties: false,
};

const BRAIN_CONTEXT_OUTPUT_SCHEMA: NonNullable<ToolDefinition["outputSchema"]> = {
  type: "object",
  required: ["vault_path", "present", "active_path", "content", "counts", "generated_at", "pinned"],
  properties: {
    vault_path: { type: "string" },
    present: { type: "boolean" },
    active_path: { type: "string" },
    content: { type: "string" },
    counts: {
      type: "object",
      required: ["confirmed", "quarantine", "retired_recent", "most_applied_30d"],
      properties: {
        confirmed: { type: "integer" },
        quarantine: { type: "integer" },
        retired_recent: { type: "integer" },
        most_applied_30d: { type: "integer" },
      },
      additionalProperties: false,
    },
    generated_at: {},
    pinned: PINNED_CONTEXT_OUTPUT_SCHEMA,
  },
};

const BRAIN_QUERY_OUTPUT_SCHEMA: NonNullable<ToolDefinition["outputSchema"]> = {
  type: "object",
  required: ["mode"],
  properties: {
    mode: { type: "string", enum: ["preference", "topic", "since"] },
  },
};

// ----- brain_operator_summary (v0.10.16) -----------------------------------

/**
 * Aggregate operator dashboard: trust verdict, doctor / dream
 * counts, verification delta summary, ranked maintenance actions,
 * and instruction-file ceiling warnings - one read-only call so an
 * operator does not run `brain_digest` + `brain_doctor` separately.
 */
async function toolBrainOperatorSummary(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const topRaw = args["top_actions"];
  let topActionsN: number | undefined;
  if (topRaw !== undefined && topRaw !== null) {
    // Strict integer coercion: reject `"3abc"`, `"2.5"`, and other
    // shapes `Number.parseInt` would silently accept. Only a pure
    // integer literal is allowed.
    if (typeof topRaw === "number") {
      if (!Number.isInteger(topRaw) || topRaw < 0) {
        throw new MCPError(
          INVALID_PARAMS,
          "brain_operator_summary: top_actions must be a non-negative integer",
        );
      }
      topActionsN = topRaw;
    } else if (typeof topRaw === "string") {
      const trimmed = topRaw.trim();
      if (trimmed === "" || !/^[0-9]+$/.test(trimmed)) {
        throw new MCPError(
          INVALID_PARAMS,
          "brain_operator_summary: top_actions must be a non-negative integer",
        );
      }
      topActionsN = Number.parseInt(trimmed, 10);
    } else {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_operator_summary: top_actions must be a non-negative integer",
      );
    }
  }

  const includeDreamRaw = args["include_dream"];
  let includeDream: boolean;
  if (includeDreamRaw === undefined || includeDreamRaw === null) {
    includeDream = true;
  } else if (typeof includeDreamRaw === "boolean") {
    includeDream = includeDreamRaw;
  } else {
    throw new MCPError(INVALID_PARAMS, "brain_operator_summary: include_dream must be a boolean");
  }

  let dreamSummary;
  let dreamError: string | undefined;
  if (includeDream) {
    try {
      dreamSummary = dream(ctx.vault, { dryRun: true });
    } catch (err) {
      // Surface the failure so callers know the dashboard is missing
      // verification + dream signals; do not silently produce a
      // partial envelope.
      dreamError = (err as Error).message ?? String(err);
    }
  }
  const summary = buildOperatorSummary(ctx.vault, {
    ...(dreamSummary ? { dreamSummary } : {}),
    ...(topActionsN !== undefined ? { topActionsN } : {}),
  });
  return {
    vault_path: ctx.vault,
    trust_verdict: summary.trust_verdict,
    digest_summary: summary.digest_summary,
    doctor_summary: {
      warning_count: summary.doctor_summary.warning_count,
      error_count: summary.doctor_summary.error_count,
    },
    dream_summary: summary.dream_summary,
    verification_delta: {
      summary: summary.verification_delta.summary,
      entries: summary.verification_delta.entries,
    },
    top_actions: summary.top_actions,
    instruction_file_warnings: summary.instruction_file_warnings,
    ...(dreamError !== undefined ? { dream_error: dreamError } : {}),
  };
}

// ----- brain_unlinked_mentions (v0.10.17) ----------------------------------

/**
 * Raw-text mentions of a target's title / aliases that are NOT
 * already inside `[[...]]` wikilinks. Read-only walker over
 * `Brain/preferences/` and `Brain/retired/`. Match boundary is
 * Unicode-aware (`\p{L}`, `\p{N}`), language-agnostic.
 */
async function toolBrainUnlinkedMentions(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const idRaw = args["id"];
  if (typeof idRaw !== "string" || idRaw.trim().length === 0) {
    throw new MCPError(INVALID_PARAMS, "brain_unlinked_mentions: id must be a non-empty string");
  }
  const targetId = normaliseWikilinkTarget(idRaw);
  // Limit coercion mirrors the v0.10.16 `brain_operator_summary`
  // precedent: accept either a number or a strict integer-literal
  // string (`"5"` ok; `"abc"`, `"3abc"`, `"2.5"` rejected). This
  // keeps the MCP boundary uniform across new tools.
  const limitRaw = args["limit"];
  let limit: number | undefined;
  if (limitRaw !== undefined && limitRaw !== null) {
    if (typeof limitRaw === "number") {
      if (!Number.isInteger(limitRaw) || limitRaw < 1) {
        throw new MCPError(
          INVALID_PARAMS,
          "brain_unlinked_mentions: limit must be a positive integer",
        );
      }
      limit = limitRaw;
    } else if (typeof limitRaw === "string") {
      const trimmed = limitRaw.trim();
      if (trimmed === "" || !/^[0-9]+$/.test(trimmed)) {
        throw new MCPError(
          INVALID_PARAMS,
          "brain_unlinked_mentions: limit must be a positive integer",
        );
      }
      const parsed = Number.parseInt(trimmed, 10);
      if (parsed < 1) {
        throw new MCPError(
          INVALID_PARAMS,
          "brain_unlinked_mentions: limit must be a positive integer",
        );
      }
      limit = parsed;
    } else {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_unlinked_mentions: limit must be a positive integer",
      );
    }
  }
  const mentions = findUnlinkedMentions(ctx.vault, targetId, limit !== undefined ? { limit } : {});
  return {
    vault_path: ctx.vault,
    target_id: targetId,
    mentions: mentions.map((m) => ({
      source: m.source,
      line: m.line,
      term: m.term,
      context: m.contextSnippet,
    })),
  };
}

// ----- brain_foresight (t_08a79c81) -----------------------------------------

/** Forward-looking projection envelope; read-only fold. */
function toolBrainForesight(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const horizonRaw = args["horizon_days"];
  let horizonDays = FORESIGHT_HORIZON_DAYS;
  if (horizonRaw !== undefined && horizonRaw !== null) {
    if (typeof horizonRaw !== "number" || !Number.isInteger(horizonRaw) || horizonRaw < 1) {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_foresight: horizon_days must be a positive integer",
      );
    }
    horizonDays = horizonRaw;
  }
  return { ...buildForesight(ctx.vault, { now: new Date(), horizonDays }) };
}

// ----- brain_labels (t_7a41f42d) ---------------------------------------------

/** Controlled-vocabulary classification over the schema pack's labels. */
function toolBrainLabels(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const op = args["operation"];
  if (op !== "assign" && op !== "remove" && op !== "show") {
    throw new MCPError(INVALID_PARAMS, "brain_labels: operation must be assign|remove|show");
  }
  const path = args["path"];
  if (typeof path !== "string" || path.trim() === "") {
    throw new MCPError(INVALID_PARAMS, "brain_labels: path must be a vault-relative string");
  }
  if (op === "show") {
    const [metadata] = parseFrontmatter(join(ctx.vault, path));
    return { path, labels: readLabels(metadata) };
  }
  const pack = loadSchemaPack(ctx.vault);
  const dimension = args["dimension"];
  if (typeof dimension !== "string" || dimension.trim() === "") {
    throw new MCPError(INVALID_PARAMS, `brain_labels ${op}: dimension must be non-empty`);
  }
  try {
    if (op === "remove") {
      return { ...removeNoteLabel(ctx.vault, path, { dimension, pack }) };
    }
    const value = args["value"];
    if (typeof value !== "string" || value.trim() === "") {
      throw new MCPError(INVALID_PARAMS, "brain_labels assign: value must be non-empty");
    }
    const agentArg = args["agent"];
    const agent =
      normalizeAgentArgument(typeof agentArg === "string" ? agentArg : null) ??
      resolveAgentName(ctx.configPath ?? undefined);
    return {
      ...assignNoteLabel(ctx.vault, path, { dimension, value, pack, agent, now: new Date() }),
    };
  } catch (exc) {
    if (exc instanceof LabelVocabularyError) {
      throw new MCPError(INVALID_PARAMS, `brain_labels ${op}: ${exc.message}`);
    }
    throw exc;
  }
}

// ----- brain_tiers (t_3f92d3f1) ----------------------------------------------

/** Staged repair surface for identity-tier frontmatter hand-edits. */
async function toolBrainTiers(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "check" && op !== "restore" && op !== "accept") {
    throw new MCPError(INVALID_PARAMS, "brain_tiers: operation must be check|restore|accept");
  }
  const searchConfig = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });
  if (op === "check") {
    // Fail-soft: a vault that was never indexed has no snapshots and
    // therefore no drift - not an error.
    if (!existsSync(searchConfig.dbPath)) return { findings: [] };
    const store = await Store.open(searchConfig, { mode: "read" });
    try {
      return { findings: store.listTierDrift() };
    } finally {
      await store.close();
    }
  }
  const path = args["path"];
  if (typeof path !== "string" || path.trim() === "") {
    throw new MCPError(INVALID_PARAMS, `brain_tiers ${op}: path must be a vault-relative string`);
  }
  if (op === "restore" && args["apply"] !== true) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_tiers restore: pass apply=true - restore writes the file",
    );
  }
  const field = typeof args["field"] === "string" ? (args["field"] as string) : undefined;
  if (!existsSync(searchConfig.dbPath)) {
    throw new MCPError(INVALID_PARAMS, `brain_tiers ${op}: the vault has no search index yet`);
  }
  const store = await Store.open(searchConfig, { mode: "write" });
  try {
    const docId = store.getDocumentIdByPath(path);
    if (docId === null) {
      throw new MCPError(INVALID_PARAMS, `brain_tiers ${op}: not indexed: ${path}`);
    }
    const rows = store
      .listTierDrift()
      .filter((r) => r.documentId === docId && (field === undefined || r.field === field));
    if (rows.length === 0) {
      throw new MCPError(INVALID_PARAMS, `brain_tiers ${op}: no open drift for ${path}`);
    }
    if (op === "restore") {
      const absolute = join(ctx.vault, path);
      const [metadata, body] = parseFrontmatter(absolute);
      const next = { ...metadata };
      for (const r of rows) {
        next[r.field] = frontmatterValueFromSnapshot(r.expected, r.field);
      }
      writeFrontmatterAtomic(absolute, next, body, { overwrite: true });
      for (const r of rows) store.clearTierDrift(docId, r.field);
      return { restored: rows.map((r) => r.field), path };
    }
    const snapshot: Record<string, unknown> = { ...store.getTierSnapshot(docId) };
    for (const r of rows) {
      snapshot[r.field] = r.actual;
      store.clearTierDrift(docId, r.field);
    }
    store.setTierSnapshot(docId, snapshot);
    return { accepted: rows.map((r) => r.field), path };
  } finally {
    await store.close();
  }
}

/** Narrow a snapshot value to the shapes frontmatter can carry. */
function frontmatterValueFromSnapshot(value: unknown, field: string): FrontmatterMap[string] {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value) && value.every((v): v is string => typeof v === "string")) {
    return value;
  }
  throw new MCPError(
    INVALID_PARAMS,
    `brain_tiers restore: snapshot value for "${field}" is not a frontmatter scalar or string array`,
  );
}

// ----- brain_secrets (t_0b134404) ---------------------------------------------

/**
 * Capability-gated custody, agent-facing subset: list metadata and
 * run an allowlisted command. Deliberately NO set/get over MCP - the
 * material enters via the operator's CLI and leaves only into a
 * subprocess env.
 */
async function toolBrainSecrets(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "list" && op !== "run") {
    throw new MCPError(INVALID_PARAMS, "brain_secrets: operation must be list|run");
  }
  if (op === "list") {
    return { secrets: listSecrets(ctx.vault) };
  }
  const name = args["name"];
  if (typeof name !== "string" || name.trim() === "") {
    throw new MCPError(INVALID_PARAMS, "brain_secrets run: name must be non-empty");
  }
  const command = args["command"];
  if (
    !Array.isArray(command) ||
    command.length === 0 ||
    !command.every((part): part is string => typeof part === "string")
  ) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_secrets run: command must be a non-empty array of strings",
    );
  }
  const agentArg = args["agent"];
  const agent =
    normalizeAgentArgument(typeof agentArg === "string" ? agentArg : null) ??
    resolveAgentName(ctx.configPath ?? undefined);
  try {
    const result = await runWithSecret(ctx.vault, name, command, { agent, now: new Date() });
    return { exit_code: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  } catch (exc) {
    if (exc instanceof SecretExecDeniedError) {
      throw new MCPError(INVALID_PARAMS, `brain_secrets run: ${exc.message}`);
    }
    throw exc;
  }
}

// ----- brain_maintenance (t_166d1226) ------------------------------------------

/** Quiet-window, lease-guarded heavy maintenance lane. */
async function toolBrainMaintenance(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "run" && op !== "status") {
    throw new MCPError(INVALID_PARAMS, "brain_maintenance: operation must be run|status");
  }
  const now = new Date();
  if (op === "status") {
    return {
      lease: currentLease(ctx.vault, { now }),
      journal: listJournal(ctx.vault, 10),
    };
  }
  let window: DailyWindow | undefined;
  const startHour = args["window_start_hour"];
  const endHour = args["window_end_hour"];
  if (startHour !== undefined || endHour !== undefined) {
    if (
      typeof startHour !== "number" ||
      typeof endHour !== "number" ||
      !Number.isInteger(startHour) ||
      !Number.isInteger(endHour) ||
      startHour < 0 ||
      startHour > 23 ||
      endHour < 0 ||
      endHour > 23
    ) {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_maintenance run: window_start_hour/window_end_hour must be integers 0..23",
      );
    }
    const tz = typeof args["tz"] === "string" ? (args["tz"] as string) : "UTC";
    window = { startHour, endHour, tz };
  }
  const agentArg = args["agent"];
  const agent =
    normalizeAgentArgument(typeof agentArg === "string" ? agentArg : null) ??
    resolveAgentName(ctx.configPath ?? undefined);
  const searchConfig = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });
  const result = await runMaintenance(ctx.vault, {
    now,
    holder: `${agent}@${process.pid}`,
    force: args["force"] === true,
    ...(window !== undefined ? { window } : {}),
    tasks: [
      {
        name: "dream",
        run: async () => {
          dream(ctx.vault, { now });
        },
      },
      {
        name: "reindex",
        run: async () => {
          await indexVault(searchConfig);
        },
      },
    ],
  });
  return { verdict: result.verdict, tasks: result.tasks };
}

// ----- brain_dead_ends (t_be62c62d) -----------------------------------------

/**
 * Negative-knowledge registry: record one tried-and-failed approach
 * or list the bounded active set, newest first.
 */
function toolBrainDeadEnds(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const op = args["operation"];
  if (op !== "record" && op !== "list") {
    throw new MCPError(INVALID_PARAMS, "brain_dead_ends: operation must be record|list");
  }
  if (op === "list") {
    const { entries, warnings } = listDeadEnds(ctx.vault);
    return { entries, warnings };
  }
  const approach = args["approach"];
  const reason = args["reason"];
  if (typeof approach !== "string" || approach.trim() === "") {
    throw new MCPError(INVALID_PARAMS, "brain_dead_ends record: approach must be non-empty");
  }
  if (typeof reason !== "string" || reason.trim() === "") {
    throw new MCPError(INVALID_PARAMS, "brain_dead_ends record: reason must be non-empty");
  }
  const agentArg = args["agent"];
  const agent =
    normalizeAgentArgument(typeof agentArg === "string" ? agentArg : null) ??
    resolveAgentName(ctx.configPath ?? undefined);
  const result = recordDeadEnd(ctx.vault, {
    approach,
    reason,
    ...(typeof args["context"] === "string" ? { context: args["context"] as string } : {}),
    agent,
    now: new Date(),
  });
  return { ok: true, id: result.entry.id, path: result.entry.path, archived: result.archived };
}

// ----- brain_truth (Entity Truth & Self-Improving Dream Suite) ---------------

/**
 * Operator/agent surface over the entity claim ledger: ingest one
 * claim, render slots/conflicts from the fold, aggregate exact-match
 * quantities, report cross-agent collisions. Read ops are pure folds
 * over the append-only ledger.
 */
function toolBrainTruth(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const op = args["operation"];
  if (
    op !== "ingest" &&
    op !== "slots" &&
    op !== "conflicts" &&
    op !== "aggregate" &&
    op !== "collisions"
  ) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_truth: operation must be ingest|slots|conflicts|aggregate|collisions",
    );
  }
  const requireStr = (name: string): string => {
    const value = args[name];
    if (typeof value !== "string" || value.trim() === "") {
      throw new MCPError(INVALID_PARAMS, `brain_truth ${op}: ${name} must be a non-empty string`);
    }
    return value;
  };

  if (op === "ingest") {
    const quantityValue = args["quantity_value"];
    if (
      (quantityValue === undefined || quantityValue === null) &&
      (typeof args["quantity_unit"] === "string" || typeof args["quantity_action"] === "string")
    ) {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_truth ingest: quantity_value is required when quantity_unit or quantity_action is provided",
      );
    }
    let quantity: { value: number; unit: string | null; action: string | null } | undefined;
    if (quantityValue !== undefined && quantityValue !== null) {
      if (typeof quantityValue !== "number" || !Number.isFinite(quantityValue)) {
        throw new MCPError(INVALID_PARAMS, "brain_truth ingest: quantity_value must be a number");
      }
      quantity = {
        value: quantityValue,
        unit: typeof args["quantity_unit"] === "string" ? (args["quantity_unit"] as string) : null,
        action:
          typeof args["quantity_action"] === "string" ? (args["quantity_action"] as string) : null,
      };
    }
    const agentArg = args["agent"];
    const agent =
      normalizeAgentArgument(typeof agentArg === "string" ? agentArg : null) ??
      resolveAgentName(ctx.configPath ?? undefined);
    const result = appendClaimEvent(ctx.vault, {
      ts: isoSecond(new Date()),
      agent,
      entity: requireStr("entity"),
      aspect: requireStr("aspect"),
      value: requireStr("value"),
      ...(quantity !== undefined ? { valueKind: "quantity" as const, quantity } : {}),
      source: requireStr("source"),
    });
    return {
      ok: true,
      entity: result.event.entity,
      aspect: result.event.aspect,
      path: result.path,
    };
  }

  const events = readClaimEvents(ctx.vault).events;
  if (op === "slots" || op === "conflicts") {
    const state = computeTruthStateWithConflicts(events);
    if (op === "conflicts") return { events: state.events, conflicts: state.conflicts };
    const entityFilter = args["entity"];
    const slots =
      typeof entityFilter === "string" && entityFilter.trim() !== ""
        ? state.slots.filter((s) => s.entity === normalizeEntityName(entityFilter))
        : state.slots;
    return { events: state.events, slots };
  }
  if (op === "aggregate") {
    const state = computeTruthStateWithConflicts(events);
    return {
      ...aggregateQuantities(state.slots, {
        action: requireStr("action"),
        unit: typeof args["unit"] === "string" ? (args["unit"] as string) : null,
        ...(typeof args["entity"] === "string" ? { entity: args["entity"] as string } : {}),
      }),
    };
  }
  return {
    collisions: detectAgentCollisions(events, { now: new Date() }),
  };
}

// ----- brain_concept_synthesis (v0.10.17) ----------------------------------

/**
 * Concept-scoped cluster envelope: target + all linkers (depth-1)
 * plus optionally unlinked mentions. Pure assembler; no LLM call.
 */
async function toolBrainConceptSynthesis(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const idRaw = args["id"];
  if (typeof idRaw !== "string" || idRaw.trim().length === 0) {
    throw new MCPError(INVALID_PARAMS, "brain_concept_synthesis: id must be a non-empty string");
  }
  const includeUnlinkedRaw = args["include_unlinked"];
  let includeUnlinked = false;
  if (includeUnlinkedRaw !== undefined && includeUnlinkedRaw !== null) {
    if (typeof includeUnlinkedRaw !== "boolean") {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_concept_synthesis: include_unlinked must be a boolean",
      );
    }
    includeUnlinked = includeUnlinkedRaw;
  }
  const targetId = normaliseWikilinkTarget(idRaw);
  const cluster = buildConceptCluster(ctx.vault, targetId, {
    includeUnlinked,
  });
  return {
    vault_path: ctx.vault,
    target_id: cluster.targetId,
    target_title: cluster.targetTitle,
    linkers: cluster.linkers,
    unlinked_mentions: cluster.unlinkedMentions,
    generated_at: cluster.generatedAt,
  };
}

// ----- brain_moc_audit (v0.10.17) ------------------------------------------

/**
 * Per-MOC coverage audit. Classifies cluster members into
 * `wellCovered` / `fragile` / `candidateMissing` and surfaces a
 * `suggestedNext` candidate. MOC detection is purely structural -
 * outbound link count + link density.
 */
async function toolBrainMocAudit(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const idRaw = args["id"];
  if (typeof idRaw !== "string" || idRaw.trim().length === 0) {
    throw new MCPError(INVALID_PARAMS, "brain_moc_audit: id must be a non-empty string");
  }
  const targetId = normaliseWikilinkTarget(idRaw);
  try {
    const report = auditMoc(ctx.vault, targetId);
    return {
      vault_path: ctx.vault,
      hub_id: report.hubId,
      outbound_count: report.outboundCount,
      well_covered: report.wellCovered,
      fragile: report.fragile,
      candidate_missing: report.candidateMissing,
      ...(report.suggestedNext ? { suggested_next: report.suggestedNext } : {}),
    };
  } catch (err) {
    if (err instanceof MocAuditError) {
      throw new MCPError(INVALID_PARAMS, `brain_moc_audit: ${err.message}`);
    }
    throw err;
  }
}

// ----- Temporal subsystem MCP wrappers (v0.10.18) --------------------------

function coercePositiveInteger(tool: string, field: string, raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 1) {
      throw new MCPError(INVALID_PARAMS, `${tool}: ${field} must be a positive integer`);
    }
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "" || !/^[0-9]+$/.test(trimmed)) {
      throw new MCPError(INVALID_PARAMS, `${tool}: ${field} must be a positive integer`);
    }
    const parsed = Number.parseInt(trimmed, 10);
    if (parsed < 1) {
      throw new MCPError(INVALID_PARAMS, `${tool}: ${field} must be a positive integer`);
    }
    return parsed;
  }
  throw new MCPError(INVALID_PARAMS, `${tool}: ${field} must be a positive integer`);
}

const ISO_DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

function coerceIsoTimestampOrDate(
  tool: string,
  field: string,
  raw: unknown,
  shape: "date-only" | "date-or-timestamp" = "date-or-timestamp",
): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new MCPError(
      INVALID_PARAMS,
      `${tool}: ${field} must be an ISO date${shape === "date-or-timestamp" ? " or ISO timestamp" : " (YYYY-MM-DD)"}`,
    );
  }
  const v = raw.trim();
  if (shape === "date-only" && !ISO_DATE_ONLY_RE.test(v)) {
    throw new MCPError(
      INVALID_PARAMS,
      `${tool}: ${field} must be an ISO date (YYYY-MM-DD); got ${JSON.stringify(v)}`,
    );
  }
  // Validate by parsing - rejects "2026-13-99" / "garbage" / etc.
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) {
    throw new MCPError(
      INVALID_PARAMS,
      `${tool}: ${field} must be a parseable ISO date${shape === "date-or-timestamp" ? " or timestamp" : ""}; got ${JSON.stringify(v)}`,
    );
  }
  return v;
}

function coerceEventKind(tool: string, raw: unknown): BrainLogEventKind | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string") {
    throw new MCPError(INVALID_PARAMS, `${tool}: kind must be a string`);
  }
  if (!isBrainLogEventKind(raw)) {
    throw new MCPError(INVALID_PARAMS, `${tool}: kind must be a known BrainLogEventKind`);
  }
  return raw;
}

/**
 * `brain_timeline` - frozen chronological list of events filtered by
 * any combination of `pref_id`, `topic`, `kind`, `since`, `until`,
 * `limit`. Pure read.
 */
async function toolBrainTimeline(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const prefId = typeof args["pref_id"] === "string" ? args["pref_id"] : undefined;
  const topic = typeof args["topic"] === "string" ? args["topic"] : undefined;
  const kind = coerceEventKind("brain_timeline", args["kind"]);
  const since = coerceIsoTimestampOrDate("brain_timeline", "since", args["since"]);
  const until = coerceIsoTimestampOrDate("brain_timeline", "until", args["until"]);
  const limit = coercePositiveInteger("brain_timeline", "limit", args["limit"]);

  const index = buildTimelineIndex(ctx.vault, {
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
  });
  const events = selectEvents(index, {
    ...(prefId !== undefined ? { prefId } : {}),
    ...(topic !== undefined ? { topic } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
  });
  const sliced = limit !== undefined ? events.slice(0, limit) : events;
  return {
    vault_path: ctx.vault,
    window: index.window,
    total: events.length,
    events: sliced.map((ev) => ({
      at: ev.at,
      kind: ev.kind,
      source: ev.source,
      ...(ev.prefId !== undefined ? { pref_id: ev.prefId } : {}),
      ...(ev.topic !== undefined ? { topic: ev.topic } : {}),
      ...(ev.result !== undefined ? { result: ev.result } : {}),
      ...(ev.artifact !== undefined ? { artifact: ev.artifact } : {}),
      ...(ev.reason !== undefined ? { reason: ev.reason } : {}),
      ...(ev.text !== undefined ? { text: ev.text } : {}),
    })),
  };
}

/**
 * `brain_belief_evolution` - per-pref / per-topic chronological story:
 * status transitions, evidence rollup with running counts, and
 * retirement chain.
 */
async function toolBrainBeliefEvolution(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const prefIdRaw = args["pref_id"];
  const topicRaw = args["topic"];
  const hasPref = typeof prefIdRaw === "string" && prefIdRaw.trim().length > 0;
  const hasTopic = typeof topicRaw === "string" && topicRaw.trim().length > 0;
  if (hasPref === hasTopic) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_belief_evolution: exactly one of pref_id or topic is required",
    );
  }
  const target = hasPref
    ? { prefId: (prefIdRaw as string).trim() }
    : { topic: (topicRaw as string).trim() };
  const index = buildTimelineIndex(ctx.vault, {});
  const evo = buildBeliefEvolution(index, ctx.vault, target);
  return {
    vault_path: ctx.vault,
    target: evo.target,
    transitions: evo.transitions,
    evidence: evo.evidence,
    retirements: evo.retirements,
    generated_at: evo.generatedAt,
  };
}

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

/**
 * `brain_daily_brief` - structured counters + transitions + source
 * pointers for one day. Defaults `date` to today UTC when omitted.
 */
async function toolBrainDailyBrief(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const dateRaw = args["date"];
  const dateCoerced = coerceIsoTimestampOrDate("brain_daily_brief", "date", dateRaw, "date-only");
  const date = dateCoerced ?? new Date().toISOString().slice(0, 10);
  const cfg = loadTemporalConfigSafe(ctx.vault);
  const index = buildTimelineIndex(ctx.vault, {});
  const brief = buildDailyBrief(index, ctx.vault, date, {
    offsetHours: cfg.daily_window_offset_hours,
  });
  return {
    vault_path: ctx.vault,
    date: brief.date,
    window: brief.window,
    events_by_kind: brief.eventsByKind,
    status_transitions: brief.statusTransitions,
    vault_delta: brief.vaultDelta,
    source_pointers: brief.sourcePointers,
    generated_at: brief.generatedAt,
  };
}

/**
 * `brain_weekly_synthesis` - 7-day deterministic summary plus retired
 * and contradictions lists.
 */
async function toolBrainWeeklySynthesis(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const weekEndRaw = args["week_end"];
  const weekEndCoerced = coerceIsoTimestampOrDate(
    "brain_weekly_synthesis",
    "week_end",
    weekEndRaw,
    "date-only",
  );
  const weekEnd = weekEndCoerced ?? new Date().toISOString().slice(0, 10);
  const cfg = loadTemporalConfigSafe(ctx.vault);
  const index = buildTimelineIndex(ctx.vault, {});
  const synth = buildWeeklySynthesis(index, ctx.vault, weekEnd, cfg);
  return {
    vault_path: ctx.vault,
    window_start: synth.windowStart,
    window_end: synth.windowEnd,
    events_by_kind: synth.eventsByKind,
    status_transitions: synth.statusTransitions,
    retired: synth.retired,
    contradictions: synth.contradictions,
    vault_delta: synth.vaultDelta,
    source_pointers: synth.sourcePointers,
    generated_at: synth.generatedAt,
  };
}

// ----- brain_intention (Agent Surface Suite) --------------------------------

function toolBrainIntention(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const operation = coerceStr(args, "operation", true)!;
  if (operation === "list") {
    return {
      intentions: listIntentions(ctx.vault).map((chain) => ({
        scope: chain.scope,
        version: chain.version,
        updated_at: chain.updatedAt,
        text: chain.text,
      })),
    };
  }
  const scope = coerceStr(args, "scope", true)!;
  if (operation === "set") {
    const text = coerceStr(args, "text", true)!;
    const chain = setIntention(ctx.vault, {
      scope,
      text,
      agent: resolveAgentName(ctx.configPath ?? undefined),
    });
    return { operation, scope: chain.scope, version: chain.version, path: chain.path };
  }
  if (operation === "show") {
    const chain = showIntention(ctx.vault, scope);
    if (chain === null) return { operation, scope, present: false };
    return {
      operation,
      scope: chain.scope,
      present: true,
      version: chain.version,
      updated_at: chain.updatedAt,
      text: chain.text,
      history: chain.history,
      path: chain.path,
    };
  }
  if (operation === "move") {
    const moved = moveIntentionToHistory(ctx.vault, { scope });
    return { operation, scope: moved.scope, archive_path: moved.archivePath };
  }
  throw new MCPError(
    INVALID_PARAMS,
    "brain_intention operation must be one of: set, show, list, move",
  );
}

// ----- brain_trigger (Workspace Insight Suite) ------------------------------

function triggerToJson(record: TriggerRecord): Record<string, unknown> {
  return {
    id: record.id,
    kind: record.kind,
    status: record.effectiveStatus,
    urgency: record.urgency,
    reason: record.reason,
    suggested_action: record.suggestedAction,
    source_artifacts: record.sourceArtifacts,
    cooldown_key: record.cooldownKey,
    created_at: record.createdAt,
    expires_at: record.expiresAt,
    delivered_at: record.deliveredAt,
    resolved_at: record.resolvedAt,
  };
}

const TRIGGER_TERMINAL = new Set(["acted", "dismissed", "expired"]);

function toolBrainTrigger(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const operation = coerceStr(args, "operation", true)!;
  const now = new Date();
  if (operation === "scan") {
    const cooldownDays = resolveTriggerCooldownDays(ctx.configPath ?? undefined);
    const result = scanTriggers(ctx.vault, { now, cooldownDays });
    return {
      operation,
      candidates: result.candidates,
      created: result.created.map(triggerToJson),
      skipped: result.skipped.map((skip) => ({
        cooldown_key: skip.cooldownKey,
        reason: skip.reason,
      })),
    };
  }
  if (operation === "list" || operation === "history") {
    const statusRaw = coerceStr(args, "status", false);
    if (statusRaw !== null && statusRaw !== undefined && !isTriggerStatus(statusRaw)) {
      throw new MCPError(INVALID_PARAMS, `brain_trigger: unknown status '${statusRaw}'`);
    }
    let records = listTriggers(ctx.vault, {
      now,
      ...(statusRaw ? { status: statusRaw } : {}),
    });
    if (operation === "history") {
      records = records.filter((record) => TRIGGER_TERMINAL.has(record.effectiveStatus));
    } else if (!statusRaw) {
      records = records.filter((record) => !TRIGGER_TERMINAL.has(record.effectiveStatus));
    }
    return { operation, triggers: records.map(triggerToJson) };
  }
  if (operation === "acknowledge" || operation === "dismiss" || operation === "act") {
    const id = coerceStr(args, "id", true)!;
    try {
      return {
        operation,
        trigger: triggerToJson(transitionTrigger(ctx.vault, id, operation, { now })),
      };
    } catch (err) {
      throw new MCPError(INVALID_PARAMS, `brain_trigger: ${(err as Error).message}`);
    }
  }
  throw new MCPError(
    INVALID_PARAMS,
    "brain_trigger operation must be one of: scan, list, history, acknowledge, dismiss, act",
  );
}

// ----- brain_deep_synthesis (Workspace Insight Suite) -----------------------

async function toolBrainDeepSynthesis(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const topic = coerceStr(args, "topic", true)!;
  const limit = optionalPositiveInt(args, "limit", "brain_deep_synthesis") ?? 30;
  if (limit > 100) {
    throw new MCPError(INVALID_PARAMS, "brain_deep_synthesis: limit must be at most 100");
  }
  const enqueue = coerceBool(args, "triggers");
  const now = new Date();
  const searchConfig = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });
  const report = await deepSynthesis(searchConfig, topic, { now, limit });
  let triggersCreated: number | undefined;
  if (enqueue) {
    const result = createTriggers(ctx.vault, synthesisCandidates(report), {
      now,
      cooldownDays: resolveTriggerCooldownDays(ctx.configPath ?? undefined),
    });
    triggersCreated = result.created.length;
  }
  return {
    topic: report.topic,
    generated_at: report.generatedAt,
    checked: report.checked,
    notes: report.notes,
    agreements: report.agreements,
    contradictions: report.contradictions,
    stale_claims: report.staleClaims.map((s) => ({
      path: s.path,
      age_days: s.ageDays,
      superseded_by: s.supersededBy,
    })),
    gaps: report.gaps,
    contaminated: report.contaminated,
    ...(triggersCreated !== undefined ? { triggers_created: triggersCreated } : {}),
  };
}

// ----- brain_idea_discovery (Workspace Insight Suite) ------------------------

function toolBrainIdeaDiscovery(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const cap = optionalPositiveInt(args, "cap", "brain_idea_discovery") ?? 5;
  if (cap > 50) {
    throw new MCPError(INVALID_PARAMS, "brain_idea_discovery: cap must be at most 50");
  }
  const enqueue = coerceBool(args, "triggers");
  const now = new Date();
  const ideas = discoverIdeas(ctx.vault, { now, cap });
  let triggersCreated: number | undefined;
  if (enqueue) {
    const result = createTriggers(ctx.vault, ideaCandidates(ideas), {
      now,
      cooldownDays: resolveTriggerCooldownDays(ctx.configPath ?? undefined),
    });
    triggersCreated = result.created.length;
  }
  return {
    ideas: ideas.map((idea) => ({
      kind: idea.kind,
      title: idea.title,
      reason: idea.reason,
      score: idea.score,
      source_artifacts: idea.sourceArtifacts,
    })),
    ...(triggersCreated !== undefined ? { triggers_created: triggersCreated } : {}),
  };
}

// ----- brain_context_pack (v0.10.15) ---------------------------------------

/**
 * Bounded-token vault slice ordered by importance tier then recency.
 * Lets an agent prime its context window under a strict budget.
 */
async function toolBrainContextPack(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const maxRaw = args["max_tokens"];
  const maxTokens =
    typeof maxRaw === "number"
      ? maxRaw
      : typeof maxRaw === "string" && /^[0-9]+$/.test(maxRaw.trim())
        ? Number.parseInt(maxRaw.trim(), 10)
        : Number.NaN;
  if (!Number.isInteger(maxTokens) || maxTokens <= 0) {
    throw new MCPError(INVALID_PARAMS, "brain_context_pack: max_tokens must be a positive integer");
  }
  const query = typeof args["query"] === "string" ? (args["query"] as string) : undefined;
  const includeLanes = coerceBool(args, "lanes");
  const cacheStable = coerceBool(args, "cache_stable");
  const dedupRepeated = coerceBool(args, "dedup_repeated");
  const attentionFlowIds = coerceStrList(args, "attention_flow_ids");
  const maxCharsPerMemory = optionalPositiveInt(args, "max_chars_per_memory", "brain_context_pack");
  const maxTotalChars = optionalPositiveInt(args, "max_total_chars", "brain_context_pack");
  const receipt = receiptOptionsFromArgs("brain_context_pack", args, "context_pack", "mcp");
  const telemetry = telemetryOptionsFromArgs("brain_context_pack", args, "mcp");
  // Focus wiring (Agent Surface Suite, t_5b478e47): gated on the
  // search_focus_context_pack config key (default off) so the default
  // pack stays byte-identical. Fail-soft - a broken search config
  // never breaks the pack.
  let sessionFocus: ReturnType<typeof readActiveSessionFocus> = null;
  if (resolveSearchFocusContextPack(ctx.configPath ?? undefined)) {
    // Argument validation stays OUTSIDE the fail-soft block: an invalid
    // focus_session is a caller error (INVALID_PARAMS), not a config
    // read to swallow.
    const focusSession = coerceStr(args, "focus_session", false) ?? undefined;
    try {
      const searchConfig = resolveSearchConfig({
        vault: ctx.vault,
        configPath: ctx.configPath ?? undefined,
      });
      sessionFocus = readActiveSessionFocus(searchConfig, focusSession);
    } catch {
      sessionFocus = null;
    }
  }
  const report = packContext(ctx.vault, {
    maxTokens,
    ...(sessionFocus !== null ? { sessionFocus } : {}),
    ...(query ? { query } : {}),
    ...(includeLanes ? { includeLanes: true } : {}),
    ...(receipt !== undefined ? { receipt } : {}),
    ...(cacheStable || dedupRepeated
      ? {
          transforms: {
            ...(cacheStable ? { cacheStableOrdering: true } : {}),
            ...(dedupRepeated ? { deduplicateRepeatedContext: true } : {}),
          },
        }
      : {}),
    ...(maxCharsPerMemory !== undefined ? { maxCharsPerMemory } : {}),
    ...(maxTotalChars !== undefined ? { maxTotalChars } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
    ...(attentionFlowIds.length > 0 ? { attentionFlowIds } : {}),
  });
  return {
    vault_path: ctx.vault,
    max_tokens: report.maxTokens,
    tokens_used: report.tokensUsed,
    items: report.items.map((i) => ({
      id: i.id,
      path: i.path,
      tier: i.tier,
      tokens: i.tokens,
      body: i.body,
      trimmed: i.trimmed,
      ...(i.originalRank !== undefined ? { original_rank: i.originalRank } : {}),
      ...(i.stableRank !== undefined ? { stable_rank: i.stableRank } : {}),
      ...(i.dedupedFrom !== undefined ? { deduped_from: i.dedupedFrom } : {}),
      ...(i.referenceHint !== undefined ? { reference_hint: i.referenceHint } : {}),
      ...(i.safety ? { safety: i.safety } : {}),
    })),
    skipped: report.skipped.map((s) => ({
      id: s.id,
      tokens: s.tokens,
      reason: s.reason,
    })),
    ...(report.receiptId ? { receipt_id: report.receiptId } : {}),
    ...(report.telemetryId ? { telemetry_id: report.telemetryId } : {}),
    ...(report.lanes ? { lanes: report.lanes } : {}),
  };
}

// ----- brain_context_receipts ---------------------------------------------

async function toolBrainContextReceipts(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = optionalStringArg("brain_context_receipts", args, "operation");
  if (operation === "list") {
    const trigger = optionalStringArg("brain_context_receipts", args, "trigger");
    if (trigger !== undefined && !isContextReceiptTrigger(trigger)) {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_context_receipts: trigger must be context_pack or pre_compress",
      );
    }
    const host = optionalStringArg("brain_context_receipts", args, "host");
    const sessionId = optionalStringArg("brain_context_receipts", args, "session_id");
    const limit = coercePositiveInteger("brain_context_receipts", "limit", args["limit"]);
    const receipts = listContextReceipts(ctx.vault, {
      ...(trigger !== undefined ? { trigger } : {}),
      ...(host !== undefined ? { host } : {}),
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(limit !== undefined ? { limit } : {}),
    });
    const summaries = receipts.map(summarizeContextReceipt);
    return {
      vault_path: ctx.vault,
      total: summaries.length,
      receipts: summaries,
    };
  }

  if (operation === "show") {
    const id = optionalStringArg("brain_context_receipts", args, "id");
    if (id === undefined) {
      throw new MCPError(INVALID_PARAMS, "brain_context_receipts: id is required for show");
    }
    const receipt = getContextReceipt(ctx.vault, id);
    if (receipt === null) {
      throw new MCPError(INVALID_PARAMS, `brain_context_receipts: receipt not found: ${id}`);
    }
    return {
      id: receipt.id,
      kind: receipt.kind,
      createdAt: receipt.createdAt,
      sourceRefs: receipt.sourceRefs,
      payload: receipt.payload,
      private: receipt.private,
      redacted: receipt.redacted,
    };
  }

  throw new MCPError(INVALID_PARAMS, "brain_context_receipts: operation must be list or show");
}

function optionalStringArg(
  tool: string,
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const raw = args[key];
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new MCPError(INVALID_PARAMS, `${tool}: ${key} must be a non-empty string`);
  }
  return raw.trim();
}

function requiredStringArg(tool: string, args: Record<string, unknown>, key: string): string {
  const value = optionalStringArg(tool, args, key);
  if (value === undefined) throw new MCPError(INVALID_PARAMS, `${tool}: ${key} is required`);
  return value;
}

// ----- brain_recall_telemetry ---------------------------------------------

async function toolBrainRecallTelemetry(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = optionalStringArg("brain_recall_telemetry", args, "operation");
  const filter = recallTelemetryFilter(args);

  if (operation === "list") {
    const records = listRecallTelemetry(ctx.vault, filter);
    return { vault_path: ctx.vault, total: records.length, records };
  }
  if (operation === "summary") {
    const summary = summarizeRecallTelemetry(ctx.vault, filter);
    return { ...summary };
  }
  // Gate-decision telemetry (Workspace Insight Suite, t_65036e02):
  // records emitted by brain_recall_gate when recall_gate_telemetry is on.
  if (operation === "gate_list") {
    const records = listGateTelemetry(ctx.vault, {
      ...(filter.host !== undefined ? { host: filter.host } : {}),
      ...(filter.since !== undefined ? { since: filter.since } : {}),
      ...(filter.until !== undefined ? { until: filter.until } : {}),
      ...(filter.limit !== undefined ? { limit: filter.limit } : {}),
    });
    return { vault_path: ctx.vault, total: records.length, records };
  }
  if (operation === "gate_summary") {
    const summary = summarizeGateTelemetry(ctx.vault, {
      ...(filter.host !== undefined ? { host: filter.host } : {}),
      ...(filter.since !== undefined ? { since: filter.since } : {}),
      ...(filter.until !== undefined ? { until: filter.until } : {}),
    });
    return { ...summary };
  }
  throw new MCPError(
    INVALID_PARAMS,
    "brain_recall_telemetry: operation must be list, summary, gate_list, or gate_summary",
  );
}

function recallTelemetryFilter(args: Record<string, unknown>): RecallTelemetryFilter {
  const mode = coerceRecallTelemetryMode(args["mode"]);
  const status = coerceRecallTelemetryStatus(args["status"]);
  const host = optionalStringArg("brain_recall_telemetry", args, "host");
  const since = optionalStringArg("brain_recall_telemetry", args, "since");
  const until = optionalStringArg("brain_recall_telemetry", args, "until");
  const limit = coercePositiveInteger("brain_recall_telemetry", "limit", args["limit"]);
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function coerceRecallTelemetryMode(raw: unknown): RecallTelemetryMode | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = typeof raw === "string" ? raw.trim() : raw;
  if (!isRecallTelemetryMode(trimmed)) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_recall_telemetry: mode must be search, context_pack, or pre_compress",
    );
  }
  return trimmed;
}

function coerceRecallTelemetryStatus(raw: unknown): RecallTelemetryStatus | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = typeof raw === "string" ? raw.trim() : raw;
  if (!isRecallTelemetryStatus(trimmed)) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_recall_telemetry: status must be ok, empty, error, or timeout",
    );
  }
  return trimmed;
}

// ----- brain_context_presets ----------------------------------------------

async function toolBrainContextPresets(
  _ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = optionalStringArg("brain_context_presets", args, "operation");
  if (operation === "show") {
    const presetId = optionalStringArg("brain_context_presets", args, "preset_id");
    const result =
      presetId === undefined ? { presets: listContextPresets() } : getContextPreset(presetId);
    if (result === null) {
      throw new MCPError(INVALID_PARAMS, `brain_context_presets: unknown preset ${presetId}`);
    }
    return Array.isArray(result) ? { presets: result } : { ...result };
  }
  if (operation === "suggest") {
    const model = optionalStringArg("brain_context_presets", args, "model");
    const window = coercePositiveInteger(
      "brain_context_presets",
      "context_window_tokens",
      args["context_window_tokens"],
    );
    return {
      ...suggestContextPreset({
        ...(model !== undefined ? { model } : {}),
        ...(window !== undefined ? { contextWindowTokens: window } : {}),
      }),
    };
  }
  if (operation === "diff") {
    const presetId = optionalStringArg("brain_context_presets", args, "preset_id");
    if (presetId === undefined) {
      throw new MCPError(INVALID_PARAMS, "brain_context_presets: preset_id is required for diff");
    }
    return {
      ...diffContextPreset(presetId, contextPresetCurrentConfig(args["current"])),
    };
  }
  throw new MCPError(
    INVALID_PARAMS,
    "brain_context_presets: operation must be show, suggest, or diff",
  );
}

function contextPresetCurrentConfig(raw: unknown): ContextPresetCurrentConfig {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new MCPError(INVALID_PARAMS, "brain_context_presets: current must be an object");
  }
  return raw as ContextPresetCurrentConfig;
}

// ----- brain_pre_compact_extract ------------------------------------------

async function toolBrainPreCompactExtract(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sessionId = requiredStringArg("brain_pre_compact_extract", args, "session_id");
  const turnStart = requiredStringArg("brain_pre_compact_extract", args, "turn_start");
  const turnEnd = requiredStringArg("brain_pre_compact_extract", args, "turn_end");
  const text = requiredStringArg("brain_pre_compact_extract", args, "text");
  const maxChars = coercePositiveInteger(
    "brain_pre_compact_extract",
    "max_chars",
    args["max_chars"],
  );
  const result = extractPreCompactRecords(ctx.vault, {
    sessionId,
    turnStart,
    turnEnd,
    text,
    ...(optionalStringArg("brain_pre_compact_extract", args, "host") !== undefined
      ? { host: optionalStringArg("brain_pre_compact_extract", args, "host") }
      : {}),
    ...(maxChars !== undefined ? { maxChars } : {}),
  });
  return { count: result.records.length, ...result };
}

// ----- session recall DAG --------------------------------------------------

async function toolBrainSessionGrep(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const limit = coercePositiveInteger("brain_session_grep", "limit", args["limit"]);
  const snippetChars = coercePositiveInteger(
    "brain_session_grep",
    "snippet_chars",
    args["snippet_chars"],
  );
  return {
    ...searchSessionRecall(ctx.vault, {
      query: requiredStringArg("brain_session_grep", args, "query"),
      ...(optionalStringArg("brain_session_grep", args, "session_id") !== undefined
        ? {
            sessionId: optionalStringArg("brain_session_grep", args, "session_id"),
          }
        : {}),
      ...(limit !== undefined ? { limit } : {}),
      ...(snippetChars !== undefined ? { snippetChars } : {}),
    }),
  };
}

async function toolBrainSessionDescribe(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return {
    ...describeSessionRecall(ctx.vault, {
      sessionId: requiredStringArg("brain_session_describe", args, "session_id"),
    }),
  };
}

async function toolBrainSessionExpand(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const rawLimit = coercePositiveInteger("brain_session_expand", "raw_limit", args["raw_limit"]);
  return {
    ...expandSessionRecall(ctx.vault, {
      id: requiredStringArg("brain_session_expand", args, "id"),
      ...(rawLimit !== undefined ? { rawLimit } : {}),
      ...(optionalStringArg("brain_session_expand", args, "cursor") !== undefined
        ? { cursor: optionalStringArg("brain_session_expand", args, "cursor") }
        : {}),
    }),
  };
}

// ----- brain_pre_compress_pack (v0.20.0) -----------------------------------

/** Parse an optional positive-integer arg, throwing INVALID_PARAMS otherwise. */
function optionalPositiveInt(
  args: Record<string, unknown>,
  key: string,
  tool: string,
): number | undefined {
  const raw = args[key];
  if (raw === undefined) return undefined;
  const n =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^[0-9]+$/.test(raw.trim())
        ? Number.parseInt(raw.trim(), 10)
        : Number.NaN;
  if (!Number.isInteger(n) || n <= 0) {
    throw new MCPError(INVALID_PARAMS, `${tool}: ${key} must be a positive integer`);
  }
  return n;
}

/**
 * Read-only bundle of the highest-confidence confirmed preferences plus
 * the head of active.md, rendered as a system-prompt addendum for a host
 * runtime to inject just before a context-compression event.
 */
async function toolBrainPreCompressPack(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const topK = optionalPositiveInt(args, "top_k", "brain_pre_compress_pack") ?? 10;
  const maxCharsPerMemory = optionalPositiveInt(
    args,
    "max_chars_per_memory",
    "brain_pre_compress_pack",
  );
  const maxTotalChars = optionalPositiveInt(args, "max_total_chars", "brain_pre_compress_pack");
  const receipt = receiptOptionsFromArgs("brain_pre_compress_pack", args, "pre_compress", "mcp");
  const telemetry = telemetryOptionsFromArgs("brain_pre_compress_pack", args, "mcp");
  const pack = buildPreCompressPack(ctx.vault, {
    topK,
    ...(maxCharsPerMemory !== undefined ? { maxCharsPerMemory } : {}),
    ...(maxTotalChars !== undefined ? { maxTotalChars } : {}),
    ...(receipt !== undefined ? { receipt } : {}),
    ...(telemetry !== undefined ? { telemetry } : {}),
  });
  return {
    vault_path: ctx.vault,
    text: pack.text,
    active_head_included: pack.activeHeadIncluded,
    ...(pack.activeHeadSafety ? { active_head_safety: pack.activeHeadSafety } : {}),
    total_chars: pack.totalChars,
    ...(pack.receiptId ? { receipt_id: pack.receiptId } : {}),
    ...(pack.telemetryId ? { telemetry_id: pack.telemetryId } : {}),
    items: pack.items.map((i) => ({
      id: i.id,
      principle: i.principle,
      trimmed: i.trimmed,
      ...(i.safety ? { safety: i.safety } : {}),
    })),
  };
}

function receiptOptionsFromArgs(
  tool: string,
  args: Record<string, unknown>,
  trigger: "context_pack" | "pre_compress",
  defaultHost: string,
): ContextReceiptOptions | undefined {
  if (!coerceBool(args, "receipt")) return undefined;
  return {
    host: optionalStringArg(tool, args, "receipt_host") ?? defaultHost,
    trigger,
    ...(optionalStringArg(tool, args, "session_id") !== undefined
      ? { sessionId: optionalStringArg(tool, args, "session_id") }
      : {}),
    ...(optionalStringArg(tool, args, "turn_id") !== undefined
      ? { turnId: optionalStringArg(tool, args, "turn_id") }
      : {}),
  };
}

function telemetryOptionsFromArgs(
  tool: string,
  args: Record<string, unknown>,
  defaultHost: string,
): RecallTelemetryOptions | undefined {
  if (!coerceBool(args, "telemetry")) return undefined;
  return {
    host: optionalStringArg(tool, args, "telemetry_host") ?? defaultHost,
    ...(optionalStringArg(tool, args, "session_id") !== undefined
      ? { sessionId: optionalStringArg(tool, args, "session_id") }
      : {}),
    ...(optionalStringArg(tool, args, "turn_id") !== undefined
      ? { turnId: optionalStringArg(tool, args, "turn_id") }
      : {}),
  };
}

async function toolBrainSkillProposals(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = requiredStringArg("brain_skill_proposals", args, "operation");
  if (operation === "learn") {
    const minSupport = optionalPositiveInt(args, "min_support", "brain_skill_proposals");
    const result =
      minSupport !== undefined
        ? learnSkillProposals(ctx.vault, { minSupport })
        : learnSkillProposals(ctx.vault);
    return { ...result };
  }
  if (operation === "list") {
    const proposals = listPendingSkillProposals(ctx.vault);
    return { total: proposals.length, proposals };
  }
  if (operation === "accept") {
    const slug = requiredStringArg("brain_skill_proposals", args, "slug");
    const note = optionalStringArg("brain_skill_proposals", args, "note");
    const reviewed = note
      ? acceptSkillProposal(ctx.vault, slug, { note })
      : acceptSkillProposal(ctx.vault, slug);
    return { ...reviewed };
  }
  if (operation === "reject") {
    const slug = requiredStringArg("brain_skill_proposals", args, "slug");
    const note = requiredStringArg("brain_skill_proposals", args, "note");
    const reviewed = rejectSkillProposal(ctx.vault, slug, { note });
    return { ...reviewed };
  }
  throw new MCPError(
    INVALID_PARAMS,
    "brain_skill_proposals: operation must be one of learn|list|accept|reject",
  );
}

async function toolBrainProceduralMemory(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = requiredStringArg("brain_procedural_memory", args, "operation");
  if (operation === "reconcile") {
    const roots = coerceStrList(args, "roots");
    const effectiveRoots =
      roots.length > 0
        ? roots
        : [
            join(ctx.vault, "Brain", "procedures"),
            join(ctx.vault, "skills"),
            join(ctx.vault, "runbooks"),
          ];
    return {
      ...reconcileProceduralMemory(ctx.vault, { roots: effectiveRoots }),
    };
  }
  if (operation === "list") {
    const entries = listProceduralMemory(ctx.vault);
    return { total: entries.length, entries };
  }
  if (operation === "mark_used") {
    const id = requiredStringArg("brain_procedural_memory", args, "id");
    const updated = markProceduralMemoryUsed(ctx.vault, id);
    if (!updated) {
      throw new MCPError(INVALID_PARAMS, `brain_procedural_memory: unknown entry id: ${id}`);
    }
    return { ...updated };
  }
  throw new MCPError(
    INVALID_PARAMS,
    "brain_procedural_memory: operation must be one of reconcile|list|mark_used",
  );
}

async function toolBrainRecurrence(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = requiredStringArg("brain_recurrence", args, "operation");
  if (operation === "list") {
    const entries = listRecurrenceEntries(ctx.vault);
    return { total: entries.length, entries };
  }
  if (operation === "show") {
    const contentHash = requiredStringArg("brain_recurrence", args, "content_hash");
    const entry = getRecurrenceEntry(ctx.vault, contentHash);
    if (!entry) {
      throw new MCPError(INVALID_PARAMS, `brain_recurrence: unknown content hash: ${contentHash}`);
    }
    return { ...entry };
  }
  if (operation === "learn" || operation === "forget") {
    const contentHash = requiredStringArg("brain_recurrence", args, "content_hash");
    const scope = requiredStringArg("brain_recurrence", args, "scope");
    const sourceId = requiredStringArg("brain_recurrence", args, "source_id");
    const entry = applyRecurrenceEvidence(ctx.vault, {
      contentHash,
      scope,
      sourceId,
      action: operation,
    });
    return { operation, entry };
  }
  if (operation === "purge_source") {
    const sourceId = requiredStringArg("brain_recurrence", args, "source_id");
    purgeRecurrenceSource(ctx.vault, sourceId);
    return { ok: true, source_id: sourceId };
  }
  throw new MCPError(
    INVALID_PARAMS,
    "brain_recurrence: operation must be one of list|show|learn|forget|purge_source",
  );
}

async function toolBrainProceduralGraph(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = requiredStringArg("brain_procedural_graph", args, "operation");
  if (operation === "rebuild") {
    const graph = rebuildProceduralGraph(ctx.vault);
    const hints = rebuildProceduralHints(ctx.vault, { graph });
    return {
      operation,
      graph: {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        generated_at: graph.generated_at,
      },
      hints: {
        entries: hints.entries.length,
        generated_at: hints.generated_at,
      },
    };
  }
  if (operation === "show") {
    const graph = readProceduralGraph(ctx.vault);
    if (!graph) {
      throw new MCPError(INVALID_PARAMS, "brain_procedural_graph: graph projection not found");
    }
    return { ...graph };
  }
  if (operation === "hints") {
    const hints = readProceduralHints(ctx.vault);
    if (!hints) {
      throw new MCPError(INVALID_PARAMS, "brain_procedural_graph: hints projection not found");
    }
    return { ...hints };
  }
  throw new MCPError(
    INVALID_PARAMS,
    "brain_procedural_graph: operation must be one of rebuild|show|hints",
  );
}

async function toolBrainAttentionFlows(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = requiredStringArg("brain_attention_flows", args, "operation");
  if (operation === "list") {
    const flows = listAttentionFlows(ctx.vault);
    return { total: flows.length, flows };
  }
  if (operation === "evaluate") {
    const flowId = requiredStringArg("brain_attention_flows", args, "flow_id");
    const report = evaluateAttentionFlow(ctx.vault, flowId);
    return { ...report };
  }
  if (operation === "render") {
    const flowId = requiredStringArg("brain_attention_flows", args, "flow_id");
    return {
      flow_id: flowId,
      text: renderAttentionFlow(ctx.vault, flowId),
    };
  }
  throw new MCPError(
    INVALID_PARAMS,
    "brain_attention_flows: operation must be one of list|evaluate|render",
  );
}

async function toolMcpLandscape(ctx: ServerContext): Promise<Record<string, unknown>> {
  const landscape = buildMcpLandscape(ctx.vault);
  return {
    vault_path: ctx.vault,
    servers: landscape.servers.map((s) => ({
      name: s.name,
      source: s.source,
      packages: s.packages,
      env: s.env,
    })),
  };
}

// ----- Consolidated view tools (token-diet, t_3920db77) ---------------------

const BRIEF_VIEW_HANDLERS: Readonly<
  Record<string, (ctx: ServerContext, args: Record<string, unknown>) => Promise<unknown> | unknown>
> = Object.freeze({
  morning: toolBrainMorningBrief,
  daily: toolBrainDailyBrief,
  weekly: toolBrainWeeklySynthesis,
  monthly: toolBrainMonthlyReview,
  operator: toolBrainOperatorSummary,
  digest: toolBrainDigest,
});

const ANALYTICS_VIEW_HANDLERS: Readonly<
  Record<string, (ctx: ServerContext, args: Record<string, unknown>) => Promise<unknown> | unknown>
> = Object.freeze({
  timeline: toolBrainTimeline,
  attention_flows: toolBrainAttentionFlows,
  belief_evolution: toolBrainBeliefEvolution,
  concept_synthesis: toolBrainConceptSynthesis,
});

function dispatchByView(
  table: Readonly<
    Record<
      string,
      (ctx: ServerContext, args: Record<string, unknown>) => Promise<unknown> | unknown
    >
  >,
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<unknown> | unknown {
  const view = typeof args["view"] === "string" ? args["view"] : "";
  const handler = table[view];
  if (handler === undefined) {
    throw new MCPError(
      INVALID_PARAMS,
      `view must be one of ${Object.keys(table).join(", ")}; got ${JSON.stringify(args["view"])}`,
    );
  }
  return handler(ctx, args);
}

async function toolBrainBrief(ctx: ServerContext, args: Record<string, unknown>): Promise<unknown> {
  return await dispatchByView(BRIEF_VIEW_HANDLERS, ctx, args);
}

async function toolBrainAnalytics(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  // attention_flows requires an `operation`; the consolidated surface
  // defaults it to the read-only `list` so `{view}` alone is valid.
  const withDefaults = args["view"] === "attention_flows" ? { operation: "list", ...args } : args;
  return await dispatchByView(ANALYTICS_VIEW_HANDLERS, ctx, withDefaults);
}

export const BRAIN_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_brief",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Read-only Brain summary, one tool for every window: view=morning (session-start brief), daily, weekly, monthly, operator (maintenance dashboard), or digest (activity window). Replaces the per-window brief tools.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["morning", "daily", "weekly", "monthly", "operator", "digest"],
          description: "Which summary to produce.",
        },
        date: {
          type: "string",
          description: "view=daily: ISO date (YYYY-MM-DD), default today UTC.",
        },
        week_end: {
          type: "string",
          description: "view=weekly: ISO end date (exclusive), default today UTC.",
        },
        month: {
          type: "string",
          description: "view=monthly: target month (YYYY-MM), default current UTC month.",
        },
        since: {
          type: "string",
          description: "view=digest: inclusive ISO lower bound, default until - 24h.",
        },
        until: {
          type: "string",
          description: "view=digest: exclusive ISO upper bound, default now.",
        },
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description: "view=digest: output format, default markdown.",
        },
        top_k: {
          type: "integer",
          minimum: 1,
          description: "view=morning: max confirmed preferences (default 10).",
        },
        lookback_days: {
          type: "integer",
          minimum: 1,
          description: "view=morning: days of log history (default 7).",
        },
        max_chars_per_memory: {
          type: "integer",
          minimum: 1,
          description: "view=morning: per-entry character cap.",
        },
        max_total_chars: {
          type: "integer",
          minimum: 1,
          description: "view=morning: total character cap.",
        },
        include_dream: {
          type: "boolean",
          description: "view=operator: fold a dry-run dream delta in (default true).",
        },
        top_actions: {
          type: "integer",
          minimum: 0,
          description: "view=operator: cap on ranked actions (default 5).",
        },
      },
      required: ["view"],
      additionalProperties: false,
    },
    handler: toolBrainBrief,
  },
  {
    name: "brain_analytics",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Read-only Brain analytics, one tool for every lens: view=timeline (event history), attention_flows, belief_evolution, or concept_synthesis. Replaces the per-lens analytics tools.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["timeline", "attention_flows", "belief_evolution", "concept_synthesis"],
          description: "Which analytics lens to run.",
        },
        pref_id: {
          type: "string",
          description: "timeline / belief_evolution: target preference id.",
        },
        topic: { type: "string", description: "timeline / belief_evolution: target topic slug." },
        kind: { type: "string", description: "view=timeline: restrict to one event kind." },
        since: { type: "string", description: "view=timeline: inclusive ISO lower bound." },
        until: { type: "string", description: "view=timeline: exclusive ISO upper bound." },
        limit: { type: "integer", minimum: 1, description: "view=timeline: max events returned." },
        id: { type: "string", description: "view=concept_synthesis: target id (e.g. pref-foo)." },
        include_unlinked: {
          type: "boolean",
          description: "view=concept_synthesis: include raw-text mentions (default false).",
        },
        operation: {
          type: "string",
          enum: ["list", "evaluate", "render"],
          description: "view=attention_flows: operation, default list.",
        },
        flow_id: {
          type: "string",
          description: "view=attention_flows: flow id for evaluate/render.",
        },
      },
      required: ["view"],
      additionalProperties: false,
    },
    handler: toolBrainAnalytics,
  },

  {
    name: "brain_feedback",
    description:
      "Record one Brain taste signal in `Brain/inbox/sig-*.md`. With `force_confirmed: true`, create the preference directly (skips the dream trial window).",
    inputSchema: {
      type: "object",
      properties: {
        topic: {
          type: "string",
          description: "Stable kebab-slug for the rule, e.g. `no-internal-abbrev`.",
        },
        signal: {
          type: "string",
          enum: ["positive", "negative"],
          description:
            "`positive` when the principle is the rule to follow, `negative` when it's what to avoid.",
        },
        principle: {
          type: "string",
          description: "One-line, agent-readable formulation of the rule (imperative voice).",
        },
        scope: {
          type: "string",
          description:
            "Optional soft category for later application-scope matching, e.g. `writing`, `coding`.",
        },
        source: {
          type: "array",
          items: { type: "string" },
          description: "Optional wikilinks to the artifacts or notes that triggered the signal.",
        },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
        raw: {
          type: "string",
          description: "Optional free-form raw quote (rendered under `## Raw` in the signal file).",
        },
        force_confirmed: {
          type: "boolean",
          description:
            "When true, also creates an immediately-active confirmed `pref-*` alongside the inbox signal, skipping the dream-pass promotion step.",
        },
      },
      required: ["topic", "signal", "principle"],
      additionalProperties: false,
    },
    handler: toolBrainFeedback,
  },
  {
    name: "brain_dream",
    description:
      "Run the deterministic learning pass over `Brain/inbox/` (clusters signals, promotes preferences, retires stale rules). Typically scheduled via cron rather than invoked interactively.",
    inputSchema: {
      type: "object",
      properties: {
        dry_run: {
          type: "boolean",
          description: "When true, compute the plan without writing any files.",
        },
        now: {
          type: "string",
          description:
            "Optional ISO-8601 timestamp used as the wall clock for the run (testing / replay).",
        },
        agent: {
          type: "string",
          description:
            "Optional caller identity; a mismatch with the configured primary agent emits a warning. Defaults to the server-resolved name.",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainDream,
  },
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
    ...deprecatedAlias({
      name: "brain_monthly_review",
      target: "brain_brief",
      view: "monthly",
      handler: toolBrainMonthlyReview,
    }),
    previewBudget: MCP_PREVIEW_BUDGET,
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
    name: "brain_apply_evidence",
    description:
      "Record whether an active preference was applied, violated, or marked outdated against a freshly-produced durable artifact. Appends one event to `Brain/log/<today>.md`. A single `outdated` event triggers retire on the next dream pass.",
    inputSchema: {
      type: "object",
      properties: {
        pref_id: {
          type: "string",
          description: "Preference id (`pref-<slug>` or bare `<slug>`).",
        },
        artifact: {
          type: "string",
          description:
            "Wikilink identifying the artifact; optional inclusive line-range suffix, e.g. `[[src/cli/main.ts:120-145]]`.",
        },
        result: {
          type: "string",
          enum: ["applied", "violated", "outdated"],
          description:
            "`applied` if the rule held, `violated` if broken, `outdated` if the artifact shows the rule itself is obsolete.",
        },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
        outcome: {
          type: "string",
          enum: ["success", "failure", "unknown"],
          description:
            "Optional downstream outcome of the artifact (t_d478df53): did the work the rule was applied to actually succeed? `unknown` is treated like an absent outcome.",
        },
        note: {
          type: "string",
          description: "Optional one-line context.",
        },
      },
      required: ["pref_id", "artifact", "result"],
      additionalProperties: false,
    },
    handler: toolBrainApplyEvidence,
  },
  {
    name: "brain_note",
    description:
      "Append one narrative-milestone line (release shipped, PR merged, fact discovered) to today's Brain log under the `note` event kind. Use when neither brain_feedback nor brain_apply_evidence fits.",
    inputSchema: {
      type: "object",
      properties: {
        text: {
          type: "string",
          description:
            "One-line narrative description. Newlines collapse to single spaces; the shared redactor strips secret-shaped tokens.",
        },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
      },
      required: ["text"],
      additionalProperties: false,
    },
    handler: toolBrainNote,
  },
  {
    name: "brain_pinned_context",
    description:
      "Read, write, append, or clear the transient current-task scratchpad at `Brain/pinned.md`. Use for facts that should survive context rotation but should not become permanent preferences.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["read", "write", "append", "clear"],
          description: "Operation to perform. Defaults to read.",
        },
        content: {
          type: "string",
          description: "Pinned context body for write/append operations.",
        },
      },
      additionalProperties: false,
    },
    outputSchema: PINNED_CONTEXT_OUTPUT_SCHEMA,
    handler: toolBrainPinnedContext,
  },
  {
    name: "brain_write_session",
    description:
      "Provider-agnostic Brain write sessions (artifact and decision-panel kinds): open returns a generation prompt, submit validates the text, only clean artifacts commit. Correction loop, retry cap, collision guard, optional operator review. The calling agent generates; the Brain never does.",
    inputSchema: {
      type: "object",
      properties: {
        op: {
          type: "string",
          enum: ["open", "submit", "approve", "abandon", "status", "list"],
          description: "Lifecycle operation.",
        },
        kind: {
          type: "string",
          enum: ["artifact", "panel"],
          description: "Session kind for op=open. Defaults to artifact.",
        },
        session_id: {
          type: "string",
          description: "Session id (`ws-...`) for submit/approve/abandon/status.",
        },
        target: {
          type: "string",
          description:
            "Vault-relative commit target under Brain/ (artifact open; optional panel override). Reserved namespaces are refused.",
        },
        text: {
          type: "string",
          description:
            "Generated text for op=submit: the full artifact, a persona answer, or the synthesis.",
        },
        topic: { type: "string", description: "Decision topic (panel open)." },
        personas: {
          type: "array",
          items: { type: "string" },
          description:
            "Persona slugs to convene in order (panel open). Defaults to every loaded persona.",
        },
        schema_type: {
          type: "string",
          description: "Schema-pack page type the artifact must declare (artifact open).",
        },
        intent: {
          type: "string",
          enum: ["create", "overwrite", "merge"],
          description:
            "Commit intent against an existing target (artifact open). Default create - never overwrites.",
        },
        prompt: { type: "string", description: "Custom generation instruction (artifact open)." },
        require_review: {
          type: "boolean",
          description: "Park the validated artifact at needs-review until an operator approves.",
        },
        retry_cap: { type: "number", description: "Failed submits allowed per step (default 3)." },
        limit: {
          type: "number",
          description: "Max sessions returned by op=list (default 100, cap 500).",
        },
        agent: { type: "string", description: "Agent identity override (open)." },
      },
      required: ["op"],
      additionalProperties: false,
    },
    handler: toolBrainWriteSession,
  },
  {
    name: "brain_intention",
    description:
      "Scoped current-intention chains under Brain/intentions/: set updates a workstream's now-document (prior text lands in its history trail), show/list read, move retires the chain into history/.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["set", "show", "list", "move"],
          description: "Operation to perform.",
        },
        scope: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Workstream or session label (normalised to a scope slug).",
        },
        text: {
          type: "string",
          minLength: 1,
          maxLength: 4000,
          description: "Intention text for the set operation.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainIntention,
  },
  {
    name: "brain_trigger",
    description:
      "Grounded proactive trigger queue under Brain/triggers/: scan generates deduped triggers from health/retention data, list/history read by lifecycle status, acknowledge/dismiss/act transition one trigger. Anti-nag: cooldown keys keep the same issue from reappearing every run.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["scan", "list", "history", "acknowledge", "dismiss", "act"],
          description: "Operation to perform.",
        },
        id: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description: "Trigger id for acknowledge/dismiss/act.",
        },
        status: {
          type: "string",
          enum: ["pending", "delivered", "acknowledged", "acted", "dismissed", "expired"],
          description: "Effective-status filter for list.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainTrigger,
  },
  {
    name: "brain_deep_synthesis",
    description:
      "Topic-scoped deterministic dossier: matched notes, agreements (positive typed relations), contradictions, stale claims, and knowledge gaps (dangling wikilinks). Evidence assembly only - prose synthesis stays with the caller. Optional triggers=true enqueues findings.",
    inputSchema: {
      type: "object",
      properties: {
        topic: { type: "string", minLength: 1, maxLength: 500 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        triggers: {
          type: "boolean",
          description: "Enqueue contradiction/gap findings into the trigger queue.",
        },
      },
      required: ["topic"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainDeepSynthesis,
  },
  {
    name: "brain_idea_discovery",
    description:
      "Ranked next-direction candidates from the vault's open loops: unanswered open questions, orphan research notes (no inbound links), and aging unresolved inbox signals. Deterministic scoring; triggers=true enqueues the ranked ideas.",
    inputSchema: {
      type: "object",
      properties: {
        cap: { type: "integer", minimum: 1, maximum: 50 },
        triggers: {
          type: "boolean",
          description: "Enqueue the ranked ideas into the trigger queue.",
        },
      },
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainIdeaDiscovery,
  },
  {
    name: "brain_context",
    description:
      "Pull the current Brain/active.md body, pinned current-task context, and active-preference counts. Use at session start when SessionStart hook is unavailable (Cursor, Aider, raw Claude API). Read-only.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: BRAIN_CONTEXT_OUTPUT_SCHEMA,
    handler: toolBrainContext,
  },
  {
    ...deprecatedAlias({
      name: "brain_digest",
      target: "brain_brief",
      view: "digest",
      handler: toolBrainDigest,
    }),
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_query",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Read-only lookup: one preference + its evidence trail, all artifacts under a topic, or every log event after a timestamp. Exactly one of `preference`, `topic`, `since` must be supplied.",
    inputSchema: {
      type: "object",
      properties: {
        preference: {
          type: "string",
          description:
            "Preference id (`pref-...` or `ret-...`) to look up with its evidence trail.",
        },
        topic: {
          type: "string",
          description: "Topic slug to aggregate signals + active/retired preference + log events.",
        },
        since: {
          type: "string",
          description: "ISO-8601 timestamp; returns every Brain log event with timestamp >= since.",
        },
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description:
            "Reserved for forward-compat; the structured response is the same regardless.",
        },
        telemetry: {
          type: "boolean",
          description:
            "Opt-in recall telemetry: emit one continuity record (mode 'query', kind-only payload) for this call.",
        },
        telemetry_host: { type: "string", maxLength: 200 },
        session_id: { type: "string", maxLength: 512 },
        turn_id: { type: "string", maxLength: 512 },
      },
      additionalProperties: false,
    },
    outputSchema: BRAIN_QUERY_OUTPUT_SCHEMA,
    handler: toolBrainQuery,
  },
  {
    name: "brain_agent_query",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Read-only source-agent retrieval over Brain provenance. Filters by agents, topic, free-text query, contribution kind, and limit; returns deterministic matched contributions plus a summary.",
    inputSchema: {
      type: "object",
      properties: {
        agents: {
          type: "array",
          items: { type: "string" },
          description: "Agent ids to query. Omit or pass [] to query all known agents.",
        },
        topic: {
          type: "string",
          description: "Exact Brain topic filter.",
        },
        query: {
          type: "string",
          description:
            "Case-insensitive substring matched against deterministic contribution text.",
        },
        kind: {
          type: "string",
          enum: ["signal", "preference", "log"],
          description: "Contribution kind filter.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Maximum contributions returned. Defaults to 50.",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainAgentQuery,
  },
  {
    name: "brain_agent_diff",
    description:
      "Read-only comparison between source agents using the same provenance foundation as brain_agent_query. Supports browse, search, diff, and map modes.",
    inputSchema: {
      type: "object",
      properties: {
        mode: {
          type: "string",
          enum: ["browse", "search", "diff", "map"],
          description:
            "Comparison mode. Defaults to search when query is supplied, otherwise browse.",
        },
        agents: {
          type: "array",
          items: { type: "string" },
          description: "Agent ids to compare. Omit or pass [] to compare all known agents.",
        },
        topic: {
          type: "string",
          description: "Exact Brain topic filter.",
        },
        query: {
          type: "string",
          description:
            "Case-insensitive substring matched against deterministic contribution text.",
        },
        kind: {
          type: "string",
          enum: ["signal", "preference", "log"],
          description: "Contribution kind filter.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 500,
          description: "Maximum contributions returned before comparison. Defaults to 50.",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainAgentDiff,
  },
  {
    name: "brain_doctor",
    description:
      "Validate `Brain/` invariants: status-vs-folder consistency, frontmatter validity, duplicate ids, ISO parsing, log header parsing. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        strict: {
          type: "boolean",
          description: "When true, warnings demote `ok` to false (CLI exit-code parity).",
        },
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description:
            "Output format hint. Structured result is identical; caller decides rendering.",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainDoctor,
  },
  {
    name: "brain_health",
    description:
      "Semantic-health report: contradictory confirmed preferences (opposite sign of record, same subject), recurring concepts with no dedicated preference, and confirmed preferences running on stale evidence. Returns the per-domain findings plus a clean/watch/investigate verdict. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        format: {
          type: "string",
          enum: ["markdown", "json"],
          description:
            "Output format hint. Structured result is identical; caller decides rendering.",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainHealth,
  },
  {
    name: "brain_mcp_landscape",
    description:
      "List the Model Context Protocol servers configured across the vault: each server's name, the config file that declares it, the packages it pulls, and the env-var NAMES it requires. Environment values are never read. Discovery is vault-relative. Read-only.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    outputSchema: {
      type: "object",
      required: ["vault_path", "servers"],
      properties: {
        vault_path: { type: "string" },
        servers: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "source", "packages", "env"],
            properties: {
              name: { type: "string" },
              source: { type: "string" },
              packages: { type: "array", items: { type: "string" } },
              env: { type: "array", items: { type: "string" } },
            },
          },
        },
      },
    },
    handler: toolMcpLandscape,
  },
  {
    name: "brain_entity",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Look up (view: get) or list (view: list) canonical entities from the Brain/entities/ registry. Aliases resolve to the canonical record. Read-only; writes go through the o2b CLI.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["get", "list"],
          description: "get: resolve one entity by name or alias. list: enumerate the registry.",
        },
        query: {
          type: "string",
          description: "Name or alias to resolve (required for view: get).",
        },
        category: {
          type: "string",
          description: "Optional category filter (slug, e.g. `people`).",
        },
        status: {
          type: "string",
          enum: ["active", "archived"],
          description: "Optional status filter for view: list.",
        },
      },
      required: ["view"],
      additionalProperties: false,
    },
    handler: toolBrainEntity,
  },
  {
    name: "brain_backlinks",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "List inbound references to a Brain artifact id (preference, retired, or signal). Returns every source that points at the id via wikilink, in any preference/retired frontmatter field, body prose, signal source, or log payload. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Target id (e.g. `pref-foo`, `ret-bar`, `sig-2026-05-14-baz`). Wikilink decoration is stripped if present.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolBrainBacklinks,
  },
  {
    name: "brain_audit",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Return a preference's full mutation audit trail (create / promote / update / retire / merge), oldest first, with agent, reason, and revisions. Accepts pref-/ret-/bare/wikilink ids. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        pref_id: {
          type: "string",
          description:
            "Preference id (e.g. `pref-foo`). `ret-foo`, bare `foo`, and `[[pref-foo]]` all resolve to the same trail.",
        },
      },
      required: ["pref_id"],
      additionalProperties: false,
    },
    handler: toolBrainAudit,
  },
  {
    ...deprecatedAlias({
      name: "brain_morning_brief",
      target: "brain_brief",
      view: "morning",
      handler: toolBrainMorningBrief,
    }),
  },
  {
    name: "brain_sources",
    description:
      "Read-only dashboard of the brain's signals grouped by (agent, source_type) with active/processed and distinct-topic counts plus totals.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    handler: toolBrainSources,
  },
  {
    name: "brain_switch_vault",
    description:
      "Activate a named vault profile (from the profiles registry). Updates the active pointer; the change takes effect on the next server launch - the running server keeps its already-resolved vault.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Profile name to activate." },
      },
      required: ["name"],
      additionalProperties: false,
    },
    handler: toolBrainSwitchVault,
  },
  {
    name: "brain_context_pack",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Return the highest-tier, most recent vault slice that fits under `max_tokens`. Ordered core → supporting → peripheral, newest first; stops adding pages when the next page would exceed the budget. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        max_tokens: {
          type: "integer",
          minimum: 1,
          description: "Strict upper bound on the returned slice's token count.",
        },
        query: {
          type: "string",
          description: "Optional case/Unicode-insensitive substring filter on topic + principle.",
        },
        focus_session: {
          type: "string",
          minLength: 1,
          maxLength: 128,
          description:
            "Session id whose bound search focus boosts matching memories (requires search_focus_context_pack).",
        },
        max_chars_per_memory: {
          type: "integer",
          minimum: 1,
          description:
            "Optional per-page character cap so one huge page cannot crowd out the rest; trimmed pages carry `trimmed: true`.",
        },
        max_total_chars: {
          type: "integer",
          minimum: 1,
          description:
            "Optional second ceiling (code points) on the cumulative size of the returned slice. Lowest-priority overflow is dropped with an `over-char-budget` skip reason.",
        },
        lanes: {
          type: "boolean",
          description:
            "When true, also return polarity-aware directives, constraints, and consider lanes. Legacy flat `items` remains present.",
        },
        cache_stable: {
          type: "boolean",
          description:
            "When true, reorder the selected items by stable id and annotate their original rank.",
        },
        dedup_repeated: {
          type: "boolean",
          description:
            "When true, replace repeated context bodies with reference hints to an earlier emitted item.",
        },
        attention_flow_ids: {
          type: "array",
          items: { type: "string" },
          description:
            "Optional declarative attention flow ids to inject as a synthetic context block.",
        },
        receipt: {
          type: "boolean",
          description: "When true, emit an opt-in context receipt for this context-pack run.",
        },
        receipt_host: {
          type: "string",
          description: "Optional host/runtime name for emitted receipts; defaults to `mcp`.",
        },
        telemetry: {
          type: "boolean",
          description:
            "When true, emit an opt-in recall telemetry record for this context-pack run.",
        },
        telemetry_host: {
          type: "string",
          description: "Optional host/runtime name for emitted telemetry; defaults to `mcp`.",
        },
        session_id: {
          type: "string",
          description: "Optional session id recorded on emitted telemetry.",
        },
        turn_id: {
          type: "string",
          description: "Optional turn id recorded on emitted telemetry.",
        },
      },
      required: ["max_tokens"],
      additionalProperties: false,
    },
    handler: toolBrainContextPack,
  },
  {
    name: "brain_context_receipts",
    description:
      "List context receipt summaries or show one full receipt by id. Receipts are append-only continuity records emitted by opt-in context injection callers. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list", "show"],
          description: "Use list for summaries, show for one full receipt by id.",
        },
        id: {
          type: "string",
          description: "Receipt id required when operation is show.",
        },
        trigger: {
          type: "string",
          enum: ["context_pack", "pre_compress"],
          description: "Optional list filter by injection trigger.",
        },
        host: {
          type: "string",
          description: "Optional list filter by host/runtime name.",
        },
        session_id: {
          type: "string",
          description: "Optional list filter by recorded session id.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Optional maximum number of summaries to return.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainContextReceipts,
  },
  {
    name: "brain_recall_telemetry",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "List recall telemetry records or summarize recall coverage and knowledge gaps. Records are emitted only by opt-in callers. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list", "summary", "gate_list", "gate_summary"],
          description:
            "list/summary for recall telemetry; gate_list/gate_summary for recall-gate decisions.",
        },
        mode: {
          type: "string",
          enum: ["search", "context_pack", "pre_compress"],
          description: "Optional filter by recall mode.",
        },
        status: {
          type: "string",
          enum: ["ok", "empty", "error", "timeout"],
          description: "Optional filter by telemetry status.",
        },
        host: {
          type: "string",
          description: "Optional filter by host/runtime name.",
        },
        since: {
          type: "string",
          description: "Optional inclusive lower timestamp bound.",
        },
        until: {
          type: "string",
          description: "Optional inclusive upper timestamp bound.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Optional maximum record count for list.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainRecallTelemetry,
  },
  {
    name: "brain_context_presets",
    description:
      "Show, suggest, or diff read-only context budget presets. Diagnostics only; never writes configuration.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["show", "suggest", "diff"],
          description:
            "show returns presets, suggest chooses by model/window, diff compares current values.",
        },
        preset_id: {
          type: "string",
          description: "Preset id for show/diff, e.g. tight-context or long-context.",
        },
        model: {
          type: "string",
          description: "Optional model name hint for suggest.",
        },
        context_window_tokens: {
          type: "integer",
          minimum: 1,
          description: "Optional context-window size hint for suggest.",
        },
        current: {
          type: "object",
          description:
            "Optional current values for diff: { context_pack, pre_compress, overrides }. Overrides preserve caller-managed paths.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainContextPresets,
  },
  {
    name: "brain_skill_proposals",
    description:
      "Learn/list/review deterministic skill proposals from continuity records (learn, list, accept, reject).",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["learn", "list", "accept", "reject"],
          description: "Tool operation.",
        },
        min_support: {
          type: "integer",
          minimum: 1,
          description: "Optional minimum evidence support for learn.",
        },
        slug: {
          type: "string",
          description: "Proposal slug for accept/reject.",
        },
        note: {
          type: "string",
          description: "Optional review note; required for reject.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainSkillProposals,
  },
  {
    name: "brain_procedural_memory",
    description:
      "Reconcile/list procedural memory index and update usage sidecar (reconcile, list, mark_used).",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["reconcile", "list", "mark_used"],
          description: "Tool operation.",
        },
        roots: {
          type: "array",
          items: { type: "string" },
          description: "Optional root directories for reconcile.",
        },
        id: {
          type: "string",
          description: "Procedural entry id for mark_used.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainProceduralMemory,
  },
  {
    name: "brain_recurrence",
    description:
      "Inspect and update recurrence/support diagnostics (list, show, learn, forget, purge_source).",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list", "show", "learn", "forget", "purge_source"],
          description: "Tool operation.",
        },
        content_hash: {
          type: "string",
          description: "Content hash for show/learn/forget.",
        },
        scope: {
          type: "string",
          description: "Scope for learn/forget.",
        },
        source_id: {
          type: "string",
          description: "Source id for learn/forget/purge_source.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainRecurrence,
  },
  {
    name: "brain_truth",
    description:
      "Entity claim ledger: ingest a claim, render current-truth slots with superseded history, list contested conflicts (ask_user), aggregate exact-match quantities, report cross-agent collisions.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["ingest", "slots", "conflicts", "aggregate", "collisions"],
          description: "Tool operation.",
        },
        entity: {
          type: "string",
          description: "Entity name (ingest, slots filter, aggregate filter).",
        },
        aspect: { type: "string", description: "Aspect slot for ingest." },
        value: { type: "string", description: "Claim value for ingest." },
        source: { type: "string", description: "Provenance wikilink/path for ingest." },
        agent: { type: "string", description: "Agent identity override for ingest." },
        quantity_value: { type: "number", description: "Numeric value for quantity claims." },
        quantity_unit: { type: "string", description: "Unit token for quantity claims." },
        quantity_action: { type: "string", description: "Measured action for quantity claims." },
        action: { type: "string", description: "Measured action for aggregate." },
        unit: { type: "string", description: "Unit token for aggregate (omit for unitless)." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainTruth,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_dead_ends",
    description:
      "Negative-knowledge registry (Brain/dead-ends/): record one tried-and-failed approach with why it failed, or list the bounded active set so recall surfaces avoid-X alongside prefer-Y.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["record", "list"],
          description: "Tool operation.",
        },
        approach: { type: "string", description: "What was tried (record)." },
        reason: { type: "string", description: "Why it failed or was set aside (record)." },
        context: { type: "string", description: "Optional context (record)." },
        agent: { type: "string", description: "Agent identity override (record)." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainDeadEnds,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_foresight",
    description:
      "Forward-looking projection (Brain's only anticipatory surface): recurring routines coming due within the horizon via cadence arithmetic, recent open commitments, and open questions - deterministic, every item carries sources.",
    inputSchema: {
      type: "object",
      properties: {
        horizon_days: {
          type: "integer",
          minimum: 1,
          description: "Forward horizon in days (default 14).",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainForesight,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_labels",
    description:
      "Controlled-vocabulary classification against the schema pack's labels field: assign (fail-closed - unknown dimensions/values rejected with the declared vocabulary), remove, or show a note's labels. Single-choice per dimension; persists as a labels frontmatter array plus a canonical label entity.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["assign", "remove", "show"],
          description: "Tool operation.",
        },
        path: { type: "string", description: "Vault-relative note path." },
        dimension: { type: "string", description: "Label dimension (assign/remove)." },
        value: { type: "string", description: "Label value (assign)." },
        agent: { type: "string", description: "Agent identity override (assign)." },
      },
      required: ["operation", "path"],
      additionalProperties: false,
    },
    handler: toolBrainLabels,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_tiers",
    description:
      "Frontmatter tier guard: check lists staged identity-field hand-edits the index post-pass detected, restore (apply=true required) writes the expected value back into the file, accept adopts the hand-edit as the new snapshot baseline. Nothing auto-resolves.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["check", "restore", "accept"],
          description: "Tool operation.",
        },
        path: { type: "string", description: "Vault-relative path (restore/accept)." },
        field: { type: "string", description: "Restrict to one field (restore/accept)." },
        apply: { type: "boolean", description: "Required true for restore - it writes the file." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainTiers,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_secrets",
    description:
      "Capability-gated secret custody, agent-facing subset: list stored secret metadata (never values) or run an allowlisted command with the secret injected as its declared env var - output comes back redacted. Storing and removing secrets stays on the operator's CLI (o2b brain secret).",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["list", "run"], description: "Tool operation." },
        name: { type: "string", description: "Secret name (run)." },
        command: {
          type: "array",
          items: { type: "string" },
          description: "Command argv to execute (run); must match the secret's allowlist.",
        },
        agent: { type: "string", description: "Agent identity override (run)." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainSecrets,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_maintenance",
    description:
      "Quiet-window, lease-guarded heavy maintenance lane: run executes dream + reindex stale-first behind the local-time window, recall-telemetry busy gate, and an expiring lease (force bypasses the soft gates, never the lease); status renders the lease holder and recent journal.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["run", "status"], description: "Tool operation." },
        force: { type: "boolean", description: "Bypass window and busy gates (run)." },
        window_start_hour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description: "Local hour the window opens, inclusive (run).",
        },
        window_end_hour: {
          type: "integer",
          minimum: 0,
          maximum: 23,
          description: "Local hour the window closes, exclusive (run).",
        },
        tz: { type: "string", description: "IANA timezone for the window (default UTC)." },
        agent: { type: "string", description: "Agent identity override (run)." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainMaintenance,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_procedural_graph",
    description:
      "Rebuild/show procedural graph projection and prospective hint projection (rebuild, show, hints).",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["rebuild", "show", "hints"],
          description: "Tool operation.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainProceduralGraph,
  },
  {
    ...deprecatedAlias({
      name: "brain_attention_flows",
      target: "brain_analytics",
      view: "attention_flows",
      handler: toolBrainAttentionFlows,
    }),
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_pre_compact_extract",
    description:
      "Extract typed Decision/Commitment/Outcome/Rule/Open question records from bounded text into continuity storage.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: {
          type: "string",
          description: "Session identifier used for idempotency and source refs.",
        },
        turn_start: {
          type: "string",
          description: "First source turn id in the extracted segment.",
        },
        turn_end: {
          type: "string",
          description: "Last source turn id in the extracted segment.",
        },
        text: {
          type: "string",
          description: "Bounded text segment to scan for labeled extraction lines.",
        },
        host: { type: "string", description: "Optional host/client label." },
        max_chars: {
          type: "integer",
          minimum: 1,
          description: "Optional maximum input characters to scan before extracting.",
        },
      },
      required: ["session_id", "turn_start", "turn_end", "text"],
      additionalProperties: false,
    },
    handler: toolBrainPreCompactExtract,
  },
  {
    name: "brain_session_grep",
    previewBudget: MCP_PREVIEW_BUDGET,
    description: "Search imported session recall raw turns and summary nodes.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search text." },
        session_id: {
          type: "string",
          description: "Optional session id filter.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Maximum hits to return.",
        },
        snippet_chars: {
          type: "integer",
          minimum: 1,
          description: "Maximum chars per hit snippet.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: toolBrainSessionGrep,
  },
  {
    name: "brain_session_describe",
    description: "Describe counts and summary depths for an imported session recall DAG.",
    inputSchema: {
      type: "object",
      properties: {
        session_id: { type: "string", description: "Session id to describe." },
      },
      required: ["session_id"],
      additionalProperties: false,
    },
    handler: toolBrainSessionDescribe,
  },
  {
    name: "brain_session_expand",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Expand a session recall raw or summary node to immediate sources and paginated exact raw turn content.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Session recall record id." },
        raw_limit: {
          type: "integer",
          minimum: 1,
          description: "Maximum raw turn items to return.",
        },
        cursor: {
          type: "string",
          description: "Raw turn pagination cursor from a previous response.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolBrainSessionExpand,
  },
  {
    // No preview budget: the addendum is meant to be injected whole and
    // is already bounded by its own per-entry / total character caps.
    name: "brain_pre_compress_pack",
    description:
      "Return a compact system-prompt addendum (top-K confirmed preferences plus the head of active.md) for a host to inject right before context compression. Char-budgeted. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        top_k: {
          type: "integer",
          minimum: 1,
          description:
            "Maximum number of preferences to include, highest-confidence first (default 10).",
        },
        max_chars_per_memory: {
          type: "integer",
          minimum: 1,
          description:
            "Optional per-entry character cap (code points); trimmed entries carry `trimmed: true`.",
        },
        max_total_chars: {
          type: "integer",
          minimum: 1,
          description:
            "Optional total character cap (code points) across the addendum; lowest-priority overflow is dropped.",
        },
        receipt: {
          type: "boolean",
          description: "When true, emit an opt-in context receipt for this pre-compress run.",
        },
        receipt_host: {
          type: "string",
          description: "Optional host/runtime name for emitted receipts; defaults to `mcp`.",
        },
        telemetry: {
          type: "boolean",
          description:
            "When true, emit an opt-in recall telemetry record for this pre-compress run.",
        },
        telemetry_host: {
          type: "string",
          description: "Optional host/runtime name for emitted telemetry; defaults to `mcp`.",
        },
        session_id: {
          type: "string",
          description: "Optional session id recorded on emitted telemetry.",
        },
        turn_id: {
          type: "string",
          description: "Optional turn id recorded on emitted telemetry.",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainPreCompressPack,
  },
  {
    name: "brain_unlinked_mentions",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Raw-text mentions of a target's title / aliases that are NOT already inside `[[...]]`. Walks Brain/preferences and Brain/retired; match boundary is Unicode-aware (codepoint class), language-agnostic. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Target id (e.g. `pref-foo`, `ret-bar`). Wikilink decoration is stripped if present.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          description:
            "Maximum number of mentions to return. Defaults to 100; the scanner stops as soon as the cap is hit.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolBrainUnlinkedMentions,
  },
  {
    ...deprecatedAlias({
      name: "brain_concept_synthesis",
      target: "brain_analytics",
      view: "concept_synthesis",
      handler: toolBrainConceptSynthesis,
    }),
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_moc_audit",
    description:
      "Per-MOC coverage audit. Given a hub note id, classifies its outbound cluster into well-covered / fragile / candidate-missing and surfaces a suggested-next candidate. MOC detection is purely structural (outbound link count + link density). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description: "Hub note id (e.g. `pref-foo`). Wikilink decoration is stripped if present.",
        },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: toolBrainMocAudit,
  },
  {
    ...deprecatedAlias({
      name: "brain_timeline",
      target: "brain_analytics",
      view: "timeline",
      handler: toolBrainTimeline,
    }),
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    ...deprecatedAlias({
      name: "brain_belief_evolution",
      target: "brain_analytics",
      view: "belief_evolution",
      handler: toolBrainBeliefEvolution,
    }),
    previewBudget: MCP_PREVIEW_BUDGET,
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
  {
    ...deprecatedAlias({
      name: "brain_daily_brief",
      target: "brain_brief",
      view: "daily",
      handler: toolBrainDailyBrief,
    }),
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    ...deprecatedAlias({
      name: "brain_weekly_synthesis",
      target: "brain_brief",
      view: "weekly",
      handler: toolBrainWeeklySynthesis,
    }),
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    ...deprecatedAlias({
      name: "brain_operator_summary",
      target: "brain_brief",
      view: "operator",
      handler: toolBrainOperatorSummary,
    }),
    previewBudget: MCP_PREVIEW_BUDGET,
  },
]);
