/**
 * `brain_generation_reports` - inbound, opt-in LLM generation tracing
 * (Hindsight brain-loop ops, t_281c3edc).
 *
 * Open Second Brain's kernel never calls an LLM; the agent owns
 * generation. After it fulfils a handoff (write-session step,
 * context-pack consume, or dream-stage proposal) it can report the real
 * usage back through action `record`, which lands as a `generation_report`
 * continuity record correlated to the paths and ids the kernel owns.
 * Actions `list` and `summary` read the records and join them to memory
 * paths. `record` is gated (default off): a per-call `enable` flag or the
 * `generation_trace_enabled` config opens it; otherwise nothing is built
 * or written. Only `prompt_hash` + counts are stored, never the prompt.
 *
 * Registration happens through the brain-tools aggregator, which
 * preserves the public BRAIN_TOOLS surface.
 */

import { resolveGenerationTraceEnabled } from "../../core/config.ts";
import {
  emitGenerationReport,
  isGenerationHandoffKind,
  listGenerationReports,
  summarizeGenerationReports,
  type GenerationHandoffKind,
  type GenerationReportFilter,
  type GenerationUsage,
} from "../../core/brain/generation-reports.ts";
import type { ContinuitySourceRef } from "../../core/brain/continuity/types.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tools.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { coercePositiveInteger, optionalStringArg, requiredStringArg } from "./shared.ts";

const TOOL = "brain_generation_reports";

async function toolBrainGenerationReports(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const action = optionalStringArg(TOOL, args, "action");
  if (action === "record") return recordAction(ctx, args);
  if (action === "list") {
    const reports = listGenerationReports(ctx.vault, readFilter(args));
    return { vault_path: ctx.vault, total: reports.length, reports };
  }
  if (action === "summary") {
    return { ...summarizeGenerationReports(ctx.vault, readFilter(args)) };
  }
  throw new MCPError(INVALID_PARAMS, `${TOOL}: action must be record, list, or summary`);
}

function recordAction(ctx: ServerContext, args: Record<string, unknown>): Record<string, unknown> {
  const handoffKind = handoffKindArg(args["handoff_kind"]);
  const ref = requiredStringArg(TOOL, args, "ref");
  const agent = requiredStringArg(TOOL, args, "agent");
  const prompt = requiredStringArg(TOOL, args, "prompt");

  // Opt-in: per-call enable wins, else the config gate. Off => nothing written.
  const enabled =
    args["enable"] === true || resolveGenerationTraceEnabled(ctx.configPath ?? undefined);

  const record = emitGenerationReport(
    ctx.vault,
    {
      handoff: { kind: handoffKind, ref },
      agent,
      prompt,
      ...(optionalStringArg(TOOL, args, "scope") !== undefined
        ? { scope: optionalStringArg(TOOL, args, "scope") }
        : {}),
      ...(optionalStringArg(TOOL, args, "provider") !== undefined
        ? { provider: optionalStringArg(TOOL, args, "provider") }
        : {}),
      ...(optionalStringArg(TOOL, args, "model") !== undefined
        ? { model: optionalStringArg(TOOL, args, "model") }
        : {}),
      ...(optionalStringArg(TOOL, args, "finish_reason") !== undefined
        ? { finishReason: optionalStringArg(TOOL, args, "finish_reason") }
        : {}),
      ...(coercePositiveInteger(TOOL, "latency_ms", args["latency_ms"]) !== undefined
        ? { latencyMs: coercePositiveInteger(TOOL, "latency_ms", args["latency_ms"]) }
        : {}),
      ...(usageArg(args["usage"]) !== undefined ? { usage: usageArg(args["usage"]) } : {}),
      ...(sourceRefArgs(args["source_refs"]).length > 0
        ? { sourceRefs: sourceRefArgs(args["source_refs"]) }
        : {}),
      ...(optionalStringArg(TOOL, args, "created_at") !== undefined
        ? { createdAt: optionalStringArg(TOOL, args, "created_at") }
        : {}),
    },
    enabled,
  );

  return record !== null
    ? { vault_path: ctx.vault, recorded: true, id: record.id }
    : { vault_path: ctx.vault, recorded: false, reason: "disabled" };
}

function readFilter(args: Record<string, unknown>): GenerationReportFilter {
  const handoff = optionalStringArg(TOOL, args, "handoff_kind");
  if (handoff !== undefined && !isGenerationHandoffKind(handoff)) {
    throw new MCPError(
      INVALID_PARAMS,
      `${TOOL}: handoff_kind must be write_session, context_pack, or dream_stage`,
    );
  }
  const limit = coercePositiveInteger(TOOL, "limit", args["limit"]);
  return {
    ...(handoff !== undefined ? { handoffKind: handoff as GenerationHandoffKind } : {}),
    ...(optionalStringArg(TOOL, args, "agent") !== undefined
      ? { agent: optionalStringArg(TOOL, args, "agent") }
      : {}),
    ...(optionalStringArg(TOOL, args, "since") !== undefined
      ? { since: optionalStringArg(TOOL, args, "since") }
      : {}),
    ...(optionalStringArg(TOOL, args, "until") !== undefined
      ? { until: optionalStringArg(TOOL, args, "until") }
      : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function handoffKindArg(raw: unknown): GenerationHandoffKind {
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new MCPError(INVALID_PARAMS, `${TOOL}: handoff_kind is required for record`);
  }
  const value = raw.trim();
  if (!isGenerationHandoffKind(value)) {
    throw new MCPError(
      INVALID_PARAMS,
      `${TOOL}: handoff_kind must be write_session, context_pack, or dream_stage`,
    );
  }
  return value;
}

function usageArg(raw: unknown): GenerationUsage | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new MCPError(INVALID_PARAMS, `${TOOL}: usage must be an object`);
  }
  const obj = raw as Record<string, unknown>;
  const usage: GenerationUsage = {
    ...(numberArg(obj["input_tokens"], "usage.input_tokens") !== undefined
      ? { inputTokens: numberArg(obj["input_tokens"], "usage.input_tokens") }
      : {}),
    ...(numberArg(obj["output_tokens"], "usage.output_tokens") !== undefined
      ? { outputTokens: numberArg(obj["output_tokens"], "usage.output_tokens") }
      : {}),
    ...(numberArg(obj["cached_tokens"], "usage.cached_tokens") !== undefined
      ? { cachedTokens: numberArg(obj["cached_tokens"], "usage.cached_tokens") }
      : {}),
    ...(numberArg(obj["total_tokens"], "usage.total_tokens") !== undefined
      ? { totalTokens: numberArg(obj["total_tokens"], "usage.total_tokens") }
      : {}),
  };
  return Object.keys(usage).length > 0 ? usage : undefined;
}

function numberArg(raw: unknown, key: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    throw new MCPError(INVALID_PARAMS, `${TOOL}: ${key} must be a non-negative integer`);
  }
  return raw;
}

function sourceRefArgs(raw: unknown): ReadonlyArray<ContinuitySourceRef> {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) {
    throw new MCPError(INVALID_PARAMS, `${TOOL}: source_refs must be an array`);
  }
  return raw.map((entry, index) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new MCPError(INVALID_PARAMS, `${TOOL}: source_refs[${index}] must be an object`);
    }
    const obj = entry as Record<string, unknown>;
    const id = obj["id"];
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new MCPError(INVALID_PARAMS, `${TOOL}: source_refs[${index}].id must be a string`);
    }
    const ref: ContinuitySourceRef = {
      id: id.trim(),
      ...(typeof obj["path"] === "string" && obj["path"].trim().length > 0
        ? { path: obj["path"].trim() }
        : {}),
      ...(typeof obj["kind"] === "string" && obj["kind"].trim().length > 0
        ? { kind: obj["kind"].trim() }
        : {}),
    };
    return ref;
  });
}

export const GENERATION_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Inbound, opt-in LLM generation tracing; the kernel never calls an LLM. action=record posts a generation's usage for a handoff, gated default-off via enable or generation_trace_enabled, storing prompt_hash + token counts only, never the prompt. action=list/summary read and join to memory paths.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["record", "list", "summary"],
          description: "record an inbound report, or list/summary the stored reports.",
        },
        handoff_kind: {
          type: "string",
          enum: ["write_session", "context_pack", "dream_stage"],
          description:
            "record: which handoff this generation fulfilled. Also filters list/summary.",
        },
        ref: {
          type: "string",
          description: "record: the handoff id (session id, receipt id, run id).",
        },
        agent: {
          type: "string",
          description: "record: reporting agent; also filters list/summary.",
        },
        prompt: {
          type: "string",
          description:
            "record: the exact handoff prompt. Hashed and counted only - never stored as raw text.",
        },
        enable: {
          type: "boolean",
          description: "record: open the gate for this single call even if the config gate is off.",
        },
        scope: { type: "string", description: "record: optional scope label." },
        provider: { type: "string", description: "record: opaque agent-reported provider." },
        model: { type: "string", description: "record: opaque agent-reported model." },
        finish_reason: { type: "string", description: "record: optional finish reason." },
        latency_ms: { type: "integer", minimum: 1, description: "record: optional latency in ms." },
        usage: {
          type: "object",
          description:
            "record: optional agent-reported token usage (input_tokens, output_tokens, cached_tokens, total_tokens).",
          properties: {
            input_tokens: { type: "integer", minimum: 0 },
            output_tokens: { type: "integer", minimum: 0 },
            cached_tokens: { type: "integer", minimum: 0 },
            total_tokens: { type: "integer", minimum: 0 },
          },
          additionalProperties: false,
        },
        source_refs: {
          type: "array",
          description:
            "record: artifact join refs ({id, path?, kind?}) - e.g. the memory paths this generation produced or consumed.",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              path: { type: "string" },
              kind: { type: "string" },
            },
            required: ["id"],
            additionalProperties: false,
          },
        },
        created_at: {
          type: "string",
          description: "record: optional ISO timestamp (defaults to now).",
        },
        since: { type: "string", description: "list/summary: inclusive ISO lower bound." },
        until: { type: "string", description: "list/summary: inclusive ISO upper bound." },
        limit: { type: "integer", minimum: 1, description: "list: maximum record count." },
      },
      required: ["action"],
      additionalProperties: false,
    },
    handler: toolBrainGenerationReports,
  },
]);
