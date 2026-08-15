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
    // just wrote must say so where the choice is made.
    //
    // It is stated CONDITIONALLY, and the condition is named. This sentence
    // used to assert that the page was "excluded from ordinary reads", which
    // was false on a default install: the exclusion is `trustGateAdjuster`,
    // which `search/pipeline/post-rank.ts` mounts only when
    // `recall.retrievalTrustGateEnabled` is set, and that flag falls back to
    // `false`. The marker is written correctly and `classifyRetrievalTrust`
    // reads it correctly - nothing mounts the gate.
    //
    // Making it true by default was the other option and is not taken here.
    // Flipping the flag turns on three signals at once, changes the search
    // result shape (the trust receipts stop being null), the cache slot key and
    // the explain envelope - a release-wide decision that does not belong to a
    // tool description. Mounting a partial gate for this one signal would
    // exclude pages with no receipt to say so, which is the silent drop this
    // project forbids. So the limit is admitted instead, with the setting
    // named, and `tests/cli/distill-trust-lane.test.ts` proves both halves:
    // the default returns the page, the setting stops returning it.
    //
    // Note the asymmetry with `brain_intake_entities`, whose quarantine holds
    // by DEFAULT: it works through `status: quarantine` plus the entity page
    // status scope, which nothing gates. The same words mean less here.
    description:
      "Distill one source into atomic claims; runs no model. Writes one idempotent page citing each claim as `[[source#^block]]`. A source outside this vault is marked `untrusted_source`, which ordinary reads still return unless `search_trust_gate_enabled` is on. `trust` names the lane.",
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
