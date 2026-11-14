/**
 * The telemetry and economics tools of the recall family (task 3.19):
 * the argument coercers they share, `brain_route_metrics`,
 * `brain_retrieval_plan` and `brain_token_impact`. Split from
 * `recall-tools.ts`; registration happens through that module's
 * registry, which preserves the public RECALL_TOOLS surface.
 */

import {
  isRecallChannel,
  isRecallTelemetryMode,
  isRecallTelemetryStatus,
  RECALL_CHANNELS,
  RECALL_TELEMETRY_MODES,
  RECALL_TELEMETRY_STATUSES,
  type RecallChannel,
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
  normalizeTokenCountMethod,
  TOKEN_COUNT_METHOD,
  TOKEN_COUNT_METHODS,
  isTokenImpactOutcome,
  listTokenImpact,
  recordTokenImpactOutcome,
  summarizeTokenImpact,
  type TokenCountMethod,
  type TokenImpactFilter,
  type TokenImpactOutcome,
} from "../../core/brain/token-impact.ts";
import { resolveTokenImpactLedgerEnabled } from "../../core/config.ts";
import { buildRetrievalPlan, serializeRetrievalPlan } from "../../core/brain/retrieval-plan.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext } from "../tool-contract.ts";
import { vaultPathField } from "../vault-path-field.ts";
import { coercePositiveInteger, optionalStringArg, requiredStringArg } from "./shared.ts";
import { coerceAgentScope, unknownOperationError } from "../coerce.ts";

export function coerceNonNegativeNumber(name: string, raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    throw new MCPError(
      INVALID_PARAMS,
      `brain_recall_telemetry: ${name} must be a non-negative number`,
    );
  }
  return raw;
}

export function recallTelemetryFilter(args: Record<string, unknown>): RecallTelemetryFilter {
  const mode = coerceRecallTelemetryMode(args["mode"]);
  const status = coerceRecallTelemetryStatus(args["status"]);
  const channel = coerceRecallChannel(args["channel"]);
  const host = optionalStringArg("brain_recall_telemetry", args, "host");
  const since = optionalStringArg("brain_recall_telemetry", args, "since");
  const until = optionalStringArg("brain_recall_telemetry", args, "until");
  const limit = coercePositiveInteger("brain_recall_telemetry", "limit", args["limit"]);
  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(channel !== undefined ? { channel } : {}),
    ...(host !== undefined ? { host } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(limit !== undefined ? { limit } : {}),
  };
}

export function coerceRecallTelemetryMode(raw: unknown): RecallTelemetryMode | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = typeof raw === "string" ? raw.trim() : raw;
  // Rendered from the frozen member list. The prose copy this replaces
  // omitted `query`, and so did the schema enum below it, so a mode the
  // server records was refused at its own boundary.
  if (!isRecallTelemetryMode(trimmed)) {
    throw new MCPError(
      INVALID_PARAMS,
      `brain_recall_telemetry: mode must be one of ${RECALL_TELEMETRY_MODES.join(", ")}`,
    );
  }
  return trimmed;
}

export function coerceRecallTelemetryStatus(raw: unknown): RecallTelemetryStatus | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = typeof raw === "string" ? raw.trim() : raw;
  if (!isRecallTelemetryStatus(trimmed)) {
    throw new MCPError(
      INVALID_PARAMS,
      `brain_recall_telemetry: status must be one of ${RECALL_TELEMETRY_STATUSES.join(", ")}`,
    );
  }
  return trimmed;
}

export function coerceRecallChannel(raw: unknown): RecallChannel | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = typeof raw === "string" ? raw.trim() : raw;
  if (!isRecallChannel(trimmed)) {
    throw new MCPError(
      INVALID_PARAMS,
      `brain_recall_telemetry: channel must be one of ${RECALL_CHANNELS.join(", ")}`,
    );
  }
  return trimmed;
}

// ----- brain_route_metrics (context-pack-economics-observability) -----------

export async function toolBrainRouteMetrics(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = optionalStringArg("brain_route_metrics", args, "operation");
  const filter = routeMetricsFilter(args);

  if (operation === "list") {
    const records = listMcpRouteLatency(ctx.vault, filter);
    return { vault_path: vaultPathField(ctx), total: records.length, records };
  }
  if (operation === "summary") {
    const summary = summarizeMcpRouteLatency(ctx.vault, filter);
    return { vault_path: vaultPathField(ctx), ...summary };
  }
  throw unknownOperationError("brain_route_metrics: operation must be list or summary");
}

// ----- brain_retrieval_plan (shadow-only retrieval advisor, t_3ffb021c) -----

export async function toolBrainRetrievalPlan(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const question = requiredStringArg("brain_retrieval_plan", args, "question");
  const tokenBudget = coercePositiveInteger(
    "brain_retrieval_plan",
    "token_budget",
    args["token_budget"],
  );
  const agentScope = coerceAgentScope(ctx, args, true);
  const plan = buildRetrievalPlan(ctx.vault, question, {
    ...(tokenBudget !== undefined ? { tokenBudget } : {}),
    ...(agentScope !== undefined ? { agentScope } : {}),
  });
  return { vault_path: vaultPathField(ctx), ...serializeRetrievalPlan(plan) };
}

export function routeMetricsFilter(args: Record<string, unknown>): McpRouteLatencyFilter {
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

export function coerceRouteMetricsStatus(raw: unknown): McpRouteStatus | undefined {
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
export async function toolBrainTokenImpact(
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
    const method = coerceTokenCountMethod(args["method"]) ?? TOKEN_COUNT_METHOD.heuristic;
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
      return { vault_path: vaultPathField(ctx), recorded: false, enabled };
    }
    return {
      vault_path: vaultPathField(ctx),
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
      return { vault_path: vaultPathField(ctx), recorded: false, enabled };
    }
    return { vault_path: vaultPathField(ctx), recorded: true, enabled, id: record.id, outcome };
  }

  const filter = tokenImpactFilter(args);
  if (operation === "list") {
    const records = listTokenImpact(ctx.vault, filter);
    return { vault_path: vaultPathField(ctx), total: records.length, records };
  }
  if (operation === "summary") {
    return { vault_path: vaultPathField(ctx), ...summarizeTokenImpact(ctx.vault, filter) };
  }
  throw unknownOperationError(
    "brain_token_impact: operation must be record, outcome, list, or summary",
  );
}

export function tokenImpactCorrelation(args: Record<string, unknown>): {
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

export function tokenImpactFilter(args: Record<string, unknown>): TokenImpactFilter {
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

export function coerceTokenCountMethod(raw: unknown): TokenCountMethod | undefined {
  if (raw === undefined || raw === null) return undefined;
  const trimmed = typeof raw === "string" ? raw.trim() : raw;
  // Legacy-aware: an adapter still posting the pre-rename `exact` /
  // `fallback` labels is translated rather than rejected, so upgrading the
  // server does not silently stop recording an existing caller's samples.
  const method = normalizeTokenCountMethod(trimmed);
  if (method === null) {
    throw new MCPError(
      INVALID_PARAMS,
      `brain_token_impact: method must be one of ${TOKEN_COUNT_METHODS.join(", ")}`,
    );
  }
  return method;
}

export function coerceTokenImpactOutcome(raw: unknown): TokenImpactOutcome | undefined {
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

export function coerceNonNegativeInteger(
  tool: string,
  field: string,
  raw: unknown,
): number | undefined {
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

export function coerceNonNegativeTokenValue(
  tool: string,
  field: string,
  raw: unknown,
): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  // Reject empty/whitespace-only strings explicitly: Number("") and
  // Number("   ".trim()) both coerce to 0 and would otherwise be written to the
  // durable ledger as a fabricated zero. Mirrors coerceNonNegativeInteger above.
  if (typeof raw === "string" && raw.trim() === "") {
    throw new MCPError(INVALID_PARAMS, `${tool}: ${field} must be a non-negative number`);
  }
  const value = typeof raw === "string" ? Number(raw.trim()) : raw;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new MCPError(INVALID_PARAMS, `${tool}: ${field} must be a non-negative number`);
  }
  return value;
}
