/**
 * Consolidated brief dispatcher: morning/daily/weekly/monthly views, digest, and the operator summary behind the brain_brief view parameter.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { resolveLinkOutputFormat, resolveTriggerCooldownDays } from "../../core/config.ts";
import { buildMorningBrief } from "../../core/brain/morning-brief.ts";
import {
  deliverBriefTriggers,
  renderTriggerBriefSection,
} from "../../core/brain/triggers/brief.ts";
import { buildTimelineIndex } from "../../core/brain/temporal/build-index.ts";
import { buildDailyBrief } from "../../core/brain/temporal/daily-brief.ts";
import { buildWeeklySynthesis } from "../../core/brain/temporal/weekly-brief.ts";
import { loadTemporalConfigSafe } from "../../core/brain/policy.ts";
import { renderDigest, type DigestFormat } from "../../core/brain/digest.ts";
import { dream } from "../../core/brain/dream.ts";
import {
  buildMonthlyReview,
  normalizeMonthlyReviewMonth,
} from "../../core/brain/monthly-review.ts";
import { buildOperatorSummary } from "../../core/brain/trust/operator-summary.ts";
import { isoDate } from "../../core/brain/time.ts";
import { captureReportDelta } from "../../core/brain/report-snapshot.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { coerceIsoDate, coerceFormat } from "../coerce.ts";
import {
  coerceIsoTimestampOrDate,
  coercePositiveInteger,
  dispatchByView,
  localizeEnvelope,
} from "./shared.ts";

async function toolBrainMorningBrief(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const topK = coercePositiveInteger("brain_brief view=morning", "top_k", args["top_k"]) ?? 10;
  const lookbackDays =
    coercePositiveInteger("brain_brief view=morning", "lookback_days", args["lookback_days"]) ?? 7;
  const maxCharsPerMemory = coercePositiveInteger(
    "brain_brief view=morning",
    "max_chars_per_memory",
    args["max_chars_per_memory"],
  );
  const maxTotalChars = coercePositiveInteger(
    "brain_brief view=morning",
    "max_total_chars",
    args["max_total_chars"],
  );
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

async function toolBrainDigest(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const since = coerceIsoDate(args, "since");
  const until = coerceIsoDate(args, "until");
  const format = coerceFormat(args) satisfies DigestFormat;

  // Pin ONE effective until instant so the rendered content, the
  // snapshot render, and the snapshot date key all describe the same
  // window even when the caller omitted `until`.
  const effectiveUntil = until ?? new Date();
  const result = renderDigest(ctx.vault, {
    ...(since ? { since } : {}),
    until: effectiveUntil,
    format,
    linkOutputFormat: resolveLinkOutputFormat(ctx.configPath ?? undefined),
  });

  const envelope: Record<string, unknown> = {
    format,
    empty: result.empty,
    content: result.content,
  };
  // Snapshot the structured summary, not the rendered string: render
  // a JSON digest for the snapshot regardless of the caller's format
  // so the run-over-run diff keys on data.
  const digestDate = isoDate(effectiveUntil);
  const snapshotSource =
    format === "json"
      ? result.content
      : renderDigest(ctx.vault, {
          ...(since ? { since } : {}),
          until: effectiveUntil,
          format: "json",
          linkOutputFormat: resolveLinkOutputFormat(ctx.configPath ?? undefined),
        }).content;
  let parsedSnapshot: unknown = null;
  try {
    parsedSnapshot = JSON.parse(snapshotSource);
  } catch {
    parsedSnapshot = null;
  }
  const delta =
    parsedSnapshot !== null
      ? captureReportDelta(
          ctx.vault,
          "digest",
          digestDate,
          parsedSnapshot,
          ctx.configPath ? { configPath: ctx.configPath } : {},
        )
      : null;
  return delta !== null ? { ...envelope, delta } : envelope;
}

// ----- brain_query ---------------------------------------------------------

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
  const envelope: Record<string, unknown> = {
    vault_path: ctx.vault,
    date: brief.date,
    window: brief.window,
    events_by_kind: brief.eventsByKind,
    status_transitions: brief.statusTransitions,
    vault_delta: brief.vaultDelta,
    source_pointers: brief.sourcePointers,
    generated_at: brief.generatedAt,
  };
  // Dual-output (t_00eece5d): persist a machine snapshot and report
  // the run-over-run delta when report snapshots are enabled.
  const delta = captureReportDelta(
    ctx.vault,
    "daily",
    brief.date,
    envelope,
    ctx.configPath ? { configPath: ctx.configPath } : {},
  );
  return delta !== null ? { ...envelope, delta } : envelope;
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
  const envelope: Record<string, unknown> = {
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
  const delta = captureReportDelta(
    ctx.vault,
    "weekly",
    weekEnd,
    envelope,
    ctx.configPath ? { configPath: ctx.configPath } : {},
  );
  return delta !== null ? { ...envelope, delta } : envelope;
}

// ----- brain_intention (Agent Surface Suite) --------------------------------

async function toolBrainMonthlyReview(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const monthRaw = args["month"];
  let month: string | undefined;
  if (monthRaw !== undefined && monthRaw !== null) {
    if (typeof monthRaw !== "string") {
      throw new MCPError(INVALID_PARAMS, "brain_brief view=monthly: month must be YYYY-MM");
    }
    try {
      month = normalizeMonthlyReviewMonth(monthRaw);
    } catch {
      throw new MCPError(INVALID_PARAMS, "brain_brief view=monthly: month must be YYYY-MM");
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
          "brain_brief view=operator: top_actions must be a non-negative integer",
        );
      }
      topActionsN = topRaw;
    } else if (typeof topRaw === "string") {
      const trimmed = topRaw.trim();
      if (trimmed === "" || !/^[0-9]+$/.test(trimmed)) {
        throw new MCPError(
          INVALID_PARAMS,
          "brain_brief view=operator: top_actions must be a non-negative integer",
        );
      }
      topActionsN = Number.parseInt(trimmed, 10);
    } else {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_brief view=operator: top_actions must be a non-negative integer",
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
    throw new MCPError(
      INVALID_PARAMS,
      "brain_brief view=operator: include_dream must be a boolean",
    );
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

async function toolBrainBrief(ctx: ServerContext, args: Record<string, unknown>): Promise<unknown> {
  return localizeEnvelope(ctx, await dispatchByView(BRIEF_VIEW_HANDLERS, ctx, args));
}

export const BRIEF_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
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
]);
