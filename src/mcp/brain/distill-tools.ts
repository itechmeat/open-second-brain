/**
 * Source-distillation tool (Ingestion & Import Robustness suite, t_2e2e959f).
 *
 * The calling agent reads a source and distills it into atomic claims, each
 * with an optional block id pointing back to the source block it came from,
 * and submits them here. OSB runs no model - it validates the claims and writes
 * one idempotent distillation page per source, listing each claim with its
 * block-level citation and a provenance section.
 */

import {
  distillSource,
  DistillValidationError,
  normalizeClaim,
  type DistillClaim,
} from "../../core/brain/distill/distill-source.ts";
import { resolveAgentName } from "../../core/config.ts";
import { coerceStr } from "../coerce.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { wrapToolErrors } from "./shared.ts";

const TOOL = "brain_distill_source";

/** Coerce the `claims` arg into DistillClaim[], rejecting a malformed shape. */
function parseClaims(args: Record<string, unknown>): DistillClaim[] {
  const raw = args["claims"];
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new MCPError(INVALID_PARAMS, `${TOOL}: 'claims' must be a non-empty array`);
  }
  return raw.map((item, i) => {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      throw new MCPError(INVALID_PARAMS, `${TOOL}: claim ${i} must be an object`);
    }
    return normalizeClaim(item as Record<string, unknown>);
  });
}

async function toolBrainDistillSource(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sourcePath = coerceStr(args, "source_path", true)!;
  const claims = parseClaims(args);
  const agentArg = coerceStr(args, "agent", false);
  const agent =
    agentArg && agentArg.trim().length > 0
      ? agentArg
      : resolveAgentName(ctx.configPath ?? undefined);

  return wrapToolErrors(TOOL, [DistillValidationError], async () => {
    const res = distillSource(ctx.vault, { sourcePath, claims }, { agent, now: new Date() });
    return {
      distillation_path: res.distillationPath,
      created: res.created,
      claim_count: res.claimCount,
      source_hash: res.sourceHash,
    };
  });
}

export const DISTILL_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    description:
      "Distill one source into atomic claims with block-level provenance. Supply `source_path` (vault path or URL) and `claims`: a non-empty array of { text, block? } (`block` is the source's Obsidian block id). Writes one idempotent page citing each claim as `[[source#^block]]`. No model.",
    inputSchema: {
      type: "object",
      properties: {
        source_path: {
          type: "string",
          description: "Source identity: a vault-relative path or a URL.",
        },
        claims: {
          type: "array",
          description: "Atomic claims distilled from the source (non-empty).",
          items: {
            type: "object",
            properties: {
              text: { type: "string", description: "The atomic claim text." },
              block: {
                type: "string",
                description: "Optional source block id the claim was drawn from (the `^abc` id).",
              },
            },
            required: ["text"],
            additionalProperties: false,
          },
        },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
      },
      required: ["source_path", "claims"],
      additionalProperties: false,
    },
    handler: toolBrainDistillSource,
  },
]);
