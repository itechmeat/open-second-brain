/**
 * Recall quality: benchmark, self-tuning, recall telemetry, and imported-session recall (grep/describe/expand).
 *
 * Extracted from the former brain-tools.ts monolith; registration
 * happens through the aggregator, which preserves the public
 * BRAIN_TOOLS surface.
 */

import { resolveSearchConfig } from "../../core/search/index.ts";
import { appendMetric } from "../../core/brain/metrics.ts";
import { parseRecallBenchmarkDataset, runRecallBenchmark } from "../../core/search/benchmark.ts";
import { loadTunedParameters, resetTuning, tuneRecall } from "../../core/search/tuning.ts";
import { listGateTelemetry, summarizeGateTelemetry } from "../../core/brain/gate-telemetry.ts";
import { computeMemoryCostMeter } from "../../core/brain/memory-cost-meter.ts";
import {
  isRecallTelemetryMode,
  isRecallTelemetryStatus,
  listRecallTelemetry,
  summarizeRecallTelemetry,
  type RecallTelemetryFilter,
  type RecallTelemetryMode,
  type RecallTelemetryStatus,
} from "../../core/brain/recall-telemetry.ts";
import {
  isMcpRouteStatus,
  listMcpRouteLatency,
  summarizeMcpRouteLatency,
  type McpRouteLatencyFilter,
  type McpRouteStatus,
} from "../../core/brain/mcp-route-metrics.ts";
import {
  emitTokenImpact,
  isTokenCountMethod,
  isTokenImpactOutcome,
  listTokenImpact,
  recordTokenImpactOutcome,
  summarizeTokenImpact,
  type TokenCountMethod,
  type TokenImpactFilter,
  type TokenImpactOutcome,
} from "../../core/brain/token-impact.ts";
import { resolveTokenImpactLedgerEnabled } from "../../core/config.ts";
import {
  describeSessionRecall,
  expandSessionRecall,
  searchSessionRecall,
} from "../../core/brain/session-recall.ts";
import { aggregateQueryDemand, serializeQueryDemandReport } from "../../core/brain/query-demand.ts";
import { isoSecond } from "../../core/brain/time.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tools.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import { coercePositiveInteger, optionalStringArg, requiredStringArg } from "./shared.ts";

/** Recall-quality benchmark over an inline dataset. */
async function toolBrainBenchmark(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "run") {
    throw new MCPError(INVALID_PARAMS, "brain_benchmark: operation must be run");
  }
  const k = args["k"];
  if (k !== undefined && (!Number.isInteger(k) || (k as number) < 1)) {
    throw new MCPError(INVALID_PARAMS, "brain_benchmark run: k must be a positive integer");
  }
  let dataset;
  try {
    dataset = parseRecallBenchmarkDataset(args["dataset"]);
  } catch (exc) {
    throw new MCPError(INVALID_PARAMS, `brain_benchmark run: ${(exc as Error).message}`);
  }
  const searchConfig = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });
  const now = new Date();
  const report = await runRecallBenchmark(searchConfig, dataset, {
    ...(k !== undefined ? { k: k as number } : {}),
    expand: args["expand"] === true,
  });
  try {
    appendMetric(ctx.vault, {
      surface: "recall_benchmark",
      runAt: isoSecond(now),
      payload: {
        total: report.total,
        k: report.k,
        expand: report.expand,
        hit_at_k: report.hitAtK,
        mrr: report.mrr,
        misses: report.perQuery.filter((q) => !q.hit).map((q) => q.id),
      },
    });
  } catch {
    // Metrics are observability, not correctness.
  }
  return {
    total: report.total,
    k: report.k,
    expand: report.expand,
    hit_at_k: report.hitAtK,
    mrr: report.mrr,
    per_query: report.perQuery,
  };
}

// ----- brain_tune (t_ae973491) -------------------------------------------------

/** Opt-in self-tuning recall: run the grid, inspect, or reset. */
async function toolBrainTune(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const op = args["operation"];
  if (op !== "run" && op !== "status" && op !== "reset") {
    throw new MCPError(INVALID_PARAMS, "brain_tune: operation must be run|status|reset");
  }
  const searchConfig = resolveSearchConfig({
    vault: ctx.vault,
    configPath: ctx.configPath ?? undefined,
  });
  if (op === "status") {
    return {
      enabled: searchConfig.recall.selfTuningEnabled,
      tuned: loadTunedParameters(ctx.vault),
    };
  }
  if (op === "reset") {
    return { removed: resetTuning(ctx.vault) };
  }
  const k = args["k"];
  if (k !== undefined && (!Number.isInteger(k) || (k as number) < 1)) {
    throw new MCPError(INVALID_PARAMS, "brain_tune run: k must be a positive integer");
  }
  let dataset;
  try {
    dataset = parseRecallBenchmarkDataset(args["dataset"]);
  } catch (exc) {
    throw new MCPError(INVALID_PARAMS, `brain_tune run: ${(exc as Error).message}`);
  }
  const now = new Date();
  const report = await tuneRecall(searchConfig, dataset, {
    ...(k !== undefined ? { k: k as number } : {}),
    now,
  });
  try {
    appendMetric(ctx.vault, {
      surface: "self_tuning",
      runAt: isoSecond(now),
      payload: {
        chosen: report.chosen,
        evaluated: report.evaluated.length,
        best_mrr: Math.max(...report.evaluated.map((e) => e.mrr)),
        dataset_hash: report.datasetHash,
      },
    });
  } catch {
    // Metrics are observability, not correctness.
  }
  return {
    chosen: report.chosen,
    evaluated: report.evaluated.map((e) => ({ params: e.params, mrr: e.mrr, hit_at_k: e.hitAtK })),
    dataset_hash: report.datasetHash,
  };
}

// ----- brain_dead_ends (t_be62c62d) -----------------------------------------

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
  // Write-vs-read cost meter (memory cost meter): folds write volume
  // against the read telemetry above. Period-based; mode/status/host/limit
  // do not apply to the write side, so reject them to mirror the CLI's
  // fail-closed behavior (recall-telemetry.ts costMeter) rather than
  // silently ignoring and looking like a valid filtered result.
  if (operation === "cost") {
    for (const name of ["mode", "status", "host", "limit"] as const) {
      if (args[name] !== undefined) {
        throw new MCPError(
          INVALID_PARAMS,
          `brain_recall_telemetry: ${name} is not supported for the cost meter`,
        );
      }
    }
    const writeCost = coerceNonNegativeNumber("write_cost", args["write_cost"]);
    const readCost = coerceNonNegativeNumber("read_cost", args["read_cost"]);
    const writeHeavyRatio = coerceNonNegativeNumber("write_heavy_ratio", args["write_heavy_ratio"]);
    const meter = computeMemoryCostMeter(ctx.vault, {
      ...(filter.since !== undefined ? { since: filter.since } : {}),
      ...(filter.until !== undefined ? { until: filter.until } : {}),
      ...(writeCost !== undefined || readCost !== undefined
        ? {
            weights: {
              ...(writeCost !== undefined ? { write: writeCost } : {}),
              ...(readCost !== undefined ? { read: readCost } : {}),
            },
          }
        : {}),
      ...(writeHeavyRatio !== undefined ? { writeHeavyRatio } : {}),
    });
    return { vault_path: ctx.vault, ...meter };
  }
  throw new MCPError(
    INVALID_PARAMS,
    "brain_recall_telemetry: operation must be list, summary, gate_list, gate_summary, or cost",
  );
}

function coerceNonNegativeNumber(name: string, raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new MCPError(
      INVALID_PARAMS,
      `brain_recall_telemetry: ${name} must be a non-negative number`,
    );
  }
  return raw;
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

// ----- brain_route_metrics (context-pack-economics-observability) -----------

async function toolBrainRouteMetrics(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = optionalStringArg("brain_route_metrics", args, "operation");
  const filter = routeMetricsFilter(args);

  if (operation === "list") {
    const records = listMcpRouteLatency(ctx.vault, filter);
    return { vault_path: ctx.vault, total: records.length, records };
  }
  if (operation === "summary") {
    const summary = summarizeMcpRouteLatency(ctx.vault, filter);
    return { ...summary };
  }
  throw new MCPError(INVALID_PARAMS, "brain_route_metrics: operation must be list or summary");
}

function routeMetricsFilter(args: Record<string, unknown>): McpRouteLatencyFilter {
  const tool = optionalStringArg("brain_route_metrics", args, "tool");
  const status = coerceRouteMetricsStatus(args["status"]);
  const since = optionalStringArg("brain_route_metrics", args, "since");
  const until = optionalStringArg("brain_route_metrics", args, "until");
  const limit = coercePositiveInteger("brain_route_metrics", "limit", args["limit"]);
  return {
    ...(tool !== undefined ? { tool } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

function coerceRouteMetricsStatus(raw: unknown): McpRouteStatus | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = typeof raw === "string" ? raw.trim() : raw;
  if (!isMcpRouteStatus(trimmed)) {
    throw new MCPError(INVALID_PARAMS, "brain_route_metrics: status must be ok or error");
  }
  return trimmed;
}

// ----- brain_token_impact (context-pack-economics-observability) ------------

/**
 * Durable token-impact + context-pack-quality ledger. `record`/`outcome`
 * write opt-in samples (gated on `token_impact_ledger_enabled`, payload-safe:
 * counts + opaque pack id only); `list`/`summary` read the ledger regardless
 * of the gate so historical aggregates stay inspectable.
 */
async function toolBrainTokenImpact(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = optionalStringArg("brain_token_impact", args, "operation");

  if (operation === "record") {
    const baselineTokens = coerceNonNegativeInteger(
      "brain_token_impact",
      "baseline_tokens",
      args["baseline_tokens"],
    );
    const packedTokens = coerceNonNegativeInteger(
      "brain_token_impact",
      "packed_tokens",
      args["packed_tokens"],
    );
    if (baselineTokens === undefined || packedTokens === undefined) {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_token_impact: record requires baseline_tokens and packed_tokens (non-negative integers)",
      );
    }
    const method = coerceTokenCountMethod(args["method"]) ?? "fallback";
    const modeledAvoided = coerceNonNegativeTokenValue(
      "brain_token_impact",
      "modeled_avoided_inferences",
      args["modeled_avoided_inferences"],
    );
    const modeledPerInference = coerceNonNegativeTokenValue(
      "brain_token_impact",
      "modeled_tokens_per_inference",
      args["modeled_tokens_per_inference"],
    );
    const enabled = resolveTokenImpactLedgerEnabled(ctx.configPath ?? undefined);
    const record = emitTokenImpact(
      ctx.vault,
      {
        baselineTokens,
        packedTokens,
        method,
        ...tokenImpactCorrelation(args),
        ...(modeledAvoided !== undefined ? { modeledAvoidedInferences: modeledAvoided } : {}),
        ...(modeledPerInference !== undefined
          ? { modeledTokensPerInference: modeledPerInference }
          : {}),
      },
      enabled || undefined,
    );
    if (record === null) {
      return { vault_path: ctx.vault, recorded: false, enabled };
    }
    return {
      vault_path: ctx.vault,
      recorded: true,
      enabled,
      id: record.id,
      method,
      baseline_tokens: baselineTokens,
      packed_tokens: packedTokens,
      delta_tokens: baselineTokens - packedTokens,
    };
  }

  if (operation === "outcome") {
    const outcome = coerceTokenImpactOutcome(args["outcome"]);
    if (outcome === undefined) {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_token_impact: outcome requires outcome (first_pass | repair | retry)",
      );
    }
    const tokensPerInference = coerceNonNegativeTokenValue(
      "brain_token_impact",
      "tokens_per_inference",
      args["tokens_per_inference"],
    );
    const enabled = resolveTokenImpactLedgerEnabled(ctx.configPath ?? undefined);
    const record = recordTokenImpactOutcome(
      ctx.vault,
      {
        outcome,
        ...tokenImpactCorrelation(args),
        ...(tokensPerInference !== undefined ? { tokensPerInference } : {}),
      },
      enabled || undefined,
    );
    if (record === null) {
      return { vault_path: ctx.vault, recorded: false, enabled };
    }
    return { vault_path: ctx.vault, recorded: true, enabled, id: record.id, outcome };
  }

  const filter = tokenImpactFilter(args);
  if (operation === "list") {
    const records = listTokenImpact(ctx.vault, filter);
    return { vault_path: ctx.vault, total: records.length, records };
  }
  if (operation === "summary") {
    return { vault_path: ctx.vault, ...summarizeTokenImpact(ctx.vault, filter) };
  }
  throw new MCPError(
    INVALID_PARAMS,
    "brain_token_impact: operation must be record, outcome, list, or summary",
  );
}

function tokenImpactCorrelation(args: Record<string, unknown>): {
  host?: string;
  sessionId?: string;
  turnId?: string;
  packId?: string;
} {
  const host = optionalStringArg("brain_token_impact", args, "host");
  const sessionId = optionalStringArg("brain_token_impact", args, "session_id");
  const turnId = optionalStringArg("brain_token_impact", args, "turn_id");
  const packId = optionalStringArg("brain_token_impact", args, "pack_id");
  return {
    ...(host !== undefined ? { host } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
    ...(packId !== undefined ? { packId } : {}),
  };
}

function tokenImpactFilter(args: Record<string, unknown>): TokenImpactFilter {
  const host = optionalStringArg("brain_token_impact", args, "host");
  const packId = optionalStringArg("brain_token_impact", args, "pack_id");
  const method = coerceTokenCountMethod(args["method"]);
  const since = optionalStringArg("brain_token_impact", args, "since");
  const until = optionalStringArg("brain_token_impact", args, "until");
  const limit = coercePositiveInteger("brain_token_impact", "limit", args["limit"]);
  const maxSamples = coercePositiveInteger(
    "brain_token_impact",
    "max_samples",
    args["max_samples"],
  );
  return {
    ...(host !== undefined ? { host } : {}),
    ...(packId !== undefined ? { packId } : {}),
    ...(method !== undefined ? { method } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(maxSamples !== undefined ? { maxSamples } : {}),
  };
}

function coerceTokenCountMethod(raw: unknown): TokenCountMethod | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = typeof raw === "string" ? raw.trim() : raw;
  if (!isTokenCountMethod(trimmed)) {
    throw new MCPError(INVALID_PARAMS, "brain_token_impact: method must be exact or fallback");
  }
  return trimmed;
}

function coerceTokenImpactOutcome(raw: unknown): TokenImpactOutcome | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = typeof raw === "string" ? raw.trim() : raw;
  if (!isTokenImpactOutcome(trimmed)) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_token_impact: outcome must be first_pass, repair, or retry",
    );
  }
  return trimmed;
}

function coerceNonNegativeInteger(tool: string, field: string, raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number") {
    if (!Number.isInteger(raw) || raw < 0) {
      throw new MCPError(INVALID_PARAMS, `${tool}: ${field} must be a non-negative integer`);
    }
    return raw;
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "" || !/^[0-9]+$/.test(trimmed)) {
      throw new MCPError(INVALID_PARAMS, `${tool}: ${field} must be a non-negative integer`);
    }
    return Number.parseInt(trimmed, 10);
  }
  throw new MCPError(INVALID_PARAMS, `${tool}: ${field} must be a non-negative integer`);
}

function coerceNonNegativeTokenValue(
  tool: string,
  field: string,
  raw: unknown,
): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  const value = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new MCPError(INVALID_PARAMS, `${tool}: ${field} must be a non-negative number`);
  }
  return value;
}

// ----- brain_knowledge_gaps (t_97091fff) -----------------------------------

async function toolBrainKnowledgeGaps(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const since = optionalStringArg("brain_knowledge_gaps", args, "since");
  const until = optionalStringArg("brain_knowledge_gaps", args, "until");
  const minOccurrences = coercePositiveInteger(
    "brain_knowledge_gaps",
    "min_occurrences",
    args["min_occurrences"],
  );
  const limit = coercePositiveInteger("brain_knowledge_gaps", "limit", args["limit"]);
  const maxSatisfaction = coerceUnitInterval("max_satisfaction", args["max_satisfaction"]);
  const report = aggregateQueryDemand(ctx.vault, {
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(minOccurrences !== undefined ? { minOccurrences } : {}),
    ...(maxSatisfaction !== undefined ? { maxSatisfaction } : {}),
    ...(limit !== undefined ? { limit } : {}),
  });
  return { vault_path: ctx.vault, ...serializeQueryDemandReport(report) };
}

function coerceUnitInterval(name: string, raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw new MCPError(INVALID_PARAMS, `brain_knowledge_gaps: ${name} must be a number in [0, 1]`);
  }
  return raw;
}

// ----- brain_context_presets ----------------------------------------------

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

export const RECALL_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_benchmark",
    description:
      "Recall-quality benchmark: score the vault's live hybrid recall against a fixed dataset ({queries: [{id, query, expected: [paths]}]}) - hit@k and MRR per query and aggregate - and record one recall_benchmark metric so quality is chartable over time.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", enum: ["run"], description: "Tool operation." },
        dataset: {
          type: "object",
          description: "Benchmark dataset: {queries: [{id, query, expected, k?}]}.",
        },
        k: { type: "integer", minimum: 1, description: "Rank depth (default 5)." },
        expand: { type: "boolean", description: "Route queries through deterministic expansion." },
      },
      required: ["operation", "dataset"],
      additionalProperties: false,
    },
    handler: toolBrainBenchmark,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_tune",
    description:
      "Opt-in self-tuning recall: run grid-evaluates bounded parameters (pool multiplier, traversal depth, learned weights, expansion) against a benchmark dataset and persists the winner to Brain/search/tuning.json; status shows the validated state; reset deletes it. Search honors it only when enabled.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["run", "status", "reset"],
          description: "Tool operation.",
        },
        dataset: { type: "object", description: "Benchmark dataset (run)." },
        k: { type: "integer", minimum: 1, description: "Rank depth (run, default 5)." },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainTune,
    previewBudget: MCP_PREVIEW_BUDGET,
  },
  {
    name: "brain_recall_telemetry",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "List recall telemetry records or summarize recall coverage and gaps; cost folds write volume (feedback/apply-evidence/note/host writes) against reads into a write-vs-read ratio, a write-heavy flag, and a rough cost signal per period. Emitted only by opt-in callers. Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list", "summary", "gate_list", "gate_summary", "cost"],
          description:
            "list/summary for recall telemetry; gate_list/gate_summary for recall-gate decisions; cost for the write-vs-read cost meter.",
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
        write_cost: {
          type: "number",
          minimum: 0,
          description: "cost: weight charged per write op (default 1).",
        },
        read_cost: {
          type: "number",
          minimum: 0,
          description: "cost: weight charged per read op (default 1).",
        },
        write_heavy_ratio: {
          type: "number",
          minimum: 0,
          description:
            "cost: write/read ratio above which the period is flagged write-heavy (default 1).",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainRecallTelemetry,
  },
  {
    name: "brain_route_metrics",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Route-level MCP latency: list mcp_route_latency records or summarize per-tool latency (count, errors, min/avg/max, p50/p95/p99) slowest-first to find slow surfaces by endpoint. Emitted only when mcp_route_metrics_enabled is on; payload-safe (tool, scope, status, duration, arg keys). Read-only.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["list", "summary"],
          description: "list for raw records; summary for per-tool latency roll-up.",
        },
        tool: {
          type: "string",
          description: "Optional filter by MCP tool name.",
        },
        status: {
          type: "string",
          enum: ["ok", "error"],
          description: "Optional filter by call status.",
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
    handler: toolBrainRouteMetrics,
  },
  {
    name: "brain_token_impact",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Durable value-of-memory ledger. `record`: a pack's tokenizer-exact prompt-token delta (baseline−packed; method exact|fallback) + optional modeled inference-avoidance. `outcome` calibrates the model. `summary` keeps EXACT separate from MODELED; `list` reads samples. Gated write; payload-safe.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: ["record", "outcome", "list", "summary"],
          description: "record/outcome write opt-in samples; list/summary read the durable ledger.",
        },
        baseline_tokens: {
          type: "integer",
          minimum: 0,
          description: "record: prompt-token cost WITHOUT the memory layer's compaction/selection.",
        },
        packed_tokens: {
          type: "integer",
          minimum: 0,
          description: "record: prompt-token cost the memory layer actually shipped.",
        },
        method: {
          type: "string",
          enum: ["exact", "fallback"],
          description:
            "How the counts were obtained: a real tokenizer (exact) or a heuristic estimate (fallback, the default). Also a list/summary filter.",
        },
        modeled_avoided_inferences: {
          type: "number",
          minimum: 0,
          description:
            "record (optional): modeled count of inferences (repairs/retries) the layer avoided.",
        },
        modeled_tokens_per_inference: {
          type: "number",
          minimum: 0,
          description: "record (optional): modeled average prompt tokens per avoided inference.",
        },
        outcome: {
          type: "string",
          enum: ["first_pass", "repair", "retry"],
          description: "outcome: the observed result used to calibrate the modeled ledger.",
        },
        tokens_per_inference: {
          type: "number",
          minimum: 0,
          description: "outcome (optional): observed prompt tokens for this inference.",
        },
        pack_id: {
          type: "string",
          description:
            "Opaque correlation id (a receipt id or request hash) — never a raw prompt. Also a list/summary filter.",
        },
        host: { type: "string", description: "Optional host/runtime label; also a filter." },
        session_id: { type: "string", description: "Optional session id recorded on the sample." },
        turn_id: { type: "string", description: "Optional turn id recorded on the sample." },
        since: { type: "string", description: "Optional inclusive lower timestamp bound." },
        until: { type: "string", description: "Optional inclusive upper timestamp bound." },
        limit: {
          type: "integer",
          minimum: 1,
          description: "Optional maximum record count for list.",
        },
        max_samples: {
          type: "integer",
          minimum: 1,
          description: "Optional cap on the most-recent samples aggregated by summary.",
        },
      },
      required: ["operation"],
      additionalProperties: false,
    },
    handler: toolBrainTokenImpact,
  },
  {
    name: "brain_knowledge_gaps",
    previewBudget: MCP_PREVIEW_BUDGET,
    description:
      "Cross-query demand gaps: aggregate the persisted recall demand log into recurring queries the vault answers poorly, ranked by frequency × (1 − IDF-weighted coverage). Read-only; log written only by opt-in recall telemetry.",
    inputSchema: {
      type: "object",
      properties: {
        min_occurrences: {
          type: "integer",
          minimum: 1,
          description: "Minimum times a query must recur to surface (default 2).",
        },
        max_satisfaction: {
          type: "number",
          minimum: 0,
          maximum: 1,
          description:
            "Surface only queries at/below this mean satisfaction (default 0.8) — i.e. not already answered well.",
        },
        since: { type: "string", description: "Optional inclusive lower timestamp bound." },
        until: { type: "string", description: "Optional inclusive upper timestamp bound." },
        limit: { type: "integer", minimum: 1, description: "Optional maximum gaps to return." },
      },
      additionalProperties: false,
    },
    handler: toolBrainKnowledgeGaps,
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
]);
