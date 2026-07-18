/**
 * Canonical entity registry operations (Memory Integrity Suite).
 *
 * Write-side contract: one canonical entity per `(category, normalized
 * name)`. `upsertEntity` resolves through names AND aliases before
 * creating anything, so duplicates are refused at the write seam;
 * doctor lints catch the ones that arrive by hand-editing or sync.
 * All operations are deterministic - the caller injects the clock.
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
import {
  assertValidEntityLabel,
  entityIdentityKey,
  normalizeEntityName,
  validateEntityCategory,
} from "./canonical.ts";
import { resolveEntityLabelDenylist } from "./label-hygiene.ts";
import { buildEntityIndex, parseEntityFile, type EntityIndex } from "./index-builder.ts";
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
  /** Config path for denylist resolution; env still wins when set. */
  readonly configPath?: string;
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
}

export interface ArchiveEntityOptions {
  readonly now: Date;
  /** When true, return an archived entity to active lookup. */
  readonly restore?: boolean;
}

// ----- Lookup ----------------------------------------------------------------

/** A category-less reference matched entities in several categories. */
export class EntityAmbiguityError extends Error {
  constructor(query: string, ids: ReadonlyArray<string>) {
    super(
      `entity reference '${query}' is ambiguous across categories: ${ids.join(", ")} - pass a category`,
    );
    this.name = "EntityAmbiguityError";
  }
}

/** Resolve a ref against ACTIVE entities: canonical name first, then alias. */
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
      e.status === BRAIN_ENTITY_STATUS.active &&
      (normalizeEntityName(e.name) === query ||
        e.aliases.some((a) => normalizeEntityName(a) === query)),
  );
  if (matches.length > 1) {
    throw new EntityAmbiguityError(
      ref.query,
      matches.map((m) => m.id),
    );
  }
  return matches[0] ?? null;
}

export function getEntity(vault: string, ref: EntityRef): BrainEntity | null {
  return resolveActive(buildEntityIndex(vault), ref);
}

export function listEntities(vault: string, opts: ListEntitiesOptions = {}): BrainEntity[] {
  const category = opts.category !== undefined ? validateEntityCategory(opts.category) : undefined;
  return buildEntityIndex(vault).entities.filter(
    (e) =>
      (category === undefined || e.category === category) &&
      (opts.status === undefined || e.status === opts.status),
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
      throw new Error(
        `alias '${alias}' is already claimed by ${aliasHolder.id} (${aliasHolder.path})`,
      );
    }
    const nameHolder = index.byKey.get(`${category}:${normalized}`);
    if (nameHolder && nameHolder.id !== selfId) {
      throw new Error(
        `alias '${alias}' collides with the canonical name of ${nameHolder.id} (${nameHolder.path})`,
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

// ----- Operations ------------------------------------------------------------

export function upsertEntity(vault: string, input: UpsertEntityInput): UpsertEntityResult {
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

  // Resolve to an existing canonical entity: name key first, alias second.
  const key = entityIdentityKey(category, name);
  let target = index.byKey.get(key) ?? null;
  if (target === null) {
    const viaAlias = index.byAlias.get(normalizeEntityName(name));
    if (viaAlias && viaAlias.category === category) target = viaAlias;
  }

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
    writeEntityFile(target.path, fields, meta, input.body ?? existingBody, { overwrite: true });
    const entity = parseEntityFile(target.path);
    if (entity === null) throw new Error(`entity file unreadable after write: ${target.path}`);
    return { entity, created: false };
  }

  const id = allocateEntityId(index, category, name);
  const path = entityPath(vault, category, id);
  const fields: FrontmatterMap = {
    kind: BRAIN_ENTITY_KIND,
    entity_id: id,
    category,
    name,
    ...(aliases.length > 0 ? { aliases } : {}),
    status: BRAIN_ENTITY_STATUS.active,
    source_agent: input.agent,
    ...(input.confidence !== undefined ? { confidence: input.confidence } : {}),
    created_at: stamp,
    updated_at: stamp,
    tags: ["brain", "brain/entity"],
  };
  writeEntityFile(path, fields, {}, input.body ?? `# ${name}`, { overwrite: false });
  const entity = parseEntityFile(path);
  if (entity === null) throw new Error(`entity file unreadable after write: ${path}`);
  return { entity, created: true };
}

export function relateEntities(vault: string, input: RelateEntitiesInput): BrainEntity {
  const relation = normalizeRelation(input.relation);
  if (!isKnownRelation(relation)) {
    throw new Error(
      `unknown relation '${input.relation}' - the relation vocabulary is defined in relation-vocab.ts`,
    );
  }
  const index = buildEntityIndex(vault);
  const from = resolveActive(index, input.from);
  if (from === null) throw new Error(`entity not found: ${JSON.stringify(input.from)}`);
  const to = resolveActive(index, input.to);
  if (to === null) throw new Error(`entity not found: ${JSON.stringify(input.to)}`);
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
  const index = buildEntityIndex(vault);
  let target: BrainEntity | null;
  if (opts.restore) {
    const query = normalizeEntityName(ref.query);
    const matches = index.entities.filter(
      (e) =>
        e.status === BRAIN_ENTITY_STATUS.archived &&
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
  writeEntityFile(target.path, fields, meta, body, { overwrite: true });
  const entity = parseEntityFile(target.path);
  if (entity === null) throw new Error(`entity file unreadable after write: ${target.path}`);
  return entity;
}
