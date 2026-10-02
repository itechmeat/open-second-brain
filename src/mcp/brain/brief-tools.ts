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
import {
  readTriggerQueueFailures,
  renderTriggerQueueFailures,
  unreadableTriggerJson,
  type TriggerQueueFailures,
} from "../../core/brain/triggers/store.ts";
import { buildTimelineIndex } from "../../core/brain/temporal/build-index.ts";
import {
  collectSourcePointers,
  computeVaultDelta,
  countByKind,
  type PeriodStatusTransition,
} from "../../core/brain/temporal/period-common.ts";
import { selectEvents } from "../../core/brain/temporal/select-events.ts";
import type { TimelineIndex } from "../../core/brain/temporal/types.ts";
import {
  readerRefView,
  type ArtifactRef,
  type ArtifactRefView,
} from "../../core/brain/artifact-ref-view.ts";
import { PREF_ID_PREFIX } from "../../core/brain/dream-plan.ts";
import { buildTodayDashboard } from "../../core/brain/today-dashboard.ts";
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
import { TRANSPORT_REACH } from "../../core/graph/transport-reach.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { contextReach, type ServerContext, type ToolDefinition } from "../tool-contract.ts";
import { readableAtContextReach, readableAtContextReachOrUndefined } from "./reach-readable.ts";
import { eventAtReach, eventsAtReach, recordRefs, requestRefView } from "./reach-events.ts";
import { vaultPathField } from "../vault-path-field.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import {
  AGENT_SCOPE_ARG_NAME,
  AGENT_SCOPE_SCHEMA,
  coerceAgentScope,
  coerceIsoDate,
  coerceFormat,
} from "../coerce.ts";
import {
  coerceIsoTimestampOrDate,
  coerceNonNegativeInteger,
  coercePositiveInteger,
  dispatchByView,
  localizeEnvelope,
  toolSafeguard,
} from "./shared.ts";
import type { ProgressSink } from "../../core/brain/progress.ts";
import { OPERATION } from "../../core/brain/safeguard.ts";

/** What a reader outside the operator's queue is told about it: nothing. */
const NO_TRIGGER_QUEUE_FAILURES: TriggerQueueFailures = Object.freeze({
  unreadable: Object.freeze([]),
  queueError: null,
});

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
  const agentScope = coerceAgentScope(ctx, args, true);
  const readable = readableAtContextReachOrUndefined(ctx);
  const brief = buildMorningBrief(ctx.vault, {
    now,
    topK,
    ...(agentScope !== undefined ? { agentScope } : {}),
    ...(readable !== undefined ? { readable } : {}),
    lookbackDays,
    ...(maxCharsPerMemory !== undefined ? { maxCharsPerMemory } : {}),
    ...(maxTotalChars !== undefined ? { maxTotalChars } : {}),
  });
  // Pending-trigger section (t_cd1fee79): renders only when a trigger
  // scan persisted surfaceable triggers; included triggers are marked
  // delivered so a prompt shows once per cooldown window.
  //
  // Still fail-soft - a broken queue must not cost the operator the rest
  // of the brief - but no longer silent. The bare catch this replaces set
  // the section to null, so a refusal rendered exactly like an empty
  // queue: the one outcome the anti-nag ledger exists to rule out. The
  // records that could not be read are collected first and reported
  // alongside whatever did render.
  //
  // The queue and its delivery state belong to the local operator: a
  // reader below local reach is shown no trigger, no queue failure, and
  // marks nothing delivered.
  const operatorQueue = contextReach(ctx) === TRANSPORT_REACH.local;
  const triggerFailures: TriggerQueueFailures = operatorQueue
    ? readTriggerQueueFailures(ctx.vault, now)
    : NO_TRIGGER_QUEUE_FAILURES;
  let triggerSection: ReturnType<typeof renderTriggerBriefSection> | null = null;
  let triggerQueueError = triggerFailures.queueError;
  if (operatorQueue) {
    try {
      triggerSection = renderTriggerBriefSection(ctx.vault, {
        now,
        cooldownDays: resolveTriggerCooldownDays(ctx.configPath ?? undefined),
      });
      if (triggerSection.triggers.length > 0) deliverBriefTriggers(ctx.vault, triggerSection, now);
    } catch (err) {
      triggerSection = null;
      triggerQueueError = (err as Error).message ?? String(err);
    }
  }
  const failureText = renderTriggerQueueFailures({
    unreadable: triggerFailures.unreadable,
    queueError: triggerQueueError,
  });
  const sections = [
    brief.text,
    triggerSection !== null ? triggerSection.text : "",
    failureText,
  ].filter((section) => section !== "");
  return {
    text: sections.join("\n\n"),
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
    ...(triggerFailures.unreadable.length > 0
      ? { triggers_unreadable: triggerFailures.unreadable.map(unreadableTriggerJson) }
      : {}),
    ...(triggerQueueError !== null ? { trigger_queue_error: triggerQueueError } : {}),
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
  const agentScope = coerceAgentScope(ctx, args, true);
  // Below local reach the digest is rendered for this reader: a record it
  // cannot read is absent from every row and count.
  const restricted = contextReach(ctx) !== TRANSPORT_REACH.local;
  const renderFor = (renderFormat: DigestFormat, readable?: (rel: string) => boolean) =>
    renderDigest(ctx.vault, {
      ...(since ? { since } : {}),
      until: effectiveUntil,
      format: renderFormat,
      linkOutputFormat: resolveLinkOutputFormat(ctx.configPath ?? undefined),
      ...(agentScope !== undefined ? { agentScope } : {}),
      ...(readable !== undefined ? { readable } : {}),
    });
  const result = renderFor(format, restricted ? readableAtContextReach(ctx) : undefined);

  const envelope: Record<string, unknown> = {
    format,
    empty: result.empty,
    content: result.content,
  };
  // The snapshot is the vault's own run-over-run record, diffed over the
  // digest every record feeds, so a reader below local reach neither
  // takes one nor is shown the delta.
  if (restricted) return envelope;
  // Snapshot the structured summary, not the rendered string: render
  // a JSON digest for the snapshot regardless of the caller's format
  // so the run-over-run diff keys on data.
  const digestDate = isoDate(effectiveUntil);
  const snapshotSource = format === "json" ? result.content : renderFor("json").content;
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
 * The rows of a daily or weekly envelope a reader at this request's
 * reach may see, or `null` at local reach, where the envelope is the
 * builder's own (the digest precedent: a reader below local reach is
 * shown only what it may read, and takes no report snapshot).
 *
 * Status transitions, retirements and contradictions are dropped when a
 * record they name is withheld. Source pointers are deduplicated
 * artifacts with no record left on them, so they are recollected from
 * the window's events the reader may see: an artifact cited only by
 * evidence on a withheld preference is absent. The counts
 * (`events_by_kind`, `vault_delta`) are recomputed from the same
 * selection, so a withheld record moves no count either.
 */
function periodRowsAtReach(
  ctx: ServerContext,
  index: TimelineIndex,
  window: { readonly since: string; readonly until: string },
): PeriodRowsView | null {
  if (contextReach(ctx) === TRANSPORT_REACH.local) return null;
  const refs = readerRefView(ctx.vault, readableAtContextReach(ctx));
  const events = eventsAtReach(refs, selectEvents(index, window));
  return {
    refs,
    sourcePointers: collectSourcePointers(events),
    eventsByKind: countByKind(events),
    vaultDelta: (transitions) => computeVaultDelta(events, transitions),
  };
}

interface PeriodRowsView {
  readonly refs: ArtifactRefView;
  readonly sourcePointers: ReadonlyArray<string>;
  readonly eventsByKind: ReturnType<typeof countByKind>;
  /** The window's delta over the visible events and the transitions kept for the reader. */
  readonly vaultDelta: (
    transitions: ReadonlyArray<PeriodStatusTransition>,
  ) => ReturnType<typeof computeVaultDelta>;
}

/** A transition or retirement row: the record id and the link it was logged with. */
function transitionRefs(row: {
  readonly prefId: string;
  readonly link: string;
}): ReadonlyArray<ArtifactRef> {
  return [row.link, ...recordRefs(row.prefId)];
}

/** A contradiction row: its record, the topic's record and its evidence artifact. */
function contradictionRefs(row: {
  readonly prefId?: string;
  readonly topic?: string;
  readonly artifact?: string;
}): ReadonlyArray<ArtifactRef> {
  return [
    row.artifact,
    ...recordRefs(row.prefId),
    ...(row.topic !== undefined ? recordRefs(`${PREF_ID_PREFIX}${row.topic}`) : []),
  ];
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
  const atReach = periodRowsAtReach(ctx, index, brief.window);
  const statusTransitions =
    atReach?.refs.keep(brief.statusTransitions, transitionRefs) ?? brief.statusTransitions;
  const envelope: Record<string, unknown> = {
    vault_path: vaultPathField(ctx),
    date: brief.date,
    window: brief.window,
    events_by_kind: atReach?.eventsByKind ?? brief.eventsByKind,
    status_transitions: statusTransitions,
    vault_delta: atReach?.vaultDelta(statusTransitions) ?? brief.vaultDelta,
    source_pointers: atReach?.sourcePointers ?? brief.sourcePointers,
    generated_at: brief.generatedAt,
  };
  // Below local reach no snapshot is taken and no delta reported.
  if (atReach !== null) return envelope;
  // Dual-output: persist a machine snapshot and report the run-over-run
  // delta when report snapshots are enabled.
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
  const atReach = periodRowsAtReach(ctx, index, {
    since: synth.windowStart,
    until: synth.windowEnd,
  });
  const statusTransitions =
    atReach?.refs.keep(synth.statusTransitions, transitionRefs) ?? synth.statusTransitions;
  const envelope: Record<string, unknown> = {
    vault_path: vaultPathField(ctx),
    window_start: synth.windowStart,
    window_end: synth.windowEnd,
    events_by_kind: atReach?.eventsByKind ?? synth.eventsByKind,
    status_transitions: statusTransitions,
    retired: atReach?.refs.keep(synth.retired, transitionRefs) ?? synth.retired,
    contradictions:
      atReach?.refs.keep(synth.contradictions, contradictionRefs) ?? synth.contradictions,
    vault_delta: atReach?.vaultDelta(statusTransitions) ?? synth.vaultDelta,
    source_pointers: atReach?.sourcePointers ?? synth.sourcePointers,
    generated_at: synth.generatedAt,
  };
  // Below local reach no snapshot is taken and no delta reported.
  if (atReach !== null) return envelope;
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
  onProgress?: ProgressSink,
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
      // The one view behind this dispatcher that runs a consolidation
      // pass. It is a DRY RUN, and it still walks the whole Brain tree,
      // so it is the slow half of an operator summary on a large vault.
      dreamSummary = dream(ctx.vault, {
        dryRun: true,
        // A dry run is still a full synchronous pass over the Brain tree,
        // so it is bounded on the same terms as `brain_dream` itself -
        // the budget the operator set for `dream` governs every MCP call
        // that reaches one, not just the tool that carries its name.
        safeguard: toolSafeguard(ctx, OPERATION.dream),
        ...(onProgress !== undefined ? { onProgress } : {}),
      });
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
    vault_path: vaultPathField(ctx),
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
 * `brain_brief view=today` - the today operator dashboard: due/overdue
 * obligations, open loops, merged recent activity, and a totals rollup.
 * Read-only; the clock is resolved at the tool boundary so the core
 * builder stays deterministic. Write-back (the `@osb set` engine) stays
 * CLI-only in this release and is deliberately not exposed here.
 */
async function toolBrainToday(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // Non-negative (0 allowed): the core `buildTodayDashboard` and the CLI
  // both accept a zero-day window and a zero-entry limit, so the MCP surface
  // must not reject what they honour.
  const lookbackDays = coerceNonNegativeInteger(
    "brain_brief view=today",
    "lookback_days",
    args["lookback_days"],
  );
  const limit = coerceNonNegativeInteger("brain_brief view=today", "limit", args["limit"]);
  // The recent-activity section renders log events; below local reach
  // (or under the ownership gate) it shows them as this caller may see
  // them, before the limit and the totals.
  const refs = requestRefView(ctx);
  const dashboard = buildTodayDashboard(ctx.vault, {
    now: new Date(),
    ...(refs.filtersNothing ? {} : { eventAtReach: (ev) => eventAtReach(refs, ev) }),
    ...(lookbackDays !== undefined ? { activityLookbackDays: lookbackDays } : {}),
    ...(limit !== undefined ? { activityLimit: limit } : {}),
  });
  return {
    vault_path: vaultPathField(ctx),
    text: dashboard.text,
    obligations: dashboard.obligations,
    open_loops: dashboard.openLoops,
    recent_activity: dashboard.recentActivity,
    totals: dashboard.totals,
    errors: dashboard.errors,
  };
}

const BRIEF_VIEW_HANDLERS: Readonly<
  Record<
    string,
    (
      ctx: ServerContext,
      args: Record<string, unknown>,
      onProgress?: ProgressSink,
    ) => Promise<unknown> | unknown
  >
> = Object.freeze({
  morning: toolBrainMorningBrief,
  daily: toolBrainDailyBrief,
  weekly: toolBrainWeeklySynthesis,
  monthly: toolBrainMonthlyReview,
  operator: toolBrainOperatorSummary,
  digest: toolBrainDigest,
  today: toolBrainToday,
});

/**
 * The views whose builders thread `agent_scope` through to the ownership
 * predicate. `agent_scope` is declared once for the whole tool, so the
 * other five would ACCEPT the argument and discard it - handing a caller
 * who asked to be isolated another owner's preference ids
 * (`weekly.retired[].prefId`, `weekly.statusTransitions[].prefId`,
 * `operator`'s ranked actions) while believing it was scoped. Silently
 * ignoring an argument a tool accepts is this wave's anti-pattern, so the
 * views that cannot honour it REFUSE it instead
 * (context-integrity-gates, A6).
 *
 * Threading it through the remaining five is the better end state; it
 * needs an ownership predicate inside `weekly-brief`, `monthly-review`,
 * `daily-brief`, `operator-summary` and `today-dashboard`, which is a
 * change to those builders rather than to this dispatcher.
 */
const AGENT_SCOPE_VIEWS: ReadonlySet<string> = new Set(["morning", "digest"]);

async function toolBrainBrief(
  ctx: ServerContext,
  args: Record<string, unknown>,
  onProgress?: ProgressSink,
): Promise<unknown> {
  const view = typeof args["view"] === "string" ? args["view"] : "";
  const scopeSupplied =
    AGENT_SCOPE_ARG_NAME in args &&
    args[AGENT_SCOPE_ARG_NAME] !== undefined &&
    args[AGENT_SCOPE_ARG_NAME] !== null;
  // Only an EXPLICIT argument is refused: the gated surfaces default their
  // scope from `ServerContext.agentName`, and refusing that would make the
  // tool unusable for every client that never passes the argument.
  if (scopeSupplied && view in BRIEF_VIEW_HANDLERS && !AGENT_SCOPE_VIEWS.has(view)) {
    throw new MCPError(
      INVALID_PARAMS,
      `brain_brief view=${view} cannot honour '${AGENT_SCOPE_ARG_NAME}'; ` +
        `owner scoping is supported by view=${[...AGENT_SCOPE_VIEWS].join(", view=")}`,
    );
  }
  return localizeEnvelope(ctx, await dispatchByView(BRIEF_VIEW_HANDLERS, ctx, args, onProgress));
}

export const BRIEF_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_brief",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Read-only Brain summary, one tool for every window: view=morning (session-start brief), daily, weekly, monthly, operator (maintenance dashboard), digest (activity window), or today (operator dashboard: due obligations, open loops, recent activity, totals). Replaces the per-window brief tools.",
    inputSchema: {
      type: "object",
      properties: {
        view: {
          type: "string",
          enum: ["morning", "daily", "weekly", "monthly", "operator", "digest", "today"],
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
          // 0 is a valid today window (empty recent-activity section); view=morning
          // still rejects 0 at runtime via its positive-integer coercer.
          minimum: 0,
          description:
            "view=morning: days of log history (default 7). view=today: recent-activity window in days (default 7).",
        },
        limit: {
          type: "integer",
          minimum: 0,
          description: "view=today: max recent-activity entries, newest first (default 20).",
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
        // The one place this argument's shared description is overridden,
        // and only to name WHICH views honour it - a caller cannot learn
        // that from a tool-wide declaration, and learning it from a
        // rejection after the fact is worse. Kept inside the registry
        // guard's 160-character property-description cap.
        agent_scope: {
          ...AGENT_SCOPE_SCHEMA,
          description:
            "Optional agent-ownership scope; ownerless memories always match. Accepted by view=morning and view=digest only; other views reject it, never ignore it.",
        },
      },
      required: ["view"],
      additionalProperties: false,
    },
    handler: toolBrainBrief,
  },
]);
