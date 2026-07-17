/**
 * Consolidated analytics dispatcher: timeline, belief evolution, concept synthesis, and attention flows behind the brain_analytics view parameter.
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { buildConceptCluster } from "../../core/brain/link-graph/concept-cluster.ts";
import { buildTimelineIndex } from "../../core/brain/temporal/build-index.ts";
import { selectEvents } from "../../core/brain/temporal/select-events.ts";
import { buildBeliefEvolution } from "../../core/brain/temporal/belief-evolution.ts";
import { isBrainLogEventKind, type BrainLogEventKind } from "../../core/brain/types.ts";
import {
  evaluateAttentionFlow,
  listAttentionFlows,
  renderAttentionFlow,
} from "../../core/brain/attention-flows.ts";
import { normaliseWikilinkTarget } from "../../core/brain/wikilink.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import {
  coerceIsoTimestampOrDate,
  coercePositiveInteger,
  dispatchByView,
  localizeEnvelope,
  requiredStringArg,
} from "./shared.ts";

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
      "brain_analytics view=belief_evolution: exactly one of pref_id or topic is required",
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
 * Concept-scoped cluster envelope: target + all linkers (depth-1)
 * plus optionally unlinked mentions. Pure assembler; no LLM call.
 */
async function toolBrainConceptSynthesis(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const idRaw = args["id"];
  if (typeof idRaw !== "string" || idRaw.trim().length === 0) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_analytics view=concept_synthesis: id must be a non-empty string",
    );
  }
  const includeUnlinkedRaw = args["include_unlinked"];
  let includeUnlinked = false;
  if (includeUnlinkedRaw !== undefined && includeUnlinkedRaw !== null) {
    if (typeof includeUnlinkedRaw !== "boolean") {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_analytics view=concept_synthesis: include_unlinked must be a boolean",
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
    "brain_analytics view=attention_flows: operation must be one of list|evaluate|render",
  );
}

const ANALYTICS_VIEW_HANDLERS: Readonly<
  Record<string, (ctx: ServerContext, args: Record<string, unknown>) => Promise<unknown> | unknown>
> = Object.freeze({
  timeline: toolBrainTimeline,
  attention_flows: toolBrainAttentionFlows,
  belief_evolution: toolBrainBeliefEvolution,
  concept_synthesis: toolBrainConceptSynthesis,
});

async function toolBrainAnalytics(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<unknown> {
  // attention_flows requires an `operation`; the consolidated surface
  // defaults it to the read-only `list` so `{view}` alone is valid.
  const withDefaults = args["view"] === "attention_flows" ? { operation: "list", ...args } : args;
  return localizeEnvelope(ctx, await dispatchByView(ANALYTICS_VIEW_HANDLERS, ctx, withDefaults));
}

export const ANALYTICS_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
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
]);
