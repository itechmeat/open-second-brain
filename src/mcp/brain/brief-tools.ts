/**
 * Consolidated brief dispatcher: morning/daily/weekly/monthly views, digest, and the operator summary behind the brain_brief view parameter.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import { type ServerContext, type ToolDefinition } from "../tool-contract.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { AGENT_SCOPE_ARG_NAME, AGENT_SCOPE_SCHEMA } from "../coerce.ts";
import { dispatchByView, localizeEnvelope } from "./shared.ts";
import type { ProgressSink } from "../../core/brain/progress.ts";
import {
  toolBrainDailyBrief,
  toolBrainDigest,
  toolBrainMonthlyReview,
  toolBrainMorningBrief,
  toolBrainOperatorSummary,
  toolBrainToday,
  toolBrainWeeklySynthesis,
} from "./brief-view-tools.ts";

/** What a reader outside the operator's queue is told about it: nothing. */
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
 * The views that accept an explicit `agent_scope` argument.
 *
 * EVERY view in this dispatcher narrows to the caller's server-resolved
 * identity under `integrity.owner_scope_delivery: fail`, whether or not
 * it takes the argument: `morning` and `digest` thread the scope through
 * their builders; `daily` and `weekly` ask the enforced rule per row
 * through `periodRowsAtReach`; `monthly` and `today` through the
 * request's reference view; `operator` through the doctor/action view it
 * composes. The set below therefore answers a narrower question: where
 * the argument itself is accepted. It is declared once for the whole
 * tool, so a view that cannot honour it must not silently discard it -
 * the other five REFUSE it (`context-integrity-gates`, A6) and stay
 * scoped by the identity instead.
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
        `an explicit scope is accepted by view=${[...AGENT_SCOPE_VIEWS].join(", view=")}; ` +
        `every view is already scoped by the server-resolved identity`,
    );
  }
  return localizeEnvelope(ctx, await dispatchByView(BRIEF_VIEW_HANDLERS, ctx, args, onProgress));
}

export const BRIEF_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_brief",
    // Write-mode-dominant (tool-contract.ts), not "read": view=digest
    // persists the window's structured snapshot under `Brain/reports/`
    // through `captureReportDelta` when report snapshots are enabled, so
    // the next digest run can diff against it. The write is opt-in and
    // skipped for restricted or scope-narrowed callers, but an opt-in
    // durable write still classifies the whole tool `write`.
    kind: "write",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Brain summary, one tool for every window: view=morning, daily, weekly, monthly, operator (maintenance dashboard), digest (activity window + report snapshot), or today (operator dashboard: due obligations, one-off pledges, open loops, recent activity, totals). Replaces the per-window brief tools.",
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
