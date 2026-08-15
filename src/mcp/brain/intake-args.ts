/**
 * Shared MCP-boundary parser for an agent-supplied extraction intake.
 *
 * The NER intake tool and the source-ingest tool both accept the same typed
 * shape - a list of extracted entities plus optional typed relations - and
 * differ only in how they name the material it came from. This module
 * validates that shape ONCE at the MCP boundary (throwing INVALID_PARAMS on a
 * malformed payload) and hands the core {@link ExtractionIntake} to the
 * shared intake primitive, so neither tool reinvents the parsing, and each
 * declares its source contract instead of both guessing at one.
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

/**
 * Whether a `source` argument is part of the calling tool's contract.
 *
 * A union rather than a flag because the two tools differ in KIND, not in
 * strictness. `brain_intake_entities` takes its source as `source` and cannot
 * commit without one. `brain_ingest_source` names its source as `source_path`
 * and passes it to the pipeline itself; `source` is not in its schema, so this
 * parser used to read an argument that tool never declared and never used -
 * a provenance built from a phantom field.
 */
export type IntakeSourceContract = "required" | "absent";

export interface ParsedIntakeArgs {
  readonly intake: ExtractionIntake;
  /** Optional agent identity override. */
  readonly agent?: string;
}

/**
 * What a tool whose contract REQUIRES a source gets back. `source` and
 * `provenance` are non-optional here, so the required-ness rule is decided
 * once, in the parser, and every handler downstream reads a guarantee instead
 * of re-deriving the rule from the shape of an optional field.
 */
export interface ParsedSourcedIntakeArgs extends ParsedIntakeArgs {
  /** The source identity the caller named, verbatim. */
  readonly source: string;
  /** The `stated`-level provenance built from {@link source}. */
  readonly provenance: Provenance;
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
 * arguments. `entities` is required and must be a non-empty array;
 * `relations` is optional.
 *
 * `source` is governed by {@link IntakeSourceContract}. Under `required` a
 * missing or blank one is refused HERE, at the surface that can still ask the
 * caller, and never routed down either trust lane: trusting an unnamed source
 * would make the omission itself the way in, and quarantining it would punish
 * a caller for a question nobody asked while reporting success - quarantine
 * being one-way. A named source becomes a `stated`-level provenance whose
 * Sources section the intake stamps onto new entity pages. Under `absent` the
 * argument is not read at all.
 */
export function parseExtractionIntakeArgs(
  args: Record<string, unknown>,
  tool: string,
  sourceContract: "required",
): ParsedSourcedIntakeArgs;
export function parseExtractionIntakeArgs(
  args: Record<string, unknown>,
  tool: string,
  sourceContract: "absent",
): ParsedIntakeArgs;
export function parseExtractionIntakeArgs(
  args: Record<string, unknown>,
  tool: string,
  sourceContract: IntakeSourceContract,
): ParsedIntakeArgs | ParsedSourcedIntakeArgs {
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

  const agent = optionalString(args["agent"], tool, "agent");

  const intake: ExtractionIntake = {
    entities,
    ...(relations !== undefined ? { relations } : {}),
  };
  if (sourceContract === "absent") {
    return { intake, ...(agent !== undefined ? { agent } : {}) };
  }

  const source = optionalString(args["source"], tool, "source");
  if (source === undefined || source.trim().length === 0) {
    throw new MCPError(
      INVALID_PARAMS,
      `${tool}: 'source' is required - name the note this extraction came from ` +
        "(a vault wikilink, e.g. `[[Articles/primer.md]]`) or the address it was read from. " +
        "Entities are committed under the provenance of their source, so an unnamed source " +
        "has no provenance to commit under.",
    );
  }
  const provenance: Provenance = { level: "stated", sources: [source], premises: [] };

  return {
    intake,
    source,
    provenance,
    ...(agent !== undefined ? { agent } : {}),
  };
}
