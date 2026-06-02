/**
 * Registry-aware query entity expansion (Memory Integrity Suite).
 *
 * `extractEntities` pulls entity strings out of the raw query; this
 * module folds the canonical entity registry over that set so a query
 * naming an ALIAS also matches chunks naming the CANONICAL entity and
 * vice versa. Expansion is additive and fail-soft: no registry (or an
 * unreadable one) leaves the query entity set untouched, so vaults
 * without `Brain/entities/` rank bit-identically to pre-registry
 * behaviour.
 */

import { buildEntityIndex } from "../brain/entities/index-builder.ts";
import { normalizeEntityName } from "../brain/entities/canonical.ts";
import { BRAIN_ENTITY_STATUS } from "../brain/entities/types.ts";

export interface QueryEntityExpansion {
  /** Original query entities plus every form added by the registry. */
  readonly expanded: ReadonlyArray<string>;
  /** Only the forms the registry added (for canonical-hop attribution). */
  readonly added: ReadonlyArray<string>;
  /** Ids of the canonical entities whose forms were added, sorted. */
  readonly sourceIds: ReadonlyArray<string>;
}

/**
 * Expand query entities with canonical names and aliases from the
 * registry. A registry entity participates when ANY of its forms
 * (name or alias) appears among the query entities; all its other
 * forms are then added.
 */
export function expandQueryEntities(
  vault: string,
  queryEntities: ReadonlyArray<string>,
): QueryEntityExpansion {
  const identity: QueryEntityExpansion = Object.freeze({
    expanded: queryEntities,
    added: Object.freeze([] as string[]),
    sourceIds: Object.freeze([] as string[]),
  });
  if (queryEntities.length === 0) return identity;

  let index;
  try {
    index = buildEntityIndex(vault);
  } catch {
    return identity; // fail-soft: search never breaks on a bad registry
  }
  if (index.entities.length === 0) return identity;

  const querySet = new Set(queryEntities.map((e) => normalizeEntityName(e)));
  const added: string[] = [];
  const addedSet = new Set<string>();
  const sourceIds: string[] = [];

  for (const entity of index.entities) {
    if (entity.status !== BRAIN_ENTITY_STATUS.active) continue;
    const forms = [entity.name, ...entity.aliases].map((f) => normalizeEntityName(f));
    if (!forms.some((f) => querySet.has(f))) continue;
    let contributed = false;
    for (const form of forms) {
      if (querySet.has(form) || addedSet.has(form) || form.length < 2) continue;
      addedSet.add(form);
      added.push(form);
      contributed = true;
    }
    if (contributed) sourceIds.push(entity.id);
  }

  if (added.length === 0) return identity;
  return Object.freeze({
    expanded: Object.freeze([...queryEntities, ...added]),
    added: Object.freeze(added),
    sourceIds: Object.freeze(sourceIds.toSorted()),
  });
}
