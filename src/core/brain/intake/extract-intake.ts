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
 *
 * Disposition contract (write-side trust, Task 12): the CALLING lane resolves
 * the review disposition ONCE for the logical write this intake belongs to and
 * hands the verdict in through {@link IntakeOptions.disposition}. The arms:
 *
 *   - deny never reaches this primitive - the caller's gate refuses the whole
 *     write (no entity page, no manifest row, no summary page) before the
 *     intake runs, and this module performs no consult of its own, so two
 *     consultations of one write can never disagree;
 *   - `publish` (the default when the option is absent) is byte-identical to
 *     the behavior before the contract existed;
 *   - `stage` stages: every page the intake CREATES lands in the review queue
 *     (`Brain/pending/notes/`, the one lane whose publish target can address
 *     the entity tree) instead of staying in the canonical registry, carrying
 *     the relations whose `from` side is itself a staged page, so the operator
 *     reviews and the queue's apply publishes exactly the page a publish
 *     intake would have written. A relation pointing INTO a staged page from
 *     an already-published one is deferred onto the result
 *     ({@link IntakeResult.deferredRelations}) - writing it before review
 *     would leave a dangling link in a published page if the operator
 *     rejected the staged page - and a re-ingest of a source still staged
 *     dedupes onto the open queue entries instead of staging duplicates.
 *     The UPDATE arm is untouched - already-admitted records are mutations,
 *     and the review boundary is entry, not mutation.
 *
 * Label admission (review M4): a store-learned verdict refusing one label
 * skips that entity and counts the skip on the result
 * ({@link IntakeResult.entitiesSkipped}) instead of aborting the batch
 * partway; structural and denylist refusals still fail the whole intake.
 *
 * The contract covers what this primitive writes. Every OTHER registration
 * row of the same logical write - the ingest pipeline's manifest row above
 * all - owes the same verdict at its own write site, so a staged ingest does
 * not record itself as done while its output awaits review.
 */

import { readFileSync, unlinkSync } from "node:fs";
import { relative } from "node:path";

import { canonicalNotePath } from "../../path-safety.ts";
import { isKnownRelation, normalizeRelation } from "../../graph/relation-vocab.ts";
import { TRANSPORT_REACH } from "../../graph/transport-reach.ts";
import { isPathReadableAtReach, type FrontmatterCache } from "../../search/result-filters.ts";
import { entityPath } from "../paths.ts";
import { listPendingLane, stageForReview } from "../pending/pending-lanes.ts";
import { REVIEW_LANE } from "../write-gate.ts";
import {
  validateEntityCategory,
  normalizeEntityName,
  InvalidEntityLabelError,
} from "../entities/canonical.ts";
import { relateEntities, upsertEntity } from "../entities/registry.ts";
import { renderProvenanceSection, type Provenance } from "../provenance/provenance.ts";
import { INTAKE_TRUST, type IntakeTrust } from "../trust/untrusted-provenance.ts";
import {
  UNTRUSTED_ORIGIN,
  classifySourceOrigin,
  classifySourceTrust,
  isSourceHidden,
  type SourceOrigin,
} from "./source-trust.ts";

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
  /**
   * May the caller read the vault file at this vault-relative path? Supplied
   * by a surface that answers at a reach narrower than the vault (the MCP
   * tools at remote reach); a local caller passes nothing. A cited vault file
   * the predicate refuses is classified as a source with no local bytes
   * (untrusted lane, no digest), exactly like an absent file.
   */
  readonly readable?: (rel: string) => boolean;
  /**
   * The review disposition the CALLING lane already resolved for the logical
   * write this intake belongs to (write-side trust, Task 12) - resolved once,
   * by the caller that knows the subject and the target, never re-consulted
   * here. Absent means `publish`, which is byte-identical to the behavior
   * before this option existed. `deny` is not expressible: the caller's gate
   * refused the whole write before the intake runs. On `stage` the pages this
   * intake CREATES stage into review (`Brain/pending/notes/`) instead of
   * staying published - see the module docblock for the full contract.
   */
  readonly disposition?: "publish" | "stage";
}

/** One created entity page this intake staged into review instead of publishing. */
export interface StagedEntityPage {
  /** Id of the created (and now staged) entity. */
  readonly entityId: string;
  /** Id of the pending queue entry holding the staged page. */
  readonly pendingId: string;
  /** Vault-relative canonical path the queue's apply publishes the page at. */
  readonly publishTarget: string;
}

export interface IntakeResult {
  /** Ids of entities created by this intake. */
  readonly entitiesCreated: readonly string[];
  /** Ids of entities that already existed and were touched. */
  readonly entitiesUpdated: readonly string[];
  /** Count of relations applied (idempotent; an already-linked edge is a no-op). */
  readonly relationsApplied: number;
  /**
   * Count of entities this intake SKIPPED because the store-learned label
   * admission gate refused the name at creation (`function-word-run`,
   * `shouted-heading` - review M4). One refused label used to abort the
   * whole batch partway: the entities before it created, the relations
   * skipped, and every retry hitting the same label. The skip is counted
   * so a caller can see it; a structural verdict or a denylist refusal is
   * still a hard error that fails the intake.
   */
  readonly entitiesSkipped: number;
  /** Count of relations NOT applied because an endpoint's label was skipped. */
  readonly relationsSkipped: number;
  /**
   * The lane this intake committed in. Returned so the MCP boundary reports
   * the verdict this primitive actually used instead of classifying the same
   * source a second time and reporting an answer that could disagree.
   */
  readonly trust: IntakeTrust;
  /**
   * Present only under a `stage` disposition ({@link IntakeOptions.disposition}):
   * the created entity pages that went to the review queue instead of staying
   * in the canonical registry, in creation order. Absent for a publish intake,
   * which leaves every created page in place.
   */
  readonly stagedEntityPages?: ReadonlyArray<StagedEntityPage>;
  /**
   * Present only under a `stage` disposition, and only when non-empty
   * (review M13): relations this intake did NOT apply because applying one
   * would have written `[[staged-id]]` into an ALREADY PUBLISHED page - the
   * `from` endpoint is not among this batch's created pages while the `to`
   * endpoint exists only in the review queue, so the edge would dangle for
   * as long as the staged page awaits review, and forever if the operator
   * rejects it. The relations ride the disposition result verbatim, so the
   * flow that follows the publish (a re-run of the same extraction, which
   * the held-back manifest row of a staged ingest guarantees) applies them
   * through the ordinary idempotent path once both endpoints are admitted.
   * A relation whose `from` is itself a staged page still applies before
   * staging - it rides the staged bytes and publishes with the page it
   * lives on.
   */
  readonly deferredRelations?: ReadonlyArray<IntakeRelation>;
}

/** A typed extraction failed structural validation; nothing was written. */
export class IntakeValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntakeValidationError";
  }
}

/**
 * The label refusals an intake SKIPS rather than dies on (review M4): the
 * two store-learned admission verdicts the registry's creation gate can
 * raise. They are statistics over the corpus, so one learned-common word
 * in an otherwise good batch must not wedge intake forever - the skip is
 * counted on the result and the batch carries on. Every OTHER refusal -
 * a structural verdict, the operator denylist - stays a hard error: those
 * are admissions the operator actually made, not evidence the store
 * learned, and a skipped denylist row would be a gate that only sometimes
 * gates.
 */
const SKIPPED_LABEL_REASONS: ReadonlySet<string> = new Set([
  "function-word-run",
  "shouted-heading",
]);

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
 * only the second can be read as "not recorded". Nor is it recorded for a
 * source a remote reader may not read: the entity pages carrying it are
 * readable where the source is not.
 *
 * An intake citing NO source throws instead of picking a lane. It cannot be
 * classified, and both lanes are wrong for it: trusting it makes the omission
 * itself the way in, while quarantining it punishes a caller for a question
 * nobody asked. The remedy is to name a source, so the caller is told to.
 */
function resolveIntakeOrigin(
  vault: string,
  provenance: Provenance,
  readable: ((rel: string) => boolean) | undefined,
): SourceOrigin {
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
  // The reach question comes first, before any stat or read, so neither a
  // refused stat nor the size ceiling can name a page the caller may not read.
  if (only !== undefined) {
    if (isSourceHidden(vault, only, readable)) return UNTRUSTED_ORIGIN;
    const origin = classifySourceOrigin(vault, only);
    // The digest lands on entity pages, which do not inherit the source's
    // visibility: a source a remote reader may not read keeps its lane but
    // records no digest, or the digest would confirm a guess of its bytes.
    return origin.contentHash !== undefined && isSourceHidden(vault, only, remotelyReadable(vault))
      ? { trust: origin.trust }
      : origin;
  }

  // `some` rather than a full map: the first source outside the vault (or
  // hidden from the caller) settles the whole intake, and nothing after it
  // changes the answer.
  const untrusted = sources.some(
    (source) =>
      isSourceHidden(vault, source, readable) ||
      classifySourceTrust(vault, source) === INTAKE_TRUST.untrusted,
  );
  return { trust: untrusted ? INTAKE_TRUST.untrusted : INTAKE_TRUST.trusted };
}

/** May a remote reader read the vault file at this vault-relative path? */
function remotelyReadable(vault: string): (rel: string) => boolean {
  const cache: FrontmatterCache = new Map();
  return (rel) => isPathReadableAtReach(vault, rel, TRANSPORT_REACH.remote, cache);
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
  const origin = resolveIntakeOrigin(vault, opts.provenance, opts.readable);

  const provenanceSection = renderProvenanceSection(opts.provenance);
  const untrustedOrigin = origin.trust === INTAKE_TRUST.untrusted;

  const entitiesCreated: string[] = [];
  const entitiesUpdated: string[] = [];
  // Categories of the created records, beside their ids: the staging step
  // below needs both to name a created page's canonical path.
  const createdPages: { readonly id: string; readonly category: string }[] = [];
  // Normalised names the admission gate refused: their relations cannot
  // resolve an endpoint and are skipped by name instead of crashing.
  const skippedNames = new Set<string>();
  // Normalised name of every record this intake CREATED: under a `stage`
  // disposition these are the batch's staged pages, and a relation pointing
  // at one from outside the batch is deferred rather than applied (M13).
  const createdByName = new Map<string, string>();
  let entitiesSkipped = 0;
  let relationsSkipped = 0;

  for (const entity of intake.entities) {
    const category = validateEntityCategory(entity.category);
    // Stamp provenance into the body only when creating the page, so a later
    // mention of the same entity does not overwrite its first citation. The
    // registry decides whether this is a creation, in the lane it writes in;
    // asking here would answer for the canonical lane only.
    const bodyOnCreate = provenanceSection
      ? `# ${entity.name.trim()}\n\n${provenanceSection}`
      : undefined;
    let res;
    try {
      res = upsertEntity(vault, {
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
    } catch (exc) {
      // Review M4: a store-learned admission verdict refuses one label, not
      // the batch. Skip it, count it, and let the rest of the extraction
      // commit - a retry then meets the same skip, idempotently, instead of
      // failing on the same word forever. Any other refusal propagates.
      if (exc instanceof InvalidEntityLabelError && SKIPPED_LABEL_REASONS.has(exc.reason)) {
        skippedNames.add(normalizeEntityName(entity.name));
        entitiesSkipped += 1;
        continue;
      }
      throw exc;
    }
    if (res.created) {
      entitiesCreated.push(res.entity.id);
      createdPages.push({ id: res.entity.id, category: res.entity.category });
      createdByName.set(normalizeEntityName(entity.name), res.entity.id);
    } else {
      entitiesUpdated.push(res.entity.id);
    }
  }

  let relationsApplied = 0;
  const deferredRelations: IntakeRelation[] = [];
  for (const rel of intake.relations ?? []) {
    // An endpoint whose label was skipped does not resolve anywhere (the
    // refusal fires only when no record answers to the name), so its edges
    // are skipped and counted rather than crashed on.
    if (
      skippedNames.has(normalizeEntityName(rel.from)) ||
      skippedNames.has(normalizeEntityName(rel.to))
    ) {
      relationsSkipped += 1;
      continue;
    }
    // Disposition contract, stage arm (review M13): a relation whose `to`
    // is one of this batch's staged pages but whose `from` is not would
    // write `[[staged-id]]` into an already-published page - a link that
    // dangles while the staged page awaits review and stays behind if the
    // operator rejects it. The edge is deferred onto the result instead;
    // the publish flow that follows applies it once both endpoints are
    // admitted. A `from` inside the batch still applies: the edge rides
    // the staged bytes and publishes with the page it lives on, exactly
    // as it did before the deferral existed.
    if (
      opts.disposition === "stage" &&
      createdByName.has(normalizeEntityName(rel.to)) &&
      !createdByName.has(normalizeEntityName(rel.from))
    ) {
      deferredRelations.push(rel);
      continue;
    }
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

  // Disposition contract, stage arm: AFTER the relations, so the staged bytes
  // are the finished pages a publish intake would have left behind. Each
  // created page is staged FIRST and only then removed from the canonical
  // tree - a crash between the two leaves both copies (the queue's apply
  // names the occupied target) and never a lost page.
  // One open entry per publish target (review M13): a re-ingest of a source
  // still awaiting review re-creates the same entity (the queue is invisible
  // to the registry's index) and used to refuse with a staged-target
  // conflict, leaving the re-created page orphaned in the canonical tree.
  // An open entry holding the target IS the staged page - the canonical
  // duplicate is dropped and the entry the operator already has is reported.
  const openStagedTargets = new Map<string, string>();
  if (opts.disposition === "stage" && createdPages.length > 0) {
    for (const entry of listPendingLane(vault, REVIEW_LANE.notes).entries) {
      if (entry.publishTarget !== undefined) openStagedTargets.set(entry.publishTarget, entry.id);
    }
  }
  const stagedEntityPages =
    opts.disposition === "stage" && createdPages.length > 0
      ? createdPages.map((page) => {
          const publishTarget = canonicalNotePath(
            relative(vault, entityPath(vault, page.category, page.id)),
          );
          const existingId = openStagedTargets.get(publishTarget);
          if (existingId !== undefined) {
            unlinkSync(entityPath(vault, page.category, page.id));
            return { entityId: page.id, pendingId: existingId, publishTarget };
          }
          const bytes = readFileSync(entityPath(vault, page.category, page.id), "utf8");
          const { pendingId } = stageForReview(
            vault,
            REVIEW_LANE.notes,
            publishTarget,
            () => bytes,
          );
          unlinkSync(entityPath(vault, page.category, page.id));
          return { entityId: page.id, pendingId, publishTarget };
        })
      : undefined;

  return {
    entitiesCreated,
    entitiesUpdated,
    relationsApplied,
    entitiesSkipped,
    relationsSkipped,
    trust: origin.trust,
    ...(stagedEntityPages !== undefined ? { stagedEntityPages } : {}),
    ...(deferredRelations.length > 0 ? { deferredRelations } : {}),
  };
}
