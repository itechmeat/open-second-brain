/**
 * In-memory identity index over `Brain/entities/`.
 *
 * Built on every read by walking the Markdown files - the registry is
 * small (tens to low hundreds of entities), the walk is cheap, and a
 * persisted index file under Syncthing would reintroduce the very
 * write-conflict class the Memory Integrity Suite removes. The files
 * are the single source of truth; this index is a pure projection.
 *
 * Lookup maps contain the entities admitted at the CANONICAL status scope
 * (`status-scope.ts`) - today, `active` alone. Archived and quarantined
 * entities stay in `entities`, which is the raw projection the registry,
 * doctor and audit paths filter for themselves, but never resolve through
 * `byKey` / `byAlias`. Duplicate identity claims - possible via hand
 * edits or sync merges - are reported as `conflicts`, with the walk's
 * first claimant kept in the lookup maps so reads stay deterministic.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { parseFrontmatter } from "../../vault.ts";
import { extractFrontmatterRelations } from "../../graph/frontmatter-relations.ts";
import { brainDirs } from "../paths.ts";
import { entityIdentityKey, normalizeEntityName } from "./canonical.ts";
import { ENTITY_STATUS_SCOPE, entityStatusInScope } from "./status-scope.ts";
import {
  BRAIN_ENTITY_KIND,
  BRAIN_ENTITY_STATUS,
  isBrainEntityStatus,
  type BrainEntity,
  type EntityConflict,
  type EntityConflictKind,
} from "./types.ts";

export interface EntityIndex {
  /** Every parseable entity (any status), sorted by id. */
  readonly entities: ReadonlyArray<BrainEntity>;
  /** Active entities by identity key `category:normalized-name`. */
  readonly byKey: ReadonlyMap<string, BrainEntity>;
  /** Active entities by normalized alias (aliases are globally unique). */
  readonly byAlias: ReadonlyMap<string, BrainEntity>;
  /** Duplicate identity claims for doctor / write-time refusal. */
  readonly conflicts: ReadonlyArray<EntityConflict>;
}

/**
 * The two ways one key can be claimed twice, named once. The literals
 * were spelled at the two `claim` sites below, at the doctor's message,
 * and at every consumer that had to ask which kind it was holding.
 */
export const ENTITY_CONFLICT_KIND = Object.freeze({
  duplicateName: "duplicate-name",
  duplicateAlias: "duplicate-alias",
} as const satisfies Record<string, EntityConflictKind>);

/**
 * The conflict of `kind` claiming `key`, or `null` when the key is held
 * once (the ordinary case) or not at all.
 *
 * Published so the WRITE seam and the DOCTOR ask one question rather than
 * two: `upsertEntity` must refuse the identity keys the doctor reports as
 * contested, and a second re-derivation of "contested" here would be free
 * to disagree with this one.
 */
export function findEntityConflict(
  index: EntityIndex,
  kind: EntityConflictKind,
  key: string,
): EntityConflict | null {
  return index.conflicts.find((c) => c.kind === kind && c.key === key) ?? null;
}

/**
 * The records a conflict names, in the walk order it recorded them.
 *
 * `EntityConflict` carries paths and not records - deliberately, so the
 * doctor's finding stays a statement about files - and every consumer
 * that needs the ids or the raw labels behind those paths resolves them
 * here instead of widening the shared record type.
 */
export function conflictClaimants(
  index: EntityIndex,
  conflict: EntityConflict,
): ReadonlyArray<BrainEntity> {
  const byPath = new Map(index.entities.map((e) => [e.path, e]));
  const out: BrainEntity[] = [];
  for (const path of conflict.paths) {
    const entity = byPath.get(path);
    if (entity !== undefined) out.push(entity);
  }
  return out;
}

/** Parse one entity file; `null` when it is not a valid entity. */
export function parseEntityFile(path: string): BrainEntity | null {
  const [meta, body] = parseFrontmatter(path);
  if (meta["kind"] !== BRAIN_ENTITY_KIND) return null;
  const id = typeof meta["entity_id"] === "string" ? meta["entity_id"] : "";
  const category = typeof meta["category"] === "string" ? meta["category"] : "";
  const name = typeof meta["name"] === "string" ? meta["name"] : "";
  const status = meta["status"];
  if (!id || !category || !name || !isBrainEntityStatus(status)) return null;
  const aliasesRaw = meta["aliases"];
  const aliases = Array.isArray(aliasesRaw)
    ? aliasesRaw.filter((a): a is string => typeof a === "string" && a.trim().length > 0)
    : [];
  const createdAt = typeof meta["created_at"] === "string" ? meta["created_at"] : "";
  const updatedAt = typeof meta["updated_at"] === "string" ? meta["updated_at"] : createdAt;
  if (!createdAt) return null;
  const archivedAt = typeof meta["archived_at"] === "string" ? meta["archived_at"] : undefined;
  const sourceAgent = typeof meta["source_agent"] === "string" ? meta["source_agent"] : undefined;
  const confidence = typeof meta["confidence"] === "string" ? meta["confidence"] : undefined;
  return Object.freeze({
    id,
    category,
    name,
    aliases: Object.freeze(aliases),
    status,
    ...(sourceAgent !== undefined ? { source_agent: sourceAgent } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    created_at: createdAt,
    updated_at: updatedAt,
    ...(archivedAt !== undefined && status === BRAIN_ENTITY_STATUS.archived
      ? { archived_at: archivedAt }
      : {}),
    relations: Object.freeze(extractFrontmatterRelations(meta)),
    path,
    body,
  });
}

/** Sorted absolute paths of every `.md` under `Brain/entities/`, one level of category dirs. */
function walkEntityFiles(vault: string): string[] {
  const root = brainDirs(vault).entities;
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).toSorted((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    if (entry.isFile() && entry.name.endsWith(".md")) {
      out.push(join(root, entry.name));
      continue;
    }
    if (!entry.isDirectory()) continue;
    const dir = join(root, entry.name);
    for (const name of readdirSync(dir).toSorted()) {
      if (name.endsWith(".md")) out.push(join(dir, name));
    }
  }
  return out;
}

/**
 * Cheap change-signature over the entity files: sorted paths plus each
 * file's nanosecond mtime and byte size. Skips the per-file `readFileSync`
 * + frontmatter parse that dominates a full build, so it is safe to run on
 * every query. Nanosecond resolution + size closes the sub-millisecond
 * in-place-edit window a dir-mtime-only probe would leave open.
 *
 * Returns the walked file list alongside the signature so a cache miss
 * reuses this walk instead of scanning the directory tree a second time.
 */
function entityIndexSignature(vault: string): { files: string[]; signature: string } {
  const files = walkEntityFiles(vault);
  const parts: string[] = [];
  for (const path of files) {
    try {
      const st = statSync(path, { bigint: true });
      parts.push(`${path}\0${st.mtimeNs}\0${st.size}`);
    } catch {
      // File vanished between walk and stat: fold in a distinct marker so
      // the signature still changes relative to a build that saw it.
      parts.push(`${path}\0-`);
    }
  }
  return { files, signature: parts.join("\n") };
}

interface IndexCacheEntry {
  readonly signature: string;
  readonly index: EntityIndex;
}

/** Per-vault memo. Small (a process serves one vault); capped defensively. */
const INDEX_CACHE = new Map<string, IndexCacheEntry>();
const INDEX_CACHE_MAX = 16;

/**
 * Build the identity index, reusing the last result when nothing under
 * `Brain/entities/` changed since (mtime/size-keyed). The registry rebuilds
 * after each write, so the memo also serves those callers correctly: a write
 * shifts the signature and forces a fresh build. A write that lands within
 * the (now nanosecond) mtime granularity of the previous build can serve one
 * stale read - a deliberate, documented trade-off for the per-query win.
 */
export function buildEntityIndex(vault: string): EntityIndex {
  const { files, signature } = entityIndexSignature(vault);
  const cached = INDEX_CACHE.get(vault);
  if (cached && cached.signature === signature) return cached.index;
  const index = buildEntityIndexUncached(files);
  if (INDEX_CACHE.size >= INDEX_CACHE_MAX && !INDEX_CACHE.has(vault)) {
    const oldest = INDEX_CACHE.keys().next().value;
    if (oldest !== undefined) INDEX_CACHE.delete(oldest);
  }
  INDEX_CACHE.set(vault, Object.freeze({ signature, index }));
  return index;
}

/** Drop memoized indexes. Test-only hook so suites start from a cold cache. */
export function __clearEntityIndexCache(): void {
  INDEX_CACHE.clear();
}

function buildEntityIndexUncached(files: string[]): EntityIndex {
  const entities: BrainEntity[] = [];
  for (const path of files) {
    const entity = parseEntityFile(path);
    if (entity !== null) entities.push(entity);
  }
  entities.sort((a, b) => a.id.localeCompare(b.id));

  const byKey = new Map<string, BrainEntity>();
  const byAlias = new Map<string, BrainEntity>();
  const claims = new Map<string, { kind: EntityConflictKind; paths: string[] }>();

  const claim = (
    kind: EntityConflictKind,
    key: string,
    entity: BrainEntity,
    map: Map<string, BrainEntity>,
  ): void => {
    const existing = claims.get(`${kind}\0${key}`);
    if (existing) {
      existing.paths.push(entity.path);
      return;
    }
    claims.set(`${kind}\0${key}`, { kind, paths: [entity.path] });
    map.set(key, entity);
  };

  for (const entity of entities) {
    if (!entityStatusInScope(entity.status, ENTITY_STATUS_SCOPE.canonical)) continue;
    let key: string;
    try {
      key = entityIdentityKey(entity.category, entity.name);
    } catch {
      continue; // malformed category - doctor reports through conflicts elsewhere
    }
    claim(ENTITY_CONFLICT_KIND.duplicateName, key, entity, byKey);
    for (const alias of entity.aliases) {
      const normalized = normalizeEntityName(alias);
      if (!normalized) continue;
      claim(ENTITY_CONFLICT_KIND.duplicateAlias, normalized, entity, byAlias);
    }
  }

  const conflicts: EntityConflict[] = [];
  for (const [packed, { kind, paths }] of claims) {
    if (paths.length < 2) continue;
    conflicts.push(
      Object.freeze({
        kind,
        key: packed.slice(packed.indexOf("\0") + 1),
        paths: Object.freeze(paths),
      }),
    );
  }

  return Object.freeze({
    entities: Object.freeze(entities),
    byKey,
    byAlias,
    conflicts: Object.freeze(conflicts),
  });
}
