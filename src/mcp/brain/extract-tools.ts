/**
 * Session signal-mining tool (salience-lifecycle-enrichment, unit 2,
 * t_1dace26d).
 *
 * One tool, two phases, mirroring the CLI verb. Called without `items`
 * it is read-only and returns the mining plan plus the single
 * needs-llm-step envelope; called with `items` it validates the answer
 * and writes the accepted ones as speculative inbox signals. OSB runs no
 * model on either path.
 */

import { commitExtractedSignals, ExtractSignalsError } from "../../core/brain/extract-signals.ts";
import { loadDedupIndex } from "../../core/brain/dedup-hash.ts";
import {
  planExtractSignalsPrefiltered,
  recordExtractPrefilterCommit,
  resolveExtractPrefilterConfig,
} from "../../core/brain/extract-signals-prefilter.ts";
import { ResponseCheckError } from "../../core/brain/response-checks.ts";
import { ResponseShapeError } from "../../core/brain/response-shape.ts";
import { resolveAgentName, resolveTokenImpactLedgerEnabled } from "../../core/config.ts";
import { coerceStr } from "../coerce.ts";
import { MCP_PREVIEW_BUDGET } from "../preview-budget.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { vaultRelativeSafe, wrapToolErrors } from "./shared.ts";

const TOOL = "brain_extract_signals";

/** The refusal classes this tool reports as caller errors, not server faults. */
const NAMED_REFUSALS = [ExtractSignalsError, ResponseShapeError, ResponseCheckError];

async function toolBrainExtractSignals(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const session = coerceStr(args, "session", true)!;
  const agentArg = coerceStr(args, "agent", false);
  const agent =
    agentArg && agentArg.trim().length > 0
      ? agentArg
      : resolveAgentName(ctx.configPath ?? undefined);

  return wrapToolErrors(TOOL, NAMED_REFUSALS, async () => {
    // Absent `items` is the plan phase. An empty array is NOT: it is an
    // answer claiming the session states nothing, and it goes through the
    // validators like any other so the caller gets one contract.
    const decisionModel = resolveExtractPrefilterConfig(ctx.vault, ctx.configPath ?? undefined);
    if (args["items"] === undefined) {
      const plan = await planExtractSignalsPrefiltered(ctx.vault, session, {
        now: new Date(),
        decisionModel,
        tokenImpactEnabled:
          decisionModel !== null && resolveTokenImpactLedgerEnabled(ctx.configPath ?? undefined),
      });
      return {
        phase: "plan",
        session_id: plan.sessionId,
        generated_at: plan.generatedAt,
        boundary_decision: plan.boundaryDecision,
        turns_scanned: plan.turnsScanned,
        turns_mined: plan.turnsMined.map((t) => ({
          turn_id: t.turnId,
          text: t.text,
          timestamp: t.timestamp,
        })),
        cap: plan.cap,
        confidence_floor: plan.confidenceFloor,
        llm_step: plan.llmStep,
        // Optional fields, present only while the decision-model turn
        // pre-filter is on (never with the use `off`).
        ...(plan.turnsDropped !== undefined ? { turns_dropped: plan.turnsDropped } : {}),
        ...(plan.skipped !== undefined
          ? {
              skipped: {
                reason: plan.skipped.reason,
                turns_dropped: plan.skipped.turnsDropped,
              },
            }
          : {}),
        ...(plan.decisionModel !== undefined
          ? { decision_model: { degraded: plan.decisionModel.degraded } }
          : {}),
      };
    }
    const now = new Date();
    const res = commitExtractedSignals(
      ctx.vault,
      session,
      { items: args["items"] },
      // Loaded with parallel I/O here, where the tool can await it.
      { agent, now, dedup: await loadDedupIndex(ctx.vault) },
    );
    recordExtractPrefilterCommit(ctx.vault, decisionModel, res, now);
    return {
      phase: "commit",
      session_id: res.sessionId,
      // Vault-relative, like every other path this server emits: an MCP
      // response lands in model context, and the absolute host path is
      // not this surface's to hand out.
      written: res.written.map((w) => ({
        id: w.id,
        path: vaultRelativeSafe(ctx.vault, w.path),
        topic: w.topic,
      })),
      staged: res.staged,
      deduped: res.deduped,
      durability_rejected: res.durabilityRejected,
      rejected: res.rejected.map((r) => ({ topic: r.topic, reason: r.reason })),
    };
  });
}

export const EXTRACT_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    description:
      "Mine taste signals from an imported session's USER turns; runs no model. Without `items` returns the turns plus one needs-llm-step envelope. With `items` writes them to Brain/inbox/ as speculative `source_type: auto_extract` signals. Refuses over-cap, under-floor or repeated-topic payloads.",
    inputSchema: {
      type: "object",
      properties: {
        session: {
          type: "string",
          description: "Recall session id of an already-imported session.",
        },
        items: {
          type: "array",
          description: "Mined signals; omit to get the plan and the envelope instead.",
          items: {
            type: "object",
            properties: {
              topic: {
                type: "string",
                description: "Stable kebab-slug naming the rule, unique within the payload.",
              },
              signal: {
                type: "string",
                enum: ["positive", "negative"],
                description: "positive = the rule to follow; negative = what to avoid.",
              },
              principle: {
                type: "string",
                description: "One imperative line stating the rule.",
              },
              confidence: {
                type: "number",
                description: "How sure the caller is; items under the floor refuse the payload.",
              },
              scope: {
                type: "string",
                description: "Optional soft category, e.g. `writing`, `coding`.",
              },
              source_turn: {
                type: "string",
                description: "Optional id of the plan turn the rule was stated in.",
              },
            },
            required: ["topic", "signal", "principle", "confidence"],
            additionalProperties: false,
          },
        },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
      },
      required: ["session"],
      additionalProperties: false,
    },
    previewBudget: MCP_PREVIEW_BUDGET,
    handler: toolBrainExtractSignals,
  },
]);
