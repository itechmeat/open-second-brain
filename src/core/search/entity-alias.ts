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
 * the vault - never a shipped word list).
 *
 * A form that reaches more than one person ONLY through derivation is
 * reported, never guessed: neither person participates through it and
 * the ambiguity rides the expansion result (`derivedAmbiguities`, under
 * {@link DERIVED_PERSON_AMBIGUITY_CODE}) instead of silently adding
 * several people's names to the query. The retrieval-trail wiring for
 * that code lives with the pipeline's other degradations.
 */

import { normalizeEntityName } from "../brain/entities/canonical.ts";
import {
  isPersonCategory,
  personNameComparisonForm,
  derivePersonNameVariants,
} from "../brain/entities/person-variants.ts";
import { resolvePersonDerivedIndex, type PersonDerivedIndex } from "../brain/entities/registry.ts";
import type { BrainEntity } from "../brain/entities/types.ts";

// The nickname reader lives on the brain side (`person-nicknames.ts`),
// beside the kernel it feeds: the registry's derived lookup lane and the
// doctor's collision scan consume it from there, and the brain must not
// import from `src/core/search/`. The re-export keeps this module's
// public surface byte-identical to C2.
export {
  PERSON_NICKNAMES_ARTIFACT_REL,
  PersonNicknameConfigError,
  resolvePersonNicknameMap,
} from "../brain/entities/person-nicknames.ts";

/**
 * The degradation code naming a person form that reaches more than one
 * person only through derivation. The expansion result carries the form
 * and the ids under this code; a form two people DECLARED is the
 * doctor's alias-merge candidate instead, and a uniquely-derived form
 * resolves without a word.
 */
export const DERIVED_PERSON_AMBIGUITY_CODE = "person-derived-ambiguity";

/** One derived-only ambiguity: the query form and every person it reaches. */
export interface DerivedPersonAmbiguity {
  readonly form: string;
  readonly ids: ReadonlyArray<string>;
}

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
  /**
   * Query forms that reach more than one person only through
   * derivation. Nothing is expanded for them - the design reports
   * derived ambiguity rather than guessing one person - and each entry
   * names the form and every person id it reaches, so the pipeline can
   * surface the fact under {@link DERIVED_PERSON_AMBIGUITY_CODE}.
   */
  readonly derivedAmbiguities: ReadonlyArray<DerivedPersonAmbiguity>;
}

/**
 * Expand query entities with canonical names and aliases from the
 * registry. A registry entity participates when ANY of its forms
 * (name or alias) appears among the query entities - or, for a
 * person-category entity, when any DERIVED person variant of its forms
 * does - and the entity's other forms (declared and derived) are then
 * added. Query forms are compared through their comparison forms too
 * (the dotted-initial and "Last, First" spellings), exactly as the
 * registry's derived lookup lane compares them.
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
    derivedAmbiguities: Object.freeze([] as DerivedPersonAmbiguity[]),
  });
  if (queryEntities.length === 0) return identity;

  let derivedIndex: PersonDerivedIndex;
  try {
    derivedIndex = resolvePersonDerivedIndex(vault);
  } catch {
    return identity; // fail-soft: search never breaks on a bad registry
  }
  const index = derivedIndex.entityIndex;
  if (index.entities.length === 0) return identity;

  // Every form the query is answered through: each query entity's
  // normalized form plus its comparison form, so "A. Lovelace" and
  // "Lovelace, Ada" meet the same claimants "a lovelace" does. The raw
  // normalized forms stay a separate set: they are what the attribution
  // skips below test against, because the comparison forms are lookup
  // aids, not query content - a canonical form reached only through the
  // query's punctuation still has to join `added` for chunks naming it
  // to match.
  const rawQueryForms = new Set<string>();
  const queryForms = new Set<string>();
  for (const entity of queryEntities) {
    const normalized = normalizeEntityName(entity);
    if (!normalized) continue;
    rawQueryForms.add(normalized);
    queryForms.add(normalized);
    const comparison = personNameComparisonForm(normalized);
    if (comparison) queryForms.add(comparison);
  }

  // Participation per form. A form reaching more than one person ONLY
  // through derivation expands nothing and is reported instead; a form
  // anyone declared answers through the declared lane, and the derived
  // claimants beside it keep today's behaviour (the doctor nominates
  // that declared-vs-derived pair as an alias-merge candidate).
  const derivedAmbiguities: DerivedPersonAmbiguity[] = [];
  const participants = new Map<string, BrainEntity>();
  for (const form of queryForms) {
    const claimants = derivedIndex.byForm.get(form);
    if (claimants === undefined) continue;
    if (claimants.declared.length === 0 && claimants.derived.length > 1) {
      derivedAmbiguities.push({ form, ids: claimants.derived.map((e) => e.id) });
      continue;
    }
    for (const entity of [...claimants.declared, ...claimants.derived]) {
      participants.set(entity.id, entity);
    }
  }

  const added: string[] = [];
  const addedSet = new Set<string>();
  const derived: string[] = [];
  const derivedSet = new Set<string>();
  const sourceIds: string[] = [];

  // Id order, like the registry walk the participants came from, so the
  // expansion is independent of the query's own form order.
  const ordered = [...participants.values()].toSorted((a, b) => a.id.localeCompare(b.id));
  for (const entity of ordered) {
    const forms = [entity.name, ...entity.aliases].map((f) => normalizeEntityName(f));
    let contributed = false;
    for (const form of forms) {
      if (form.length < 2 || rawQueryForms.has(form) || addedSet.has(form)) continue;
      addedSet.add(form);
      added.push(form);
      contributed = true;
    }
    if (isPersonCategory(entity.category)) {
      for (const form of forms) {
        for (const variant of derivePersonNameVariants(form, derivedIndex.nicknames)) {
          // A derived form another entity (or this one) already DECLARED
          // is tracked as declared: declared attribution wins.
          if (rawQueryForms.has(variant) || addedSet.has(variant) || derivedSet.has(variant)) {
            continue;
          }
          derivedSet.add(variant);
          derived.push(variant);
          contributed = true;
        }
      }
    }
    if (contributed) sourceIds.push(entity.id);
  }

  // Declared attribution wins in BOTH visit orders: a form some entity
  // declared is subtracted from the derived lane even when the derivation
  // reached it first, so the two lanes stay disjoint and a form is never
  // counted - or boosted - twice.
  const derivedOnly = derived.filter((v) => !addedSet.has(v));

  if (added.length === 0 && derivedOnly.length === 0 && derivedAmbiguities.length === 0) {
    return identity;
  }
  return Object.freeze({
    expanded: Object.freeze([...queryEntities, ...added, ...derivedOnly]),
    added: Object.freeze(added),
    derived: Object.freeze(derivedOnly),
    sourceIds: Object.freeze(sourceIds.toSorted()),
    derivedAmbiguities: Object.freeze(derivedAmbiguities),
  });
}
