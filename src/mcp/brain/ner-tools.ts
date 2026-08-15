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
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { parseExtractionIntakeArgs } from "./intake-args.ts";
import { wrapToolErrors } from "./shared.ts";

const TOOL = "brain_intake_entities";

async function toolBrainIntakeEntities(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  // `source` is required by this tool's contract, and the parser refuses a
  // call without one before anything is written - a call that names no source
  // has no provenance to commit under, and this is the surface that can still
  // ask the caller for it.
  const parsed = parseExtractionIntakeArgs(args, TOOL, "required");
  const agent =
    parsed.agent && parsed.agent.trim().length > 0
      ? parsed.agent
      : resolveAgentName(ctx.configPath ?? undefined);
  // A malformed extraction is a client-resolvable input problem, not a
  // server fault - surface it as INVALID_PARAMS, never a fabricated result.
  return wrapToolErrors(TOOL, [IntakeValidationError], async () => {
    const result = intakeExtraction(ctx.vault, parsed.intake, {
      agent,
      now: new Date(),
      provenance: parsed.provenance,
    });
    return {
      entities_created: [...result.entitiesCreated],
      entities_updated: [...result.entitiesUpdated],
      relations_applied: result.relationsApplied,
      // The lane the entities landed in, as the intake ACTUALLY committed it.
      // Classifying the source a second time here would be a second answer to
      // one question, free to disagree with the write that already happened.
      // An untrusted intake quarantines what it introduces, so a caller told
      // only which ids it created would be told nothing about whether it can
      // read them back.
      trust: result.trust,
    };
  });
}

export const NER_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    description:
      "Intake entities the agent extracted from note text into the entity registry (this server runs no model). Supply `entities` (category, name, optional aliases), the `source` they came from, and optional typed `relations`. Entities are quarantined unless the source names a file that exists.",
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
          description:
            "Where this extraction came from: a vault wikilink (`[[Articles/x.md]]`) or the address read. Cited on new entity pages; decides their provenance.",
        },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
      },
      required: ["entities", "source"],
      additionalProperties: false,
    },
    handler: toolBrainIntakeEntities,
  },
]);
