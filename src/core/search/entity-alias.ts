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
 *
 * Person-category entities additionally derive PERSON-NAME VARIANTS
 * (write-honesty-egress-consent, F3) - first-initial-plus-surname,
 * reversed word order, and operator-supplied nicknames - which join the
 * participation test and the expanded set beside the declared forms.
 * Derived forms are tracked in their own `derived` array so attribution
 * can tell a declared-form match from a derived-variant match; the
 * derivation kernel is the leaf module `person-variants.ts`, and the
 * nickname data is operator-supplied only (`person-nicknames.json` in
 * the vault, resolved by `resolvePersonNicknameMap` in
 * `person-nicknames.ts` - never a shipped word list).
 */

import { buildEntityIndex } from "../brain/entities/index-builder.ts";
import { normalizeEntityName } from "../brain/entities/canonical.ts";
import {
  PERSON_NICKNAMES_ARTIFACT_REL,
  PersonNicknameConfigError,
  resolvePersonNicknameMap,
} from "../brain/entities/person-nicknames.ts";
import {
  derivePersonNameVariants,
  isPersonCategory,
  type PersonNicknameMap,
} from "../brain/entities/person-variants.ts";
import { ENTITY_STATUS_SCOPE, entityStatusInScope } from "../brain/entities/status-scope.ts";

// The nickname reader lives on the brain side (`person-nicknames.ts`),
// beside the kernel it feeds: the registry's derived lookup lane and the
// doctor's collision scan consume it from there, and the brain must not
// import from `src/core/search/`. The re-export keeps this module's
// public surface byte-identical to C2.
export { PERSON_NICKNAMES_ARTIFACT_REL, PersonNicknameConfigError, resolvePersonNicknameMap };

export interface QueryEntityExpansion {
  /** Original query entities plus every form added by the registry. */
  readonly expanded: ReadonlyArray<string>;
  /** Only the forms the registry added (for canonical-hop attribution). */
  readonly added: ReadonlyArray<string>;
  /**
   * Only the forms PERSON-VARIANT DERIVATION added, beside the declared
   * {@link added} - so attribution can tell a declared-form match from
   * a derived-variant match. Empty unless a person-category entity
   * participated through a derived form the query did not already
   * carry.
   */
  readonly derived: ReadonlyArray<string>;
  /** Ids of the canonical entities whose forms were added, sorted. */
  readonly sourceIds: ReadonlyArray<string>;
}

/**
 * Expand query entities with canonical names and aliases from the
 * registry. A registry entity participates when ANY of its forms
 * (name or alias) appears among the query entities - or, for a
 * person-category entity, when any DERIVED person variant of its forms
 * does - and the entity's other forms (declared and derived) are then
 * added.
 */
export function expandQueryEntities(
  vault: string,
  queryEntities: ReadonlyArray<string>,
): QueryEntityExpansion {
  const identity: QueryEntityExpansion = Object.freeze({
    expanded: queryEntities,
    added: Object.freeze([] as string[]),
    derived: Object.freeze([] as string[]),
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

  let nicknames: PersonNicknameMap;
  try {
    nicknames = resolvePersonNicknameMap(vault);
  } catch {
    return identity; // fail-soft: an unusable nickname file is not a search outage
  }

  const querySet = new Set(queryEntities.map((e) => normalizeEntityName(e)));
  const added: string[] = [];
  const addedSet = new Set<string>();
  const derived: string[] = [];
  const derivedSet = new Set<string>();
  const sourceIds: string[] = [];

  for (const entity of index.entities) {
    if (!entityStatusInScope(entity.status, ENTITY_STATUS_SCOPE.canonical)) continue;
    const forms = [entity.name, ...entity.aliases].map((f) => normalizeEntityName(f));
    // Person-category entities derive variants per declared form; the
    // variants join the PARTICIPATION test (a query naming a derived
    // form picks the entity up) and, below, the expanded set.
    const derivedByForm = isPersonCategory(entity.category)
      ? forms.map((f) => derivePersonNameVariants(f, nicknames))
      : null;
    const participates =
      forms.some((f) => querySet.has(f)) ||
      (derivedByForm !== null &&
        derivedByForm.some((variants) => variants.some((v) => querySet.has(v))));
    if (!participates) continue;
    let contributed = false;
    for (const form of forms) {
      if (querySet.has(form) || addedSet.has(form) || form.length < 2) continue;
      addedSet.add(form);
      added.push(form);
      contributed = true;
    }
    if (derivedByForm !== null) {
      for (const variants of derivedByForm) {
        for (const variant of variants) {
          // A derived form another entity (or this one) already DECLARED
          // is tracked as declared: declared attribution wins.
          if (querySet.has(variant) || addedSet.has(variant) || derivedSet.has(variant)) continue;
          derivedSet.add(variant);
          derived.push(variant);
          contributed = true;
        }
      }
    }
    if (contributed) sourceIds.push(entity.id);
  }

  if (added.length === 0 && derived.length === 0) return identity;
  return Object.freeze({
    expanded: Object.freeze([...queryEntities, ...added, ...derived]),
    added: Object.freeze(added),
    derived: Object.freeze(derived),
    sourceIds: Object.freeze(sourceIds.toSorted()),
  });
}
