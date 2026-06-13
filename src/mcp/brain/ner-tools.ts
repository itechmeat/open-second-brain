/**
 * Agent-driven entity intake (model-based NER, Knowledge Provenance suite).
 *
 * Open Second Brain is provider-agnostic: it never runs an entity-recognition
 * model. The calling agent (which owns its model) extracts entities from free
 * note text and submits them here; OSB validates the typed payload and commits
 * it through the shared extraction-intake primitive into the canonical entity
 * registry. No ML dependency is bundled.
 *
 * This is opt-in and non-blocking by construction: a plain note write never
 * triggers it. The agent invokes the tool when it wants discovered entities
 * registered, so extraction adds no latency or token cost to an ordinary save.
 * The contract is structural - the agent returns typed entity/concept records;
 * OSB never matches a natural-language entity-type word list.
 */

import { intakeExtraction, IntakeValidationError } from "../../core/brain/intake/extract-intake.ts";
import { resolveAgentName } from "../../core/config.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tools.ts";
import { parseExtractionIntakeArgs } from "./intake-args.ts";

const TOOL = "brain_intake_entities";

async function toolBrainIntakeEntities(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const parsed = parseExtractionIntakeArgs(args, TOOL);
  const agent =
    parsed.agent && parsed.agent.trim().length > 0
      ? parsed.agent
      : resolveAgentName(ctx.configPath ?? undefined);
  try {
    const result = intakeExtraction(ctx.vault, parsed.intake, {
      agent,
      now: new Date(),
      ...(parsed.provenance !== undefined ? { provenance: parsed.provenance } : {}),
    });
    return {
      entities_created: [...result.entitiesCreated],
      entities_updated: [...result.entitiesUpdated],
      relations_applied: result.relationsApplied,
    };
  } catch (err) {
    // A malformed extraction is a client-resolvable input problem, not a
    // server fault - surface it as INVALID_PARAMS, never a fabricated result.
    if (err instanceof IntakeValidationError) {
      throw new MCPError(INVALID_PARAMS, `${TOOL}: ${err.message}`);
    }
    if (err instanceof MCPError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new MCPError(INTERNAL_ERROR, `${TOOL}: ${reason}`);
  }
}

export const NER_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    description:
      "Intake entities the agent extracted from note text into the entity registry (OSB runs no model). Supply `entities` (category, name, optional aliases/confidence), optional typed `relations` (from, relation, to), and an optional `source` wikilink cited on new pages. Validated and idempotent.",
    inputSchema: {
      type: "object",
      properties: {
        entities: {
          type: "array",
          description: "Entities discovered in the text (non-empty).",
          items: {
            type: "object",
            properties: {
              category: {
                type: "string",
                description: "Entity category slug, e.g. `people`, `concept`, `projects`.",
              },
              name: { type: "string", description: "Canonical display name." },
              aliases: {
                type: "array",
                items: { type: "string" },
                description: "Optional alternate names.",
              },
              confidence: {
                type: "string",
                description: "Optional confidence label passed through verbatim.",
              },
            },
            required: ["category", "name"],
            additionalProperties: false,
          },
        },
        relations: {
          type: "array",
          description: "Optional typed relations between the extracted entities.",
          items: {
            type: "object",
            properties: {
              from: { type: "string", description: "Source entity name." },
              from_category: { type: "string", description: "Optional source category." },
              relation: {
                type: "string",
                description: "Relation token from the relation vocabulary (e.g. `related`).",
              },
              to: { type: "string", description: "Target entity name." },
              to_category: { type: "string", description: "Optional target category." },
            },
            required: ["from", "relation", "to"],
            additionalProperties: false,
          },
        },
        source: {
          type: "string",
          description: "Optional source wikilink cited in the Sources section of new entity pages.",
        },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
      },
      required: ["entities"],
      additionalProperties: false,
    },
    handler: toolBrainIntakeEntities,
  },
]);
