/**
 * The locked overwrite of an entity page (change
 * `tool-lane-write-keeps-standing`, design D2 item 5 and D6 item 1).
 *
 * The registry resolves an overwrite's target from the entity index
 * (`buildEntityIndex`), read before any lock. A version of the entity
 * written after that read would be lost if the page were rebuilt from the
 * index entry. So the three overwrites of the registry (an upsert's update
 * arm, a relation, an archive or a restore) write through
 * {@link writeLockedEntity}: under the page's lane lock it takes the base
 * of the write (`readLaneBase`), reads the entity again
 * (`parseEntityFile`), refuses with `LaneEntryChangedError` `changed` when
 * the entity is gone or the page now holds another entity, builds the
 * written fields from that read, and hands the base to the write, which
 * refuses a version that lands after it. Order: lock, base, re-read, write.
 */

import type { FrontmatterMap } from "../../types.ts";
import { brainRelOf } from "../../store/lane-entry-store.ts";
import {
  LaneEntryChangedError,
  parseLanePage,
  readLaneBase,
  withLaneLock,
  type LaneEntrySnapshot,
} from "../../store/lane-pages.ts";
import { parseEntityFile } from "./index-builder.ts";
import { BRAIN_ENTITY_KIND, type BrainEntity } from "./types.ts";

/** An overwrite being built from the entity read under its lock. */
export interface EntityDraft {
  /** The entity as the page holds it now, read again under the lock. */
  readonly entity: BrainEntity;
  /** The entity's own fields, built from {@link entity}; the change edits them. */
  readonly fields: FrontmatterMap;
  /** The page's frontmatter as stored: the operator's extra keys, relations among them. */
  readonly extras: FrontmatterMap;
  /** The page's body as stored; the change may replace it. */
  body: string;
}

/** The write the registry makes with the built page and the base it was computed from. */
export type EntityPageWrite = (
  fields: FrontmatterMap,
  extras: FrontmatterMap,
  body: string,
  replaces: LaneEntrySnapshot | null,
) => void;

/**
 * Overwrite the entity page of `target` under its lane lock (see the module
 * docblock): `change` makes the overwrite's own edit to a draft built from
 * the entity read again after the base, and `write` writes it with that
 * base. `updatedAt` stamps the draft's `updated_at`.
 */
export function writeLockedEntity(
  vault: string,
  target: Pick<BrainEntity, "id" | "path">,
  updatedAt: string,
  change: (draft: EntityDraft) => void,
  write: EntityPageWrite,
): void {
  withLaneLock(vault, target.path, () => {
    const base = readLaneBase(vault, target.path);
    const entity = parseEntityFile(target.path, vault);
    if (entity === null || entity.id !== target.id) {
      throw new LaneEntryChangedError(brainRelOf(vault, target.path), "changed");
    }
    const [meta, body] = parseLanePage(vault, target.path);
    const draft: EntityDraft = {
      entity,
      fields: entityFields(entity, updatedAt),
      extras: { ...meta },
      body,
    };
    change(draft);
    write(draft.fields, draft.extras, draft.body, base);
  });
}

/** The entity's own fields as an overwrite writes them, from `entity`. */
function entityFields(entity: BrainEntity, updatedAt: string): FrontmatterMap {
  return {
    kind: BRAIN_ENTITY_KIND,
    entity_id: entity.id,
    category: entity.category,
    name: entity.name,
    ...(entity.aliases.length > 0 ? { aliases: [...entity.aliases] } : {}),
    status: entity.status,
    ...(entity.source_agent !== undefined ? { source_agent: entity.source_agent } : {}),
    ...(entity.confidence !== undefined ? { confidence: entity.confidence } : {}),
    created_at: entity.created_at,
    updated_at: updatedAt,
    tags: ["brain", "brain/entity"],
  };
}
