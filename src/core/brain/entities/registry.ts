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

import { dirname, join } from "node:path";
import { mkdirSync, statSync } from "node:fs";

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
  InvalidEntityLabelError,
  normalizeEntityName,
  quoteVariantCollisionTail,
  validateEntityCategory,
  validateEntityLabel,
  type EntityLabelInvalidReason,
  type EntityLexiconHandle,
} from "./canonical.ts";
import { resolveEntityLexicon } from "./lexicon.ts";
import { resolveEntityLabelDenylist } from "./label-hygiene.ts";
import {
  PERSON_NICKNAMES_ARTIFACT_REL,
  PersonNicknameConfigError,
  resolvePersonNicknameMap,
} from "./person-nicknames.ts";
import {
  derivePersonNameVariants,
  EMPTY_PERSON_NICKNAME_INDEX,
  EMPTY_PERSON_NICKNAME_MAP,
  invertPersonNicknameMap,
  isPersonCategory,
  personNameComparisonForm,
  personVariantQueryForms,
  type PersonNicknameIndex,
  type PersonNicknameMap,
} from "./person-variants.ts";
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
 *
 * The DERIVED lane raises this same type for a different collision: a
 * form that reaches more than one person only through derivation - an
 * initial, a word order, an operator nickname. Those records are two
 * real people, not duplicates, so the remedy is a more specific
 * reference, not a merge; `derived` selects that message. The `name`
 * stays the historic one so generic handlers keyed on the string keep
 * working; callers that must tell the two collisions apart read the
 * flag.
 */
export class EntityAmbiguityError extends Error {
  /** True when the collision exists only through derivation, not declaration. */
  readonly derived: boolean;
  constructor(
    query: string,
    matches: ReadonlyArray<BrainEntity>,
    opts: { derived?: boolean } = {},
  ) {
    const ids = matches.map((m) => m.id).join(", ");
    let message: string;
    if (opts.derived === true) {
      message =
        `entity reference '${query}' matches ${matches.length} person records through a ` +
        `derived name form (an initial, a word order or an operator nickname): ${ids} - ` +
        "that form alone does not name one person. Query the full name or a declared " +
        "alias, or pass a category";
    } else {
      const categories = new Set(matches.map((m) => m.category));
      if (categories.size > 1) {
        message = `entity reference '${query}' is ambiguous across categories: ${ids} - pass a category`;
      } else {
        const normalized = normalizeEntityName(query);
        const tail = quoteVariantCollisionTail(...matches.map((m) => matchedLabel(m, normalized)));
        message =
          `entity reference '${query}' is claimed by ${matches.length} canonical records in one ` +
          `category (${[...categories][0]}): ${ids} - no category separates them, so one must be ` +
          `archived or merged${tail}`;
      }
    }
    super(message);
    this.name = "EntityAmbiguityError";
    this.derived = opts.derived === true;
  }
}

// ----- Derived person-form index ---------------------------------------------

/**
 * The canonical records that answer to one comparison form in each
 * lane: `declared` holds the records naming the form outright (name or
 * alias, any category), `derived` the PERSON records a derivation
 * kernel form of theirs reaches it through. Both lists are id-ordered,
 * because the index walk they are built from is.
 */
export interface PersonFormClaimants {
  readonly declared: ReadonlyArray<BrainEntity>;
  readonly derived: ReadonlyArray<BrainEntity>;
}

/**
 * Everything the derived person-form lanes need, built once per
 * signature: the entity index it was built from (also the entity-change
 * detector - the cache below reuses the index object identity the
 * entity-index memo already maintains), the INVERTED nickname index,
 * the config fault of an unusable nickname file if there was one, and
 * the comparison-form -> claimants map.
 */
export interface PersonDerivedIndex {
  readonly entityIndex: EntityIndex;
  readonly nicknames: PersonNicknameIndex;
  /** Present when `person-nicknames.json` exists but is unusable. */
  readonly nicknameError: PersonNicknameConfigError | null;
  readonly byForm: ReadonlyMap<string, PersonFormClaimants>;
}

function buildPersonDerivedIndex(
  entityIndex: EntityIndex,
  nicknames: PersonNicknameIndex,
  nicknameError: PersonNicknameConfigError | null,
): PersonDerivedIndex {
  const byForm = new Map<string, { declared: BrainEntity[]; derived: BrainEntity[] }>();
  const claim = (form: string, lane: "declared" | "derived", entity: BrainEntity): void => {
    if (!form) return;
    let entry = byForm.get(form);
    if (entry === undefined) {
      entry = { declared: [], derived: [] };
      byForm.set(form, entry);
    }
    const list = entry[lane];
    if (!list.some((e) => e.id === entity.id)) list.push(entity);
  };
  for (const entity of entityIndex.entities) {
    if (!entityStatusInScope(entity.status, ENTITY_STATUS_SCOPE.canonical)) continue;
    const declared = [entity.name, ...entity.aliases].map((f) => normalizeEntityName(f));
    // Every canonical entity claims its declared forms; only person
    // categories also derive (the kernel emits nothing for the others).
    for (const form of declared) {
      claim(personNameComparisonForm(form), "declared", entity);
    }
    if (!isPersonCategory(entity.category)) continue;
    for (const form of declared) {
      for (const variant of derivePersonNameVariants(form, nicknames)) {
        claim(variant, "derived", entity);
      }
    }
  }
  return Object.freeze({
    entityIndex,
    nicknames,
    nicknameError,
    byForm: Object.freeze(byForm),
  });
}

interface PersonDerivedCacheEntry {
  readonly entityIndex: EntityIndex;
  readonly nicknameSignature: string;
  readonly value: PersonDerivedIndex;
}

/** Per-vault memo. Small (a process serves one vault); capped defensively. */
const PERSON_DERIVED_CACHE = new Map<string, PersonDerivedCacheEntry>();
const PERSON_DERIVED_CACHE_MAX = 16;

let unstableSignatureCounter = 0;

/**
 * The nickname file's change signature: nanosecond mtime plus byte size
 * when it exists, a fixed marker when it does not. A stat failure other
 * than a missing file yields a fresh marker each call, so an unreadable
 * file is never cached - the read path keeps surfacing the fault.
 */
function personNicknameFileSignature(vault: string): string {
  try {
    const st = statSync(join(vault, PERSON_NICKNAMES_ARTIFACT_REL), { bigint: true });
    return `${st.mtimeNs}\0${st.size}`;
  } catch (err) {
    if (typeof err === "object" && err !== null && (err as { code?: string }).code === "ENOENT") {
      return "missing";
    }
    unstableSignatureCounter += 1;
    return `unstable-${unstableSignatureCounter}`;
  }
}

/**
 * Resolve the derived person-form index for `vault`, reusing the last
 * build while neither the entity files nor the nickname file changed.
 * The entity side is detected through the entity index's own memo
 * (object identity), the nickname side through its mtime/size
 * signature - so a per-query expansion, a registry read or a doctor
 * scan each pay the parse and the derivation once per signature instead
 * of per call. An unusable nickname file is captured as
 * `nicknameError` (consumers keep their documented degradations); any
 * other fault propagates.
 */
export function resolvePersonDerivedIndex(vault: string): PersonDerivedIndex {
  const entityIndex = buildEntityIndex(vault);
  const nicknameSignature = personNicknameFileSignature(vault);
  const cached = PERSON_DERIVED_CACHE.get(vault);
  if (
    cached !== undefined &&
    cached.entityIndex === entityIndex &&
    cached.nicknameSignature === nicknameSignature
  ) {
    return cached.value;
  }
  let map: PersonNicknameMap;
  let nicknameError: PersonNicknameConfigError | null = null;
  try {
    map = resolvePersonNicknameMap(vault);
  } catch (err) {
    if (!(err instanceof PersonNicknameConfigError)) throw err;
    nicknameError = err;
    map = EMPTY_PERSON_NICKNAME_MAP;
  }
  const value = buildPersonDerivedIndex(
    entityIndex,
    map.size > 0 ? invertPersonNicknameMap(map) : EMPTY_PERSON_NICKNAME_INDEX,
    nicknameError,
  );
  if (PERSON_DERIVED_CACHE.size >= PERSON_DERIVED_CACHE_MAX && !PERSON_DERIVED_CACHE.has(vault)) {
    const oldest = PERSON_DERIVED_CACHE.keys().next().value;
    if (oldest !== undefined) PERSON_DERIVED_CACHE.delete(oldest);
  }
  PERSON_DERIVED_CACHE.set(vault, { entityIndex, nicknameSignature, value });
  return value;
}

/**
 * The DERIVED lane of canonical read resolution: the person variants
 * (write-honesty-egress-consent, F3) - first-initial-plus-surname,
 * reversed word order, operator nicknames - consulted only after the
 * exact name/alias lanes above have missed. The lookup joins the query's
 * forms (itself plus its comparison form - the dotted-initial and
 * comma spellings) against the shared claimants map, over the declared
 * lane too: a "Last, First" spelling that comparison-folds onto a
 * canonical name resolves here rather than nowhere. A unique match
 * resolves; more than one is the same ambiguity the exact lane reports,
 * through the derived message - two real people sharing a form are not
 * duplicates to merge. Like the exact lane it resolves canonical-scope
 * records only, so a quarantined person's variants resolve nothing.
 */
function resolveDerived(derived: PersonDerivedIndex, ref: EntityRef): BrainEntity | null {
  const query = normalizeEntityName(ref.query);
  if (!query) return null;
  const category = ref.category !== undefined ? validateEntityCategory(ref.category) : undefined;
  const matches: BrainEntity[] = [];
  const seenIds = new Set<string>();
  for (const form of personVariantQueryForms(query)) {
    const claimants = derived.byForm.get(form);
    if (claimants === undefined) continue;
    for (const entity of [...claimants.declared, ...claimants.derived]) {
      if (category !== undefined && entity.category !== category) continue;
      if (seenIds.has(entity.id)) continue;
      seenIds.add(entity.id);
      matches.push(entity);
    }
  }
  if (matches.length > 1) {
    matches.sort((a, b) => a.id.localeCompare(b.id));
    throw new EntityAmbiguityError(ref.query, matches, { derived: true });
  }
  return matches[0] ?? null;
}

/**
 * Resolve a ref at the CANONICAL status scope for reading: canonical
 * name first, then alias - and only after BOTH miss, the derived
 * person-variant lane ({@link resolveDerived}). The index's lookup maps
 * are built at the same canonical scope, so the exact branches agree by
 * construction rather than by coincidence.
 *
 * The WRITE path deliberately does not come through here-then-derived
 * as one step: {@link resolveWriteTarget} calls {@link resolveActive}
 * alone, so a write resolves on declared forms only. A record is
 * updated or claimed by the names it chose, never by a form derivation
 * invented for it - and a quarantined namesake's variants (which the
 * canonical scope never holds anyway) stay unreachable in both lanes.
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

/**
 * Read resolution: the exact lanes, then - only on a full miss - the
 * derived person-variant lane. An unusable nickname file is an
 * operator-data fault, not a read outage, so read resolution degrades
 * to exact-only (the posture `PersonNicknameConfigError`'s docblock
 * pins for every consumer).
 */
export function getEntity(vault: string, ref: EntityRef): BrainEntity | null {
  const index = buildEntityIndex(vault);
  const exact = resolveActive(index, ref);
  if (exact !== null) return exact;
  let derived: PersonDerivedIndex;
  try {
    derived = resolvePersonDerivedIndex(vault);
  } catch {
    return null;
  }
  return resolveDerived(derived, ref);
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

/**
 * Whether one of the tightened, lexicon-backed verdicts (recall-quality
 * A2) refuses `name` at a CREATION boundary, and which. The policy split
 * lives here, not in the predicate: a learned verdict is only precise
 * enough to refuse when it cannot be a coincidence -
 *
 *   - `function-word-run` refuses for a SINGLE token: a label that is
 *     nothing but one learned common word. A MULTI-token run can be a
 *     legitimate title in a lexically poor corpus, so it stays advisory
 *     (the doctor and the prune report it store-wide instead).
 *   - `shouted-heading` refuses only a MULTI-token label the store holds
 *     no prior occurrence of (as any record's name or alias): a two-word
 *     all-caps run is pasted `# HEADING` residue. A SINGLE-token shout is
 *     a brand or an acronym-in-expansion (NASA) and stays advisory - the
 *     doctor and the prune report it store-wide; when the store itself
 *     already vouches for the form, even a multi-token shout admits.
 *
 * Everything else - a stale or absent artifact, a caseless corpus, a
 * code-shaped label - returns null and the creation proceeds exactly as
 * before the lexicon existed.
 */
function tightenedCreateRefusal(
  name: string,
  index: EntityIndex,
  lexicon: EntityLexiconHandle,
): EntityLabelInvalidReason | null {
  const verdict = validateEntityLabel(name, { lexicon });
  if (verdict.valid) return null;
  if (verdict.reason === "function-word-run") {
    return name.split(/\s+/).length === 1 ? "function-word-run" : null;
  }
  if (verdict.reason === "shouted-heading") {
    // The design split (recall-quality design.md): the hard gate keeps the
    // MULTI-token, prior-occurrence-free shout; a single-token shout is a
    // brand or acronym-in-expansion and stays advisory via heal/doctor.
    if (name.split(/\s+/).length === 1) return null;
    return hasPriorStoredOccurrence(index, name) ? null : "shouted-heading";
  }
  return null;
}

/** True when any stored record (any status) already answers to `name`. */
function hasPriorStoredOccurrence(index: EntityIndex, name: string): boolean {
  const query = normalizeEntityName(name);
  return index.entities.some(
    (e) =>
      normalizeEntityName(e.name) === query ||
      e.aliases.some((a) => normalizeEntityName(a) === query),
  );
}

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
  // recall-quality A2: the store-learned lexicon is resolved beside the
  // denylist. A null handle (no artifact yet, or one that failed its
  // freshness re-validation) degrades every verdict below to the
  // pre-lexicon structural gate - it can never mis-reject.
  const lexicon = resolveEntityLexicon(vault);
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
    // Tightened verdicts (recall-quality A2) are hard at CREATION only:
    // the update arm above re-admits whatever the store already holds,
    // and a refused label never reaches a write below this point.
    if (lexicon !== null) {
      const refusal = tightenedCreateRefusal(name, index, lexicon);
      if (refusal !== null) throw new InvalidEntityLabelError(input.name, name, refusal);
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
