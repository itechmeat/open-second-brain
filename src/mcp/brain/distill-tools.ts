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
  parseDistillClaims,
} from "../../core/brain/distill/distill-source.ts";
import { ResponseShapeError } from "../../core/brain/response-shape.ts";
import { resolveAgentName } from "../../core/config.ts";
import { coerceStr } from "../coerce.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { wrapToolErrors } from "./shared.ts";

const TOOL = "brain_distill_source";

async function toolBrainDistillSource(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sourcePath = coerceStr(args, "source_path", true)!;
  const agentArg = coerceStr(args, "agent", false);
  const agent =
    agentArg && agentArg.trim().length > 0
      ? agentArg
      : resolveAgentName(ctx.configPath ?? undefined);

  return wrapToolErrors(TOOL, [DistillValidationError, ResponseShapeError], async () => {
    // Shape first: the payload is validated before a single claim is
    // normalized, so a malformed item aborts the whole batch unwritten.
    const claims = parseDistillClaims(args["claims"]);
    const res = distillSource(ctx.vault, { sourcePath, claims }, { agent, now: new Date() });
    return {
      distillation_path: res.distillationPath,
      created: res.created,
      claim_count: res.claimCount,
      // Omitted rather than reported as a sentinel when the source had no
      // bytes to hash: an absent key reads as "not recorded", where the
      // `missing` string this used to return read as a digest until you knew
      // better.
      ...(res.sourceHash !== undefined ? { source_hash: res.sourceHash } : {}),
      // The lane the page ACTUALLY landed in. Classifying the source a second
      // time here would be a second answer to one question, free to disagree
      // with the write that already happened.
      trust: res.trust,
    };
  });
}

export const DISTILL_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    // The guarantee is stated here, in the idiom `brain_intake_entities` uses:
    // a caller choosing a tool reads this, and a write that quarantines what it
    // just wrote must say so where the choice is made. The parameter-by-
    // parameter recital the description used to open with was dropped to make
    // room within `TOOL_DESCRIPTION_MAX` - every one of those facts is already
    // in the `inputSchema` property descriptions below, and the guarantee was
    // nowhere.
    description:
      "Distill one source into atomic claims with block-level provenance; runs no model. Writes one idempotent page citing each claim as `[[source#^block]]`. The page is marked `untrusted_source` and excluded from ordinary reads unless `source_path` names a file that exists; `trust` reports the lane.",
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
