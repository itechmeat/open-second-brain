/**
 * Extraction-intake primitive (shared lib a of the Knowledge Provenance
 * suite).
 *
 * One validated, idempotent path turns an agent-supplied typed extraction
 * (entities + typed relations) into entity-registry records. Both the
 * source-ingest pipeline and on-write NER route through this primitive, so
 * entity intake is implemented and tested once.
 *
 * Provider-agnostic boundary: the model that produced the extraction lives on
 * the agent side of the MCP/CLI boundary. This primitive never calls a model.
 * It validates the typed payload, refuses a malformed one BEFORE writing
 * anything (no partial-write fabrication), and commits through the registry's
 * own duplicate-refusing `upsertEntity` / `relateEntities`.
 *
 * Provenance: when the caller supplies a {@link Provenance}, its `## Sources`
 * section is stamped into the body of each NEWLY CREATED entity (via the
 * shared provenance primitive). An entity that already exists keeps its body
 * untouched - the per-source summary page (the ingest pipeline) carries the
 * authoritative cross-source citation list, so an entity page cites the
 * source that first introduced it without being clobbered on every later
 * mention.
 */

import { isKnownRelation, normalizeRelation } from "../../graph/relation-vocab.ts";
import { validateEntityCategory, normalizeEntityName } from "../entities/canonical.ts";
import { getEntity, relateEntities, upsertEntity } from "../entities/registry.ts";
import { renderProvenanceSection, type Provenance } from "../provenance/provenance.ts";

/** One entity the agent extracted from a source. */
export interface IntakeEntity {
  readonly category: string;
  readonly name: string;
  readonly aliases?: readonly string[];
  /** Optional confidence label passed through to the registry verbatim. */
  readonly confidence?: string;
}

/** One typed relation between two extracted entities, referenced by name. */
export interface IntakeRelation {
  readonly from: string;
  readonly fromCategory?: string;
  readonly relation: string;
  readonly to: string;
  readonly toCategory?: string;
}

/** A typed extraction the agent supplies for intake. */
export interface ExtractionIntake {
  readonly entities: readonly IntakeEntity[];
  readonly relations?: readonly IntakeRelation[];
}

export interface IntakeOptions {
  /** Agent identity stamped as the entity `source_agent`. */
  readonly agent: string;
  /** Injected clock for deterministic stamps. */
  readonly now: Date;
  /** When set, its Sources section is stamped into newly created entity bodies. */
  readonly provenance?: Provenance;
}

export interface IntakeResult {
  /** Ids of entities created by this intake. */
  readonly entitiesCreated: readonly string[];
  /** Ids of entities that already existed and were touched. */
  readonly entitiesUpdated: readonly string[];
  /** Count of relations applied (idempotent; an already-linked edge is a no-op). */
  readonly relationsApplied: number;
}

/** A typed extraction failed structural validation; nothing was written. */
export class IntakeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeValidationError";
  }
}

/** Validate the whole payload before any write, so a bad intake never writes. */
function validateIntake(intake: ExtractionIntake): void {
  const declared = new Set<string>();
  for (const entity of intake.entities) {
    if (!normalizeEntityName(entity.name)) {
      throw new IntakeValidationError("entity name must not be empty");
    }
    try {
      validateEntityCategory(entity.category);
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause);
      throw new IntakeValidationError(
        `invalid entity category ${JSON.stringify(entity.category)}: ${reason}`,
      );
    }
    declared.add(normalizeEntityName(entity.name));
  }
  for (const rel of intake.relations ?? []) {
    if (!isKnownRelation(normalizeRelation(rel.relation))) {
      throw new IntakeValidationError(
        `unknown relation ${JSON.stringify(rel.relation)} - see relation-vocab.ts`,
      );
    }
    const from = normalizeEntityName(rel.from);
    const to = normalizeEntityName(rel.to);
    if (!from || !to) {
      throw new IntakeValidationError("relation endpoints must not be empty");
    }
    if (from === to) {
      throw new IntakeValidationError(`relation cannot link ${JSON.stringify(rel.from)} to itself`);
    }
    if (!declared.has(from) || !declared.has(to)) {
      throw new IntakeValidationError(
        `relation endpoint not declared among intake entities: ${JSON.stringify(
          declared.has(from) ? rel.to : rel.from,
        )}`,
      );
    }
  }
}

/**
 * Intake a typed extraction into the entity registry. Validates the full
 * payload first (throwing {@link IntakeValidationError} with no write on
 * failure), then upserts entities and applies relations idempotently.
 */
export function intakeExtraction(
  vault: string,
  intake: ExtractionIntake,
  opts: IntakeOptions,
): IntakeResult {
  validateIntake(intake);

  const provenanceSection = opts.provenance ? renderProvenanceSection(opts.provenance) : "";

  const entitiesCreated: string[] = [];
  const entitiesUpdated: string[] = [];

  for (const entity of intake.entities) {
    const category = validateEntityCategory(entity.category);
    const existing = getEntity(vault, { category, query: entity.name });
    // Stamp provenance into the body only when creating the page, so a later
    // mention of the same entity does not overwrite its first citation.
    const body =
      existing === null && provenanceSection
        ? `# ${entity.name.trim()}\n\n${provenanceSection}`
        : undefined;
    const res = upsertEntity(vault, {
      category,
      name: entity.name,
      ...(entity.aliases !== undefined ? { aliases: entity.aliases } : {}),
      agent: opts.agent,
      now: opts.now,
      ...(entity.confidence !== undefined ? { confidence: entity.confidence } : {}),
      ...(body !== undefined ? { body } : {}),
    });
    if (res.created) entitiesCreated.push(res.entity.id);
    else entitiesUpdated.push(res.entity.id);
  }

  let relationsApplied = 0;
  for (const rel of intake.relations ?? []) {
    relateEntities(vault, {
      from: {
        query: rel.from,
        ...(rel.fromCategory !== undefined ? { category: rel.fromCategory } : {}),
      },
      relation: rel.relation,
      to: { query: rel.to, ...(rel.toCategory !== undefined ? { category: rel.toCategory } : {}) },
      now: opts.now,
    });
    relationsApplied += 1;
  }

  return { entitiesCreated, entitiesUpdated, relationsApplied };
}
