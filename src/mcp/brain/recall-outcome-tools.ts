/**
 * The context-pack economics tools (task 3.19): `brain_context_pack_outcome`
 * and `brain_knowledge_gaps`, with the correlation, evidence-claim and
 * filter helpers their answers render. Split from `recall-tools.ts`;
 * registration happens through that module's registry, which preserves
 * the public RECALL_TOOLS surface.
 */

import {
  listContextPackOutcomes,
  postContextPackOutcome,
  summarizeContextPackOutcomes,
  type ContextPackOutcomeFilter,
} from "../../core/brain/context-pack-outcome.ts";
import {
  CONTEXT_PACK_EVIDENCE_FIELD,
  type ContextPackEvidenceClaim,
} from "../../core/brain/context-pack-evidence.ts";
import { resolveContextPackOutcomeEnabled } from "../../core/config.ts";
import { aggregateQueryDemand, serializeQueryDemandReport } from "../../core/brain/query-demand.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext } from "../tool-contract.ts";
import { vaultPathField } from "../vault-path-field.ts";
import { coercePositiveInteger, optionalStringArg, requiredStringArg } from "./shared.ts";
import { unknownOperationError } from "../coerce.ts";
import { coerceNonNegativeInteger, coerceNonNegativeTokenValue } from "./recall-coerce-tools.ts";

// ----- brain_context_pack_outcome (context-pack-economics-observability) ----

/**
 * Agent-operable context-pack outcome loop. `post` writes one compact
 * outcome row (gated on `context_pack_outcome_enabled`, payload-safe:
 * counters + an opaque sample id only), composes the C3 ledger by posting
 * a matching first-pass/repair/retry calibration record, and composes the
 * evidence half by posting the kernel's own reading of the sample beside
 * the agent's claim. All three rows join on the one sample id and carry
 * the same acting agent. `list`/`summary` read the rows regardless of the
 * gate so historical aggregates stay inspectable. The three token signals
 * (exact/modeled/observed) stay strictly separate; a field the caller omits
 * is never invented.
 */
export async function toolBrainContextPackOutcome(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = optionalStringArg("brain_context_pack_outcome", args, "operation");

  if (operation === "post") {
    const sampleId = requiredStringArg("brain_context_pack_outcome", args, "sample_id");
    const firstPassSuccess = coerceBoolean(args["first_pass_success"]);
    if (firstPassSuccess === undefined) {
      throw new MCPError(
        INVALID_PARAMS,
        "brain_context_pack_outcome: post requires first_pass_success (boolean)",
      );
    }
    const repairRequired = coerceBoolean(args["repair_required"]);
    const retryCount = coerceNonNegativeInteger(
      "brain_context_pack_outcome",
      "retry_count",
      args["retry_count"],
    );
    const followUpTokens = coerceNonNegativeInteger(
      "brain_context_pack_outcome",
      "follow_up_tokens",
      args["follow_up_tokens"],
    );
    const exact = coerceNonNegativeTokenValue(
      "brain_context_pack_outcome",
      "exact_prompt_token_savings",
      args["exact_prompt_token_savings"],
    );
    const modeled = coerceNonNegativeTokenValue(
      "brain_context_pack_outcome",
      "modeled_inference_avoidance",
      args["modeled_inference_avoidance"],
    );
    const observed = coerceNonNegativeTokenValue(
      "brain_context_pack_outcome",
      "observed_provider_tokens",
      args["observed_provider_tokens"],
    );
    const evidenceClaim = contextPackEvidenceClaim(args["evidence_claim"]);
    const enabled = resolveContextPackOutcomeEnabled(ctx.configPath ?? undefined);
    const post = postContextPackOutcome(
      ctx.vault,
      {
        sampleId,
        firstPassSuccess,
        ...contextPackOutcomeCorrelation(args),
        // Omit-don't-invent: only forward fields the caller actually supplied.
        ...(repairRequired !== undefined ? { repairRequired } : {}),
        ...(retryCount !== undefined ? { retryCount } : {}),
        ...(followUpTokens !== undefined ? { followUpTokens } : {}),
        ...(exact !== undefined ? { exactPromptTokenSavings: exact } : {}),
        ...(modeled !== undefined ? { modeledInferenceAvoidance: modeled } : {}),
        ...(observed !== undefined ? { observedProviderTokens: observed } : {}),
        ...(evidenceClaim !== undefined ? { evidenceClaim } : {}),
      },
      enabled || undefined,
    );
    if (post === null) {
      return { vault_path: vaultPathField(ctx), recorded: false, enabled };
    }
    return {
      vault_path: vaultPathField(ctx),
      recorded: true,
      enabled,
      id: post.outcome.id,
      sample_id: sampleId,
      first_pass_success: firstPassSuccess,
      // The kernel's reading of this sample, surfaced so a contradicted
      // claim is visible to the poster and not only to a later reader.
      // Absent when the evidence half fail-opened - reporting a verdict
      // that was never written would be the fallback this project bans.
      ...(post.evidence !== null ? { evidence: post.evidence.payload } : {}),
    };
  }

  const filter = contextPackOutcomeFilter(args);
  if (operation === "list") {
    const records = listContextPackOutcomes(ctx.vault, filter);
    return { vault_path: vaultPathField(ctx), total: records.length, records };
  }
  if (operation === "summary") {
    return { vault_path: vaultPathField(ctx), ...summarizeContextPackOutcomes(ctx.vault, filter) };
  }
  throw unknownOperationError(
    "brain_context_pack_outcome: operation must be post, list, or summary",
  );
}

/**
 * The correlation keys a `post` records, read from the caller's arguments.
 *
 * `agent_id` is the ACTING agent, and it is an ARGUMENT rather than
 * `ServerContext.agentName` deliberately. That getter resolves the plugin
 * config on every access and RAISES on a config that is present but
 * unreadable - correctly, since the alternative is writing under a guessed
 * identity - so consulting it here would let one broken line in an
 * unrelated file turn a working telemetry post into a tool error. The
 * identity a client asserts is exactly as self-asserted as the one the
 * config holds and costs nothing when the config is broken, so it is the
 * one this row carries. Omitted stays omitted: no identity is invented.
 */
export function contextPackOutcomeCorrelation(args: Record<string, unknown>): {
  host?: string;
  sessionId?: string;
  turnId?: string;
  agentId?: string;
} {
  const host = optionalStringArg("brain_context_pack_outcome", args, "host");
  const sessionId = optionalStringArg("brain_context_pack_outcome", args, "session_id");
  const turnId = optionalStringArg("brain_context_pack_outcome", args, "turn_id");
  const agentId = optionalStringArg("brain_context_pack_outcome", args, "agent_id");
  return {
    ...(host !== undefined ? { host } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(turnId !== undefined ? { turnId } : {}),
    ...(agentId !== undefined ? { agentId } : {}),
  };
}

/**
 * The acting agent's assertion about the sample, coerced at the tool
 * boundary. A malformed member is REFUSED here rather than dropped: a
 * claim silently discarded would land an evidence record reading
 * `unclaimed`, which asserts the agent said nothing when in fact it said
 * something unusable.
 */
export function contextPackEvidenceClaim(raw: unknown): ContextPackEvidenceClaim | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "object" || Array.isArray(raw)) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_context_pack_outcome: evidence_claim must be an object",
    );
  }
  const claim = raw as Record<string, unknown>;
  const finalTextHash = optionalStringArg(
    "brain_context_pack_outcome",
    claim,
    CONTEXT_PACK_EVIDENCE_FIELD.finalTextHash,
  );
  const itemCount = coerceNonNegativeInteger(
    "brain_context_pack_outcome",
    CONTEXT_PACK_EVIDENCE_FIELD.itemCount,
    claim[CONTEXT_PACK_EVIDENCE_FIELD.itemCount],
  );
  const finalTextChars = coerceNonNegativeInteger(
    "brain_context_pack_outcome",
    CONTEXT_PACK_EVIDENCE_FIELD.finalTextChars,
    claim[CONTEXT_PACK_EVIDENCE_FIELD.finalTextChars],
  );
  if (finalTextHash === undefined && itemCount === undefined && finalTextChars === undefined) {
    return undefined;
  }
  return {
    ...(finalTextHash !== undefined ? { finalTextHash } : {}),
    ...(itemCount !== undefined ? { itemCount } : {}),
    ...(finalTextChars !== undefined ? { finalTextChars } : {}),
  };
}

export function contextPackOutcomeFilter(args: Record<string, unknown>): ContextPackOutcomeFilter {
  const host = optionalStringArg("brain_context_pack_outcome", args, "host");
  const sampleId = optionalStringArg("brain_context_pack_outcome", args, "sample_id");
  const since = optionalStringArg("brain_context_pack_outcome", args, "since");
  const until = optionalStringArg("brain_context_pack_outcome", args, "until");
  const limit = coercePositiveInteger("brain_context_pack_outcome", "limit", args["limit"]);
  const maxSamples = coercePositiveInteger(
    "brain_context_pack_outcome",
    "max_samples",
    args["max_samples"],
  );
  return {
    ...(host !== undefined ? { host } : {}),
    ...(sampleId !== undefined ? { sampleId } : {}),
    ...(since !== undefined ? { since } : {}),
    ...(until !== undefined ? { until } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(maxSamples !== undefined ? { maxSamples } : {}),
  };
}

export function coerceBoolean(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "boolean") return raw;
  if (raw === "true") return true;
  if (raw === "false") return false;
  throw new MCPError(
    INVALID_PARAMS,
    "brain_context_pack_outcome: boolean fields must be true or false",
  );
}

// ----- brain_knowledge_gaps (t_97091fff) -----------------------------------

export async function toolBrainKnowledgeGaps(
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
  return { vault_path: vaultPathField(ctx), ...serializeQueryDemandReport(report) };
}

export function coerceUnitInterval(name: string, raw: unknown): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw new MCPError(INVALID_PARAMS, `brain_knowledge_gaps: ${name} must be a number in [0, 1]`);
  }
  return raw;
}
