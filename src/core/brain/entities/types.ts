/**
 * Canonical entity registry types (Memory Integrity Suite, design:
 * docs/brainstorm/memory-integrity/design.md).
 *
 * One canonical entity per `(category, normalized name)` lives at
 * `Brain/entities/<category>/<entity-id>.md` as plain Markdown with
 * frontmatter. The Markdown files are the single source of truth; every
 * index over them is rebuilt on read and never persisted.
 */

import type { RelationEdge } from "../../graph/frontmatter-relations.ts";

export const BRAIN_ENTITY_STATUS = {
  active: "active",
  archived: "archived",
} as const;

export type BrainEntityStatus = (typeof BRAIN_ENTITY_STATUS)[keyof typeof BRAIN_ENTITY_STATUS];

const STATUS_VALUES: ReadonlyArray<string> = Object.values(BRAIN_ENTITY_STATUS);

export function isBrainEntityStatus(value: unknown): value is BrainEntityStatus {
  return typeof value === "string" && STATUS_VALUES.includes(value);
}

/** Frontmatter `kind:` marker of an entity file. */
export const BRAIN_ENTITY_KIND = "brain-entity";

/** Filename/id prefix: `ent-<category>-<name-slug>`. */
export const BRAIN_ENTITY_ID_PREFIX = "ent-";

/** A parsed canonical entity. */
export interface BrainEntity {
  /** Stable id, identical to the file basename: `ent-<category>-<slug>`. */
  readonly id: string;
  readonly category: string;
  /** Display name verbatim as the operator wrote it. */
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly status: BrainEntityStatus;
  readonly source_agent?: string;
  readonly confidence?: string;
  readonly created_at: string;
  readonly updated_at: string;
  /** Present only while `status` is `archived`. */
  readonly archived_at?: string;
  /** Typed relation edges from the entity's frontmatter (relation-vocab). */
  readonly relations: ReadonlyArray<RelationEdge>;
  /** Absolute file path. */
  readonly path: string;
  /** Markdown body - the entity's current structured state. */
  readonly body: string;
}

export type EntityConflictKind = "duplicate-name" | "duplicate-alias";

/** A duplicate identity claim discovered while building the index. */
export interface EntityConflict {
  readonly kind: EntityConflictKind;
  /** The contested key: `category:name` or the normalized alias. */
  readonly key: string;
  /** Absolute paths of every file claiming the key, in walk order. */
  readonly paths: ReadonlyArray<string>;
}

/** Reference used by lookup verbs: optional category plus name-or-alias. */
export interface EntityRef {
  readonly category?: string;
  readonly query: string;
}
