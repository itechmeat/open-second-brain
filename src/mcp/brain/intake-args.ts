/**
 * Shared MCP-boundary parser for an agent-supplied extraction intake.
 *
 * The NER intake tool and the source-ingest tool both accept the same typed
 * shape - a list of extracted entities plus optional typed relations and an
 * optional source wikilink. This module validates that shape ONCE at the MCP
 * boundary (throwing INVALID_PARAMS on a malformed payload) and hands the
 * core {@link ExtractionIntake} to the shared intake primitive, so neither
 * tool reinvents the parsing.
 *
 * Validation is structural only - it never inspects natural-language content.
 * No `as` casts: every field is narrowed with a typeof/Array.isArray guard.
 */

import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import type {
  ExtractionIntake,
  IntakeEntity,
  IntakeRelation,
} from "../../core/brain/intake/extract-intake.ts";
import type { Provenance } from "../../core/brain/provenance/provenance.ts";

export interface ParsedIntakeArgs {
  readonly intake: ExtractionIntake;
  /** Present when the caller named a source wikilink to cite. */
  readonly provenance?: Provenance;
  /** Optional agent identity override. */
  readonly agent?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function requiredString(value: unknown, tool: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new MCPError(INVALID_PARAMS, `${tool}: '${field}' must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, tool: string, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") {
    throw new MCPError(INVALID_PARAMS, `${tool}: '${field}' must be a string`);
  }
  return value;
}

function optionalStringArray(value: unknown, tool: string, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw new MCPError(INVALID_PARAMS, `${tool}: '${field}' must be an array of strings`);
  }
  return value.map((item, i) => requiredString(item, tool, `${field}[${i}]`));
}

function parseEntity(value: unknown, tool: string, i: number): IntakeEntity {
  if (!isRecord(value)) {
    throw new MCPError(INVALID_PARAMS, `${tool}: entities[${i}] must be an object`);
  }
  const category = requiredString(value["category"], tool, `entities[${i}].category`);
  const name = requiredString(value["name"], tool, `entities[${i}].name`);
  const aliases = optionalStringArray(value["aliases"], tool, `entities[${i}].aliases`);
  const confidence = optionalString(value["confidence"], tool, `entities[${i}].confidence`);
  return {
    category,
    name,
    ...(aliases !== undefined ? { aliases } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  };
}

function parseRelation(value: unknown, tool: string, i: number): IntakeRelation {
  if (!isRecord(value)) {
    throw new MCPError(INVALID_PARAMS, `${tool}: relations[${i}] must be an object`);
  }
  const from = requiredString(value["from"], tool, `relations[${i}].from`);
  const relation = requiredString(value["relation"], tool, `relations[${i}].relation`);
  const to = requiredString(value["to"], tool, `relations[${i}].to`);
  const fromCategory = optionalString(
    value["from_category"],
    tool,
    `relations[${i}].from_category`,
  );
  const toCategory = optionalString(value["to_category"], tool, `relations[${i}].to_category`);
  return {
    from,
    relation,
    to,
    ...(fromCategory !== undefined ? { fromCategory } : {}),
    ...(toCategory !== undefined ? { toCategory } : {}),
  };
}

/**
 * Parse and structurally validate an extraction-intake payload from MCP tool
 * arguments. `entities` is required and must be a non-empty array; `relations`
 * and `source` are optional. A named `source` becomes a `stated`-level
 * provenance whose Sources section the intake stamps onto new entity pages.
 */
export function parseExtractionIntakeArgs(
  args: Record<string, unknown>,
  tool: string,
): ParsedIntakeArgs {
  const rawEntities = args["entities"];
  if (!Array.isArray(rawEntities) || rawEntities.length === 0) {
    throw new MCPError(INVALID_PARAMS, `${tool}: 'entities' must be a non-empty array`);
  }
  const entities = rawEntities.map((item, i) => parseEntity(item, tool, i));

  const rawRelations = args["relations"];
  let relations: IntakeRelation[] | undefined;
  if (rawRelations !== undefined) {
    if (!Array.isArray(rawRelations)) {
      throw new MCPError(INVALID_PARAMS, `${tool}: 'relations' must be an array`);
    }
    relations = rawRelations.map((item, i) => parseRelation(item, tool, i));
  }

  const source = optionalString(args["source"], tool, "source");
  const agent = optionalString(args["agent"], tool, "agent");

  const intake: ExtractionIntake = {
    entities,
    ...(relations !== undefined ? { relations } : {}),
  };
  const provenance: Provenance | undefined =
    source !== undefined && source.trim().length > 0
      ? { level: "stated", sources: [source], premises: [] }
      : undefined;

  return {
    intake,
    ...(provenance !== undefined ? { provenance } : {}),
    ...(agent !== undefined ? { agent } : {}),
  };
}
