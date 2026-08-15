/**
 * Canonical entity registry operations (Memory Integrity Suite).
 *
 * Write-side contract: one canonical entity per `(category, normalized
 * name)`. `upsertEntity` resolves through names AND aliases before
 * creating anything, so duplicates are refused at the write seam;
 * doctor lints catch the ones that arrive by hand-editing or sync.
 * All operations are deterministic - the caller injects the clock.
 *
 * Writes run in one of two LANES ({@link resolveWriteTarget}): the canonical
 * one, and the quarantine holding untrusted-provenance records. A name can be
 * claimed once in each, which is not a duplicate - only one of the two is a
 * canonical entity, and the quarantined claim is a record OF a claim rather
 * than a record the vault stands behind.
 *
 * Files stay plain Obsidian Markdown. Every rewrite preserves unknown
 * frontmatter keys the operator may have added by hand.
 */

import { dirname } from "node:path";
import { mkdirSync } from "node:fs";

import type { FrontmatterMap } from "../../types.ts";
import { parseFrontmatter, slugify, writeFrontmatterAtomic } from "../../vault.ts";
import { isKnownRelation, normalizeRelation } from "../../graph/relation-vocab.ts";
import { normalizeRelationTarget } from "../../graph/frontmatter-relations.ts";
import { isoSecond } from "../time.ts";
import { entityPath } from "../paths.ts";
import { assertVaultIdentityForWrite } from "../vault-identity.ts";
import {
  assertValidEntityLabel,
  entityIdentityKey,
  normalizeEntityName,
  quoteVariantCollisionTail,
  validateEntityCategory,
} from "./canonical.ts";
import { resolveEntityLabelDenylist } from "./label-hygiene.ts";
import {
  buildEntityIndex,
  conflictClaimants,
  ENTITY_CONFLICT_KIND,
  findEntityConflict,
  parseEntityFile,
  type EntityIndex,
} from "./index-builder.ts";
import { ENTITY_STATUS_SCOPE, entityStatusInScope } from "./status-scope.ts";
import {
  INTAKE_TRUST,
  UNTRUSTED_SOURCE_FRONTMATTER_KEY,
  sourceContentHashFrontmatter,
  untrustedSourceFrontmatter,
} from "../trust/untrusted-provenance.ts";
import {
  BRAIN_ENTITY_ID_PREFIX,
  BRAIN_ENTITY_KIND,
  BRAIN_ENTITY_STATUS,
  type BrainEntity,
  type BrainEntityStatus,
  type EntityRef,
} from "./types.ts";

export interface UpsertEntityInput {
  readonly category: string;
  readonly name: string;
  readonly aliases?: ReadonlyArray<string>;
  /** Agent identity stamped as `source_agent`. */
  readonly agent: string;
  /** Injected clock for deterministic stamps. */
  readonly now: Date;
  /** Optional confidence label passed through verbatim. */
  readonly confidence?: string;
  /** Markdown body (current structured state). Replaces on update. */
  readonly body?: string;
  /**
   * Markdown body used only if this upsert CREATES the record; an update
   * keeps the body that is there. The intake path stamps a source citation
   * this way: whether the write creates or updates is decided here, in the
   * lane it resolves in, and a caller that answered that question for itself
   * with a canonical read would get it wrong for the quarantine lane - and
   * would silently drop the citation of the source that introduced the
   * record. {@link body} still wins when both are given.
   */
  readonly bodyOnCreate?: string;
  /** Config path for denylist resolution; env still wins when set. */
  readonly configPath?: string;
  /**
   * This write is being made under untrusted provenance (see
   * `intake/source-trust.ts`), which selects the LANE it resolves and writes
   * in - see {@link resolveWriteTarget}. A record it introduces lands
   * `quarantine` and carries the untrusted-source marker the retrieval gate
   * reads, so it is absent from every ordinary read until an operator
   * releases it with {@link archiveEntity}'s `restore`.
   *
   * Absent → the canonical lane, byte-identical to an upsert that never knew
   * about trust.
   */
  readonly untrustedOrigin?: boolean;
  /**
   * SHA-256 of the bytes of the source this record was extracted from, as
   * classified by `intake/source-trust.ts`.
   *
   * An AUDIT RECORD, not a gate: nothing in this release reads it back, and
   * that is the point rather than an omission - see
   * `SOURCE_CONTENT_HASH_FRONTMATTER_KEY` in
   * `../trust/untrusted-provenance.ts`. Stamped only when this
   * upsert CREATES the record, alongside {@link bodyOnCreate}, so the digest
   * and the `## Sources` citation always describe the SAME source; a later
   * mention would otherwise overwrite the hash while leaving the citation of
   * a different file in the body, and the page would misdescribe both.
   *
   * Absent → nothing is written, leaving the page byte-identical to one from
   * before this record existed.
   */
  readonly sourceContentHash?: string;
}

export interface UpsertEntityResult {
  readonly entity: BrainEntity;
  readonly created: boolean;
}

export interface ListEntitiesOptions {
  readonly category?: string;
  readonly status?: BrainEntityStatus;
}

export interface RelateEntitiesInput {
  readonly from: EntityRef;
  readonly relation: string;
  readonly to: EntityRef;
  readonly now: Date;
  /**
   * This edge is being written under untrusted provenance, which selects the
   * lane both endpoints resolve in ({@link resolveWriteTarget}) - an intake
   * that just quarantined two entities links THOSE, and never the operator's
   * records of the same names. Absent → the canonical lane, byte-identical
   * to a relate that never knew about trust.
   */
  readonly untrustedOrigin?: boolean;
}

export interface ArchiveEntityOptions {
  readonly now: Date;
  /**
   * Return a record that is outside the canonical scope - archived OR
   * quarantined - to active lookup. This is the named exit from quarantine:
   * without it a record that entered under untrusted provenance would be
   * invisible with no way back, and a status nothing can leave is a dead end
   * rather than a lane. A release that would collide with a canonical record
   * already holding the same name is refused with both ids - see the check in
   * {@link archiveEntity}.
   */
  readonly restore?: boolean;
}

// ----- Lookup ----------------------------------------------------------------

/**
 * The label of `entity` that a normalized `query` actually matched: its
 * canonical name when that is what matched, otherwise the alias that did.
 *
 * A collision message must compare the forms that COLLIDED. Falling back
 * to the canonical name when an alias matched would compare the wrong
 * pair, and the quote-variant cause would then be named on a collision it
 * does not explain, or omitted from one it does.
 */
function matchedLabel(entity: BrainEntity, query: string): string {
  if (normalizeEntityName(entity.name) === query) return entity.name;
  return entity.aliases.find((a) => normalizeEntityName(a) === query) ?? entity.name;
}

/**
 * A reference matched more than one record.
 *
 * Two readings, and the message must not offer the wrong one. Across
 * categories the reference is under-specified and the exit is the
 * category - the message this error has always carried. WITHIN one
 * category it is not under-specified at all: two canonical records claim
 * one identity key, no category can separate them, and telling the
 * operator to pass one would name an exit that cannot work. The quote
 * fold is one way a vault arrives there, and when it is the cause the
 * message says so and names the command that ends it.
 */
export class EntityAmbiguityError extends Error {
  constructor(query: string, matches: ReadonlyArray<BrainEntity>) {
    const ids = matches.map((m) => m.id).join(", ");
    const categories = new Set(matches.map((m) => m.category));
    if (categories.size > 1) {
      super(`entity reference '${query}' is ambiguous across categories: ${ids} - pass a category`);
    } else {
      const normalized = normalizeEntityName(query);
      const tail = quoteVariantCollisionTail(...matches.map((m) => matchedLabel(m, normalized)));
      super(
        `entity reference '${query}' is claimed by ${matches.length} canonical records in one ` +
          `category (${[...categories][0]}): ${ids} - no category separates them, so one must be ` +
          `archived or merged${tail}`,
      );
    }
    this.name = "EntityAmbiguityError";
  }
}

/**
 * Resolve a ref at the CANONICAL status scope: canonical name first, then
 * alias. The index's lookup maps are built at the same scope, so the two
 * branches below agree by construction rather than by coincidence.
 */
function resolveActive(index: EntityIndex, ref: EntityRef): BrainEntity | null {
  const query = normalizeEntityName(ref.query);
  if (!query) return null;
  if (ref.category !== undefined) {
    const category = validateEntityCategory(ref.category);
    const byName = index.byKey.get(`${category}:${query}`);
    if (byName) return byName;
    const byAlias = index.byAlias.get(query);
    return byAlias && byAlias.category === category ? byAlias : null;
  }
  const matches = index.entities.filter(
    (e) =>
      entityStatusInScope(e.status, ENTITY_STATUS_SCOPE.canonical) &&
      (normalizeEntityName(e.name) === query ||
        e.aliases.some((a) => normalizeEntityName(a) === query)),
  );
  if (matches.length > 1) throw new EntityAmbiguityError(ref.query, matches);
  return matches[0] ?? null;
}

/**
 * Resolve a ref inside the QUARANTINE lane: the records that hold a name
 * without being entitled to it, which no read scope admits. Kept separate
 * from {@link resolveActive} rather than chained after it, because the two
 * answer for different authorities and a write belongs to exactly one.
 */
function resolveQuarantined(index: EntityIndex, ref: EntityRef): BrainEntity | null {
  const query = normalizeEntityName(ref.query);
  if (!query) return null;
  const category = ref.category !== undefined ? validateEntityCategory(ref.category) : undefined;
  const matches = index.entities.filter(
    (e) =>
      e.status === BRAIN_ENTITY_STATUS.quarantine &&
      (category === undefined || e.category === category) &&
      (normalizeEntityName(e.name) === query ||
        e.aliases.some((a) => normalizeEntityName(a) === query)),
  );
  if (matches.length > 1) throw new EntityAmbiguityError(ref.query, matches);
  return matches[0] ?? null;
}

/**
 * Resolve the record a WRITE lands on, in the lane the write belongs to.
 *
 * This is the seam where an untrusted source could otherwise take a name for
 * good. A single "who holds this name" resolution that answered canonical
 * first and quarantined second looked like the careful choice - it kept a
 * re-ingest from forking a second page - but it answered the same for a
 * write the vault had vouched for. So the first scraped page to mention
 * `Acme Corp` created the quarantined record, and every later TRUSTED write
 * of that name landed INSIDE it: the update arm copies the target's status,
 * so the record stayed quarantined, kept the untrusted-source marker in its
 * carried-forward frontmatter, and stayed invisible to `getEntity`, to the
 * default listing, to alias resolution and to the retrieval gate - reported
 * to the writer as `created: false`, which reads as "already there".
 *
 * The lanes are separate identity spaces instead:
 *
 *   - a TRUSTED write resolves canonical records only. A quarantined
 *     namesake does not hold the name against it: the write creates its own
 *     record, `created: true`, readable, unmarked. It is also not refused,
 *     which matters - refusing would let any hostile page reserve a name the
 *     operator then could not use.
 *   - an UNTRUSTED write resolves quarantined records only. Re-ingesting the
 *     same untrusted source still updates its own record rather than forking
 *     one, but an untrusted mention of a name the operator already holds can
 *     no longer reach that record - not its aliases, not its `source_agent`,
 *     not its body, not its edges. Nothing it carries can arrive unmarked.
 *
 * Neither direction can therefore capture the other, and the two spaces are
 * joined only where a human is present: {@link archiveEntity}'s `restore`,
 * which refuses a release that would collide.
 */
function resolveWriteTarget(
  index: EntityIndex,
  ref: EntityRef,
  untrustedOrigin: boolean,
): BrainEntity | null {
  return untrustedOrigin ? resolveQuarantined(index, ref) : resolveActive(index, ref);
}

export function getEntity(vault: string, ref: EntityRef): BrainEntity | null {
  return resolveActive(buildEntityIndex(vault), ref);
}

/**
 * List entities. Without a `status`, the listing is the READABLE scope: the
 * statuses a surface may show, which is `active` and `archived` exactly as
 * before, and never `quarantine`. A `status` is an explicit ask and is
 * honoured verbatim - that is how an operator sees what is quarantined.
 */
export function listEntities(vault: string, opts: ListEntitiesOptions = {}): BrainEntity[] {
  const category = opts.category !== undefined ? validateEntityCategory(opts.category) : undefined;
  return buildEntityIndex(vault).entities.filter(
    (e) =>
      (category === undefined || e.category === category) &&
      (opts.status === undefined
        ? entityStatusInScope(e.status, ENTITY_STATUS_SCOPE.readable)
        : e.status === opts.status),
  );
}

// ----- Write helpers ---------------------------------------------------------

const ENTITY_FIELD_ORDER = [
  "kind",
  "entity_id",
  "category",
  "name",
  "aliases",
  "status",
  "source_agent",
  "confidence",
  "created_at",
  "updated_at",
  "archived_at",
  "tags",
] as const;

const ENTITY_OWN_FIELDS: ReadonlySet<string> = new Set(ENTITY_FIELD_ORDER);

/**
 * Rewrite an entity file: known fields in canonical order, then the
 * operator's extra frontmatter keys (relations among them) verbatim.
 */
function writeEntityFile(
  path: string,
  fields: FrontmatterMap,
  extras: FrontmatterMap,
  body: string,
  opts: { overwrite: boolean },
): void {
  const meta: FrontmatterMap = {};
  for (const key of ENTITY_FIELD_ORDER) {
    const value = fields[key];
    if (value !== undefined) meta[key] = value;
  }
  for (const [key, value] of Object.entries(extras)) {
    if (!ENTITY_OWN_FIELDS.has(key)) meta[key] = value;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFrontmatterAtomic(path, meta, body, {
    overwrite: opts.overwrite,
    existsErrorKind: "entity",
  });
}

/** Validate requested aliases against the rest of the registry. */
function checkAliasClaims(
  index: EntityIndex,
  category: string,
  selfId: string | null,
  ownName: string,
  aliases: ReadonlyArray<string>,
): string[] {
  const kept: string[] = [];
  const seen = new Set<string>();
  for (const raw of aliases) {
    const alias = raw.trim();
    const normalized = normalizeEntityName(alias);
    if (!normalized || normalized === normalizeEntityName(ownName)) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const aliasHolder = index.byAlias.get(normalized);
    if (aliasHolder && aliasHolder.id !== selfId) {
      // The holder's own spelling of the claimed form, so the collision
      // message can say whether the two labels differ by anything other
      // than quote shape. Falling back to its canonical name would compare
      // the wrong pair, so the alias that actually matched is found first.
      const heldForm =
        aliasHolder.aliases.find((a) => normalizeEntityName(a) === normalized) ?? aliasHolder.name;
      throw new Error(
        `alias '${alias}' is already claimed by ${aliasHolder.id} (${aliasHolder.path})` +
          quoteVariantCollisionTail(alias, heldForm),
      );
    }
    const nameHolder = index.byKey.get(`${category}:${normalized}`);
    if (nameHolder && nameHolder.id !== selfId) {
      throw new Error(
        `alias '${alias}' collides with the canonical name of ${nameHolder.id} (${nameHolder.path})` +
          quoteVariantCollisionTail(alias, nameHolder.name),
      );
    }
    kept.push(alias);
  }
  return kept;
}

/** Allocate an unused `ent-<category>-<slug>` id (suffix -2, -3, ... on collision). */
function allocateEntityId(index: EntityIndex, category: string, name: string): string {
  const base = `${BRAIN_ENTITY_ID_PREFIX}${category}-${slugify(name)}`;
  const taken = new Set(index.entities.map((e) => e.id));
  if (!taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Refuse a write onto an identity key more than one canonical record
 * already claims.
 *
 * The index keeps the walk's FIRST claimant in `byKey` so reads stay
 * deterministic, which is right for a read and wrong for a write: the
 * update arm would rewrite that record's `source_agent`, `updated_at` and
 * body, keep its label rather than the caller's, leave every other
 * claimant untouched, and report `created: false` - which reads as
 * "already there". A caller cannot tell that from a successful update,
 * and the record it did not mean to write was chosen by directory order.
 *
 * Refused for ANY contested key, not only the quote-variant one: the
 * silent wrong-record write does not depend on how the vault arrived at
 * two claimants. When the fold IS how it arrived, the message adds the
 * cause and the registered command, because that is the collision an
 * operator meets for the first time straight after an upgrade.
 *
 * Only the canonical lane is checked. `conflicts` is built at the
 * canonical status scope, so a quarantined namesake is not a claimant of
 * this key; the untrusted lane's own multiple-match case is the ambiguity
 * error in {@link resolveQuarantined}.
 */
function assertIdentityKeyUncontested(index: EntityIndex, key: string, category: string): void {
  const conflict = findEntityConflict(index, ENTITY_CONFLICT_KIND.duplicateName, key);
  if (conflict === null) return;
  const claimants = conflictClaimants(index, conflict);
  const listed = claimants.map((c) => `${c.id} (${c.path})`).join(", ");
  const tail = quoteVariantCollisionTail(...claimants.map((c) => c.name));
  throw new Error(
    `identity '${key}' (${category}) is claimed by ${conflict.paths.length} canonical entity ` +
      `records: ${listed} - a write would land on the first of them and leave the rest, so it ` +
      `is refused. Archive or merge the duplicates first${tail}.`,
  );
}

// ----- Operations ------------------------------------------------------------

export function upsertEntity(vault: string, input: UpsertEntityInput): UpsertEntityResult {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const category = validateEntityCategory(input.category);
  // Label quality gate (A1): strip Markdown/punctuation decoration BEFORE
  // normalisation and reject structurally-junk or denylisted names with a
  // typed error at this creation boundary. The stored display name is the
  // sanitised form; for a clean label sanitisation is a no-op, so the
  // identity key stays byte-identical to before (backward compatibility).
  const denylist = resolveEntityLabelDenylist(input.configPath);
  const name = assertValidEntityLabel(input.name, { denylist });
  const index = buildEntityIndex(vault);
  const stamp = isoSecond(input.now);

  // Resolve inside this write's own lane (see resolveWriteTarget): name key
  // first, alias second, and never across the trusted/untrusted boundary.
  const untrusted = input.untrustedOrigin === true;
  const key = entityIdentityKey(category, name);
  if (!untrusted) assertIdentityKeyUncontested(index, key, category);
  const target = resolveWriteTarget(index, { category, query: name }, untrusted);

  if (target === null) {
    // The name may be held by an archived entity - refuse with the remedy
    // instead of silently forking a second file for the same identity.
    const archivedHolder = index.entities.find(
      (e) =>
        e.status === BRAIN_ENTITY_STATUS.archived && entityIdentityKey(e.category, e.name) === key,
    );
    if (archivedHolder) {
      throw new Error(
        `entity '${name}' (${category}) exists but is archived: ${archivedHolder.id}. ` +
          "Restore it (entity archive --restore) or choose another name.",
      );
    }
  }

  const aliases = checkAliasClaims(
    index,
    category,
    target?.id ?? null,
    target?.name ?? name,
    input.aliases ?? [],
  );

  if (target !== null) {
    const [meta, existingBody] = parseFrontmatter(target.path);
    const mergedAliases = [...target.aliases];
    for (const alias of aliases) {
      if (!mergedAliases.some((a) => normalizeEntityName(a) === normalizeEntityName(alias))) {
        mergedAliases.push(alias);
      }
    }
    const fields: FrontmatterMap = {
      kind: BRAIN_ENTITY_KIND,
      entity_id: target.id,
      category: target.category,
      name: target.name,
      ...(mergedAliases.length > 0 ? { aliases: mergedAliases } : {}),
      status: target.status,
      source_agent: input.agent,
      ...(input.confidence !== undefined
        ? { confidence: input.confidence }
        : target.confidence !== undefined
          ? { confidence: target.confidence }
          : {}),
      created_at: target.created_at,
      updated_at: stamp,
      tags: ["brain", "brain/entity"],
    };
    // The target's status is carried forward, which is now safe by
    // construction: the lane guarantees a trusted write never sees a
    // quarantined target and an untrusted one never sees a canonical target.
    // The marker is re-asserted on the untrusted lane rather than trusted to
    // the frontmatter that was there, so status and marker cannot drift apart
    // through a hand edit or a partial sync.
    const extras: FrontmatterMap = {
      ...meta,
      ...(untrusted ? untrustedSourceFrontmatter(INTAKE_TRUST.untrusted) : {}),
    };
    writeEntityFile(target.path, fields, extras, input.body ?? existingBody, { overwrite: true });
    const entity = parseEntityFile(target.path);
    if (entity === null) throw new Error(`entity file unreadable after write: ${target.path}`);
    return { entity, created: false };
  }

  const id = allocateEntityId(index, category, name);
  const path = entityPath(vault, category, id);
  // Untrusted provenance decides two things about the new record: the status
  // it lands at, and the marker the retrieval gate reads. Both come from the
  // one lane flag, so they cannot disagree.
  const fields: FrontmatterMap = {
    kind: BRAIN_ENTITY_KIND,
    entity_id: id,
    category,
    name,
    ...(aliases.length > 0 ? { aliases } : {}),
    status: untrusted ? BRAIN_ENTITY_STATUS.quarantine : BRAIN_ENTITY_STATUS.active,
    source_agent: input.agent,
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    created_at: stamp,
    updated_at: stamp,
    tags: ["brain", "brain/entity"],
  };
  // Both records the lane writes on creation: the marker the retrieval gate
  // reads, and the audit digest of the bytes this record was extracted from.
  // Merged in one map so a page cannot carry one without the other having had
  // its chance.
  const extrasOnCreate: FrontmatterMap = {
    ...untrustedSourceFrontmatter(untrusted ? INTAKE_TRUST.untrusted : INTAKE_TRUST.trusted),
    ...sourceContentHashFrontmatter(input.sourceContentHash),
  };
  writeEntityFile(path, fields, extrasOnCreate, input.body ?? input.bodyOnCreate ?? `# ${name}`, {
    overwrite: false,
  });
  const entity = parseEntityFile(path);
  if (entity === null) throw new Error(`entity file unreadable after write: ${path}`);
  return { entity, created: true };
}

/**
 * Why an endpoint did not resolve, and what to do about it. A canonical
 * relate that misses a name a quarantined record holds is not a missing
 * entity - it is a record the caller is not entitled to reach yet, and the
 * message names the release that changes that rather than leaving a dead end.
 */
function missingEndpoint(index: EntityIndex, ref: EntityRef, untrustedOrigin: boolean): string {
  const base = `entity not found: ${JSON.stringify(ref.query)}`;
  if (untrustedOrigin) return base;
  const quarantined = resolveQuarantined(index, ref);
  if (quarantined === null) return base;
  return (
    `${base} - ${quarantined.id} holds that name in quarantine, where an untrusted source ` +
    "introduced it. Release it (entity archive --restore) to relate it."
  );
}

export function relateEntities(vault: string, input: RelateEntitiesInput): BrainEntity {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const relation = normalizeRelation(input.relation);
  if (!isKnownRelation(relation)) {
    throw new Error(
      `unknown relation '${input.relation}' - the relation vocabulary is defined in relation-vocab.ts`,
    );
  }
  const index = buildEntityIndex(vault);
  // Both endpoints resolve in the edge's own lane: an intake that just
  // quarantined two entities must be able to link them, and the edge stays
  // inside the quarantine because both endpoints are unreadable - while an
  // untrusted edge can never attach itself to the operator's record of the
  // same name.
  const untrusted = input.untrustedOrigin === true;
  const from = resolveWriteTarget(index, input.from, untrusted);
  if (from === null) throw new Error(missingEndpoint(index, input.from, untrusted));
  const to = resolveWriteTarget(index, input.to, untrusted);
  if (to === null) throw new Error(missingEndpoint(index, input.to, untrusted));
  if (from.id === to.id) throw new Error("an entity cannot relate to itself");

  const [meta, body] = parseFrontmatter(from.path);
  const existingRaw = meta[relation];
  const targets: string[] = Array.isArray(existingRaw)
    ? [...existingRaw]
    : typeof existingRaw === "string" && existingRaw.trim().length > 0
      ? [existingRaw]
      : [];
  const alreadyLinked = targets.some((t) => normalizeRelationTarget(String(t)) === to.id);
  if (!alreadyLinked) targets.push(`[[${to.id}]]`);

  const fields: FrontmatterMap = {
    kind: BRAIN_ENTITY_KIND,
    entity_id: from.id,
    category: from.category,
    name: from.name,
    ...(from.aliases.length > 0 ? { aliases: [...from.aliases] } : {}),
    status: from.status,
    ...(from.source_agent !== undefined ? { source_agent: from.source_agent } : {}),
    ...(from.confidence !== undefined ? { confidence: from.confidence } : {}),
    created_at: from.created_at,
    updated_at: isoSecond(input.now),
    tags: ["brain", "brain/entity"],
  };
  const extras: FrontmatterMap = { ...meta, [relation]: targets };
  writeEntityFile(from.path, fields, extras, body, { overwrite: true });
  const entity = parseEntityFile(from.path);
  if (entity === null) throw new Error(`entity file unreadable after write: ${from.path}`);
  return entity;
}

export function archiveEntity(
  vault: string,
  ref: EntityRef,
  opts: ArchiveEntityOptions,
): BrainEntity {
  // Vault-identity write guard (context-integrity-gates, Unit J).
  assertVaultIdentityForWrite(vault);
  const index = buildEntityIndex(vault);
  let target: BrainEntity | null;
  if (opts.restore) {
    // Restore resolves what canonical lookup cannot see - archived AND
    // quarantined - because both are records that hold a name without being
    // reachable through it.
    const query = normalizeEntityName(ref.query);
    const matches = index.entities.filter(
      (e) =>
        !entityStatusInScope(e.status, ENTITY_STATUS_SCOPE.canonical) &&
        (ref.category === undefined || e.category === validateEntityCategory(ref.category)) &&
        (normalizeEntityName(e.name) === query ||
          e.aliases.some((a) => normalizeEntityName(a) === query)),
    );
    if (matches.length > 1) {
      throw new Error(
        `archived entity reference '${ref.query}' is ambiguous: ${matches.map((m) => m.id).join(", ")}`,
      );
    }
    target = matches[0] ?? null;
  } else {
    target = resolveActive(index, ref);
  }
  if (target === null) {
    throw new Error(
      `${opts.restore ? "archived " : ""}entity not found: ${JSON.stringify(ref.query)}`,
    );
  }

  const nextStatus = opts.restore ? BRAIN_ENTITY_STATUS.active : BRAIN_ENTITY_STATUS.archived;
  if (target.status === nextStatus) return target;

  if (opts.restore) {
    // Release is where the two write lanes meet again, and a trusted record
    // may have taken this name while the quarantined one was out of scope
    // (that is exactly what a trusted write does with a quarantined
    // namesake). Promoting into that collision would put two active records
    // on one identity key - a duplicate the index reports and no read can
    // resolve deterministically. Which of the two survives is a judgement
    // about the material, so it goes back to the operator with both ids.
    const key = entityIdentityKey(target.category, target.name);
    const holder = index.entities.find(
      (e) =>
        e.id !== target.id &&
        entityStatusInScope(e.status, ENTITY_STATUS_SCOPE.canonical) &&
        entityIdentityKey(e.category, e.name) === key,
    );
    if (holder) {
      throw new Error(
        `cannot restore ${target.id}: ${holder.id} already holds '${target.name}' ` +
          `(${target.category}). Archive or rename ${holder.id} first, or merge the two` +
          `${quoteVariantCollisionTail(target.name, holder.name)}.`,
      );
    }
  }

  const [meta, body] = parseFrontmatter(target.path);
  const stamp = isoSecond(opts.now);
  const fields: FrontmatterMap = {
    kind: BRAIN_ENTITY_KIND,
    entity_id: target.id,
    category: target.category,
    name: target.name,
    ...(target.aliases.length > 0 ? { aliases: [...target.aliases] } : {}),
    status: nextStatus,
    ...(target.source_agent !== undefined ? { source_agent: target.source_agent } : {}),
    ...(target.confidence !== undefined ? { confidence: target.confidence } : {}),
    created_at: target.created_at,
    updated_at: stamp,
    ...(nextStatus === BRAIN_ENTITY_STATUS.archived ? { archived_at: stamp } : {}),
    tags: ["brain", "brain/entity"],
  };
  // `archived_at` must disappear on restore: writeEntityFile only emits
  // the keys present in `fields`, and extras never override own fields.
  // The untrusted-source marker must disappear too, and it is an EXTRA, so
  // it is dropped explicitly: a released record the retrieval gate still
  // excluded would be a restore that reads as success without being one.
  const extras: FrontmatterMap = { ...meta };
  if (opts.restore) delete extras[UNTRUSTED_SOURCE_FRONTMATTER_KEY];
  writeEntityFile(target.path, fields, extras, body, { overwrite: true });
  const entity = parseEntityFile(target.path);
  if (entity === null) throw new Error(`entity file unreadable after write: ${target.path}`);
  return entity;
}
