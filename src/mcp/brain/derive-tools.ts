/**
 * Derived-fact synthesis tool (Knowledge Provenance suite).
 *
 * The calling agent reasons a second-order conclusion from existing premise
 * preferences and submits it here. OSB runs no model: it validates that each
 * premise exists and commits the conclusion as an unconfirmed preference
 * carrying a `deduced`/`inferred` provenance level and premise wikilinks.
 *
 * Opt-in: gated by the `derived_fact_synthesis` guardrail. With the flag off
 * the tool refuses (the feature is not enabled), so no derived facts are
 * produced and the brain is unchanged.
 */

import { deriveFact, DeriveFactError } from "../../core/brain/derived-fact.ts";
import { loadGuardrailsConfigSafe } from "../../core/brain/policy.ts";
import { asProvenanceLevel } from "../../core/brain/provenance/provenance.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { coerceStr, coerceStrList } from "../coerce.ts";
import { wrapToolErrors } from "./shared.ts";

const TOOL = "brain_derive_fact";

async function toolBrainDeriveFact(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return wrapToolErrors(TOOL, [DeriveFactError], async () => {
    if (!loadGuardrailsConfigSafe(ctx.vault).derived_fact_synthesis) {
      throw new MCPError(
        INVALID_PARAMS,
        `${TOOL}: derived-fact synthesis is off; enable guardrails.derived_fact_synthesis in _brain.yaml`,
      );
    }

    const slug = coerceStr(args, "slug", true)!;
    const topic = coerceStr(args, "topic", true)!;
    const principle = coerceStr(args, "principle", true)!;
    const levelRaw = coerceStr(args, "level", true)!;
    const level = asProvenanceLevel(levelRaw);
    if (level === null || level === "stated") {
      throw new MCPError(INVALID_PARAMS, `${TOOL}: 'level' must be 'deduced' or 'inferred'`);
    }
    const premises = coerceStrList(args, "premises");
    if (premises.length === 0) {
      throw new MCPError(INVALID_PARAMS, `${TOOL}: 'premises' must list at least one premise id`);
    }

    const res = deriveFact(
      ctx.vault,
      { slug, topic, principle, premises, level },
      { now: new Date() },
    );
    return { id: res.id, level, premises };
  });
}

export const DERIVE_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    description:
      "Commit a derived fact (a conclusion the agent reasoned from premises) as an unconfirmed preference with premise provenance. Supply `slug`, `topic`, `principle`, `premises` (ids), and `level` (deduced/inferred). OSB validates each premise exists. Opt-in: requires guardrails.derived_fact_synthesis.",
    inputSchema: {
      type: "object",
      properties: {
        slug: { type: "string", description: "Kebab slug for the derived preference." },
        topic: { type: "string", description: "Topic anchor for the derived fact." },
        principle: { type: "string", description: "The conclusion, in imperative voice." },
        premises: {
          type: "array",
          items: { type: "string" },
          description: "Premise preference ids (`pref-<slug>` or bare `<slug>`); at least one.",
        },
        level: {
          type: "string",
          enum: ["deduced", "inferred"],
          description: "'deduced' = logically entailed; 'inferred' = a generalized pattern.",
        },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
      },
      required: ["slug", "topic", "principle", "premises", "level"],
      additionalProperties: false,
    },
    handler: toolBrainDeriveFact,
  },
]);
