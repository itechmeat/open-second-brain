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
 *
 * Trust: DERIVED here, once, from the sources the provenance cites, through
 * the one classifier every caller shares. It is deliberately not an argument.
 * A caller-declared trust used to win over the derivation, which made the
 * classification something an argument could set - and the caller is the agent
 * that read the material being classified, so that argument was the switch a
 * hostile page needed. An untrusted intake writes in the registry's quarantine
 * lane: the entities it introduces land quarantined and marked, and they are
 * records of what an untrusted source claimed rather than edits to what the
 * operator already holds.
 */

import { isKnownRelation, normalizeRelation } from "../../graph/relation-vocab.ts";
import { validateEntityCategory, normalizeEntityName } from "../entities/canonical.ts";
import { relateEntities, upsertEntity } from "../entities/registry.ts";
import { renderProvenanceSection, type Provenance } from "../provenance/provenance.ts";
import { INTAKE_TRUST, type IntakeTrust } from "../trust/untrusted-provenance.ts";
import { classifySourceOrigin, classifySourceTrust, type SourceOrigin } from "./source-trust.ts";

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
  /**
   * Where this extraction came from. REQUIRED, and required to cite at least
   * one source: its Sources section is stamped into newly created entity
   * bodies, and it is the only thing this primitive can classify. It used to
   * be optional, and an intake citing nothing read as trusted - unreachable
   * only because the one caller that could produce it guarded the case
   * itself, which nothing enforced for the next caller.
   */
  readonly provenance: Provenance;
}

export interface IntakeResult {
  /** Ids of entities created by this intake. */
  readonly entitiesCreated: readonly string[];
  /** Ids of entities that already existed and were touched. */
  readonly entitiesUpdated: readonly string[];
  /** Count of relations applied (idempotent; an already-linked edge is a no-op). */
  readonly relationsApplied: number;
  /**
   * The lane this intake committed in. Returned so the MCP boundary reports
   * the verdict this primitive actually used instead of classifying the same
   * source a second time and reporting an answer that could disagree.
   */
  readonly trust: IntakeTrust;
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
 * The origin this intake commits under, classified HERE and nowhere else.
 *
 * The cited sources decide, through the one structural classifier. Several
 * sources resolve conservatively: an extraction drawn from a mixed batch
 * cannot be split back apart afterwards, so one source outside the vault
 * makes the whole intake untrusted.
 *
 * The content hash is recorded only when the intake cites exactly ONE trusted
 * source. With several, there is no single set of bytes this extraction came
 * from, and stamping the first one would record a file the entities may have
 * nothing to do with - a misleading audit record is worse than none, because
 * only the second can be read as "not recorded".
 *
 * An intake citing NO source throws instead of picking a lane. It cannot be
 * classified, and both lanes are wrong for it: trusting it makes the omission
 * itself the way in, while quarantining it punishes a caller for a question
 * nobody asked. The remedy is to name a source, so the caller is told to.
 */
function resolveIntakeOrigin(vault: string, provenance: Provenance): SourceOrigin {
  const sources = provenance.sources;
  if (sources.length === 0) {
    throw new IntakeValidationError(
      "intake provenance must cite at least one source - entities are committed under the " +
        "provenance of the material they were extracted from, so an intake that names none " +
        "has no provenance to commit under",
    );
  }
  // One source is the only shape whose hash is kept, so it is the only shape
  // that asks for one. Mapping the hashing classifier over every source read
  // each of them in full and then discarded every digest but the first - and
  // discarded that one too the moment there was more than one source.
  const only = sources.length === 1 ? sources[0] : undefined;
  if (only !== undefined) return classifySourceOrigin(vault, only);

  // `some` rather than a full map: the first source outside the vault settles
  // the whole intake, and nothing after it changes the answer.
  const untrusted = sources.some(
    (source) => classifySourceTrust(vault, source) === INTAKE_TRUST.untrusted,
  );
  return { trust: untrusted ? INTAKE_TRUST.untrusted : INTAKE_TRUST.trusted };
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
  // Before any write, like the payload validation above: an intake that
  // cannot be classified must not leave half its entities behind.
  const origin = resolveIntakeOrigin(vault, opts.provenance);

  const provenanceSection = renderProvenanceSection(opts.provenance);
  const untrustedOrigin = origin.trust === INTAKE_TRUST.untrusted;

  const entitiesCreated: string[] = [];
  const entitiesUpdated: string[] = [];

  for (const entity of intake.entities) {
    const category = validateEntityCategory(entity.category);
    // Stamp provenance into the body only when creating the page, so a later
    // mention of the same entity does not overwrite its first citation. The
    // registry decides whether this is a creation, in the lane it writes in;
    // asking here would answer for the canonical lane only.
    const bodyOnCreate = provenanceSection
      ? `# ${entity.name.trim()}\n\n${provenanceSection}`
      : undefined;
    const res = upsertEntity(vault, {
      category,
      name: entity.name,
      ...(entity.aliases !== undefined ? { aliases: entity.aliases } : {}),
      agent: opts.agent,
      now: opts.now,
      ...(entity.confidence !== undefined ? { confidence: entity.confidence } : {}),
      ...(bodyOnCreate !== undefined ? { bodyOnCreate } : {}),
      ...(untrustedOrigin ? { untrustedOrigin } : {}),
      ...(origin.contentHash !== undefined ? { sourceContentHash: origin.contentHash } : {}),
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
      // Same lane as the entities this intake just wrote, so an untrusted
      // extraction links its own quarantined records instead of reaching the
      // operator's records that happen to carry those names.
      ...(untrustedOrigin ? { untrustedOrigin } : {}),
    });
    relationsApplied += 1;
  }

  return { entitiesCreated, entitiesUpdated, relationsApplied, trust: origin.trust };
}
