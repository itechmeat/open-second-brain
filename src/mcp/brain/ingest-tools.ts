/**
 * Source-ingest tool (Knowledge Provenance suite).
 *
 * The calling agent reads a text-bearing source, extracts its entities and
 * relations, and writes a summary; it submits all of that here. OSB runs no
 * model - it routes the extraction through the shared intake primitive and
 * writes a per-source summary page that backlinks the source, lists the
 * entities it introduced, and lists its connections to pre-existing material.
 * Idempotent on the source path.
 */

import { ingestSource } from "../../core/brain/ingest/ingest.ts";
import { IntakeValidationError } from "../../core/brain/intake/extract-intake.ts";
import { resolveAgentName } from "../../core/config.ts";
import { INTERNAL_ERROR, INVALID_PARAMS, MCPError } from "../protocol.ts";
import type { ServerContext, ToolDefinition } from "../tools.ts";
import { coerceStr } from "../coerce.ts";
import { parseExtractionIntakeArgs } from "./intake-args.ts";

const TOOL = "brain_ingest_source";

async function toolBrainIngestSource(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const sourcePath = coerceStr(args, "source_path", true)!;
  const summary = coerceStr(args, "summary", true)!;
  const parsed = parseExtractionIntakeArgs(args, TOOL);
  const agent =
    parsed.agent && parsed.agent.trim().length > 0
      ? parsed.agent
      : resolveAgentName(ctx.configPath ?? undefined);

  try {
    const res = ingestSource(
      ctx.vault,
      { sourcePath, summary, extraction: parsed.intake },
      { agent, now: new Date() },
    );
    return {
      summary_path: res.summaryPath,
      created: res.created,
      entities_created: [...res.entitiesCreated],
      entities_updated: [...res.entitiesUpdated],
      connections: [...res.connections],
    };
  } catch (err) {
    if (err instanceof IntakeValidationError) {
      throw new MCPError(INVALID_PARAMS, `${TOOL}: ${err.message}`);
    }
    if (err instanceof MCPError) throw err;
    const reason = err instanceof Error ? err.message : String(err);
    throw new MCPError(INTERNAL_ERROR, `${TOOL}: ${reason}`);
  }
}

export const INGEST_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: TOOL,
    description:
      "Ingest one text-bearing source (document / note / URL text) into the brain. The agent supplies `source_path` (vault path or URL), a `summary`, the extracted `entities` (each: category, name, optional aliases/confidence), and optional typed `relations`. OSB creates/updates the entity pages and writes a per-source summary page that backlinks the source, lists its entities, and lists its connections to pre-existing notes. Idempotent on source_path. OSB never runs a model; no OCR or binary sources.",
    inputSchema: {
      type: "object",
      properties: {
        source_path: {
          type: "string",
          description: "Source identity: a vault-relative path or a URL.",
        },
        summary: {
          type: "string",
          description: "Agent-written summary prose for the source.",
        },
        entities: {
          type: "array",
          description: "Entities extracted from the source (non-empty).",
          items: {
            type: "object",
            properties: {
              category: { type: "string", description: "Entity category slug." },
              name: { type: "string", description: "Canonical display name." },
              aliases: { type: "array", items: { type: "string" } },
              confidence: { type: "string" },
            },
            required: ["category", "name"],
            additionalProperties: false,
          },
        },
        relations: {
          type: "array",
          description: "Optional typed relations between extracted entities.",
          items: {
            type: "object",
            properties: {
              from: { type: "string" },
              from_category: { type: "string" },
              relation: { type: "string" },
              to: { type: "string" },
              to_category: { type: "string" },
            },
            required: ["from", "relation", "to"],
            additionalProperties: false,
          },
        },
        agent: {
          type: "string",
          description: "Optional agent identity override; defaults to the server-resolved name.",
        },
      },
      required: ["source_path", "summary", "entities"],
      additionalProperties: false,
    },
    handler: toolBrainIngestSource,
  },
]);
