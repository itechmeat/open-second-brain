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
import { classifySourceTrust } from "../../core/brain/intake/source-trust.ts";
import { resolveAgentName } from "../../core/config.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tool-contract.ts";
import { parseExtractionIntakeArgs } from "./intake-args.ts";
import { wrapToolErrors } from "./shared.ts";

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
  // Trust is derived from the source identity the caller named, through the
  // same structural classifier the ingest pipeline uses.
  //
  // A call that names NO source is a third answer, and collapsing it into
  // either lane is a defect in one direction or the other. Trusting it makes
  // the omission itself the way in: an agent reading a hostile page, told by
  // that page to leave the source out, lands its entities active and
  // unmarked. Quarantining it punishes the caller for a question nobody
  // asked, and quarantine is one-way - the records leave every ordinary read
  // and only an explicit release brings them back, while the response says
  // the write succeeded. This is the surface that can still ask, so it asks:
  // an intake whose provenance cannot be established is refused here, with
  // the exit named, before anything is written.
  const source = parsed.provenance?.sources[0];
  if (source === undefined) {
    throw new MCPError(
      INVALID_PARAMS,
      `${TOOL}: 'source' is required - name the note this extraction came from ` +
        "(a vault wikilink, e.g. `[[Articles/primer.md]]`) or the address it was read from. " +
        "Entities are committed under the provenance of their source, so an unnamed source " +
        "has no provenance to commit under.",
    );
  }
  const trust = classifySourceTrust(ctx.vault, source);
  // A malformed extraction is a client-resolvable input problem, not a
  // server fault - surface it as INVALID_PARAMS, never a fabricated result.
  return wrapToolErrors(TOOL, [IntakeValidationError], async () => {
    const result = intakeExtraction(ctx.vault, parsed.intake, {
      agent,
      now: new Date(),
      ...(parsed.provenance !== undefined ? { provenance: parsed.provenance } : {}),
      ...(trust !== undefined ? { trust } : {}),
    });
    return {
      entities_created: [...result.entitiesCreated],
      entities_updated: [...result.entitiesUpdated],
      relations_applied: result.relationsApplied,
      // The lane the entities landed in. An untrusted intake quarantines what
      // it introduces, so a caller told only which ids it created would be
      // told nothing about whether it can read them back.
      trust,
    };
  });
}

export const NER_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    description:
      "Intake entities the agent extracted from note text into the entity registry (OSB runs no model). Supply `entities` (category, name, optional aliases), the `source` they came from, and optional typed `relations`. Entities from a source outside the vault are quarantined; the response says so.",
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
