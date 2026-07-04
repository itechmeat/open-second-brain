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
  describeSessionRecall,
  expandSessionRecall,
  searchSessionRecall,
} from "../../core/brain/session-recall.ts";
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
  // do not apply to the write side and are ignored here.
  if (operation === "cost") {
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
