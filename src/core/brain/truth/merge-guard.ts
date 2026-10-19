/**
 * Name-aware merge guard (t_e9692750): dedup similarity is content
 * similarity, so without this guard "Alice decided X" and "Bob
 * decided X" look like near-duplicates and a merge would collapse two
 * people's decisions into one. The guard anchors both texts against
 * the canonical entity registry and refuses when the guarded anchor
 * sets are disjoint and non-empty - the one shape that is
 * demonstrably unsafe. Everything else (no anchors, overlapping
 * anchors) merges exactly as today.
 */

import {
  MIN_ANCHOR_FORM_LENGTH,
  matchFormVariants,
  matchVariantsOccurIn,
  normalizeEntityName,
} from "../entities/canonical.ts";
import { ENTITY_STATUS_SCOPE, entityStatusInScope } from "../entities/status-scope.ts";

/** Categories guarded by default: people and organisations. */
export const GUARDED_ENTITY_CATEGORIES: ReadonlyArray<string> = Object.freeze([
  "people",
  "person",
  "org",
  "organization",
  "organisation",
  "company",
  "team",
]);

/** The slice of a registry entity the guard needs. */
export interface GuardEntityLike {
  readonly id: string;
  readonly category: string;
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly status: string;
}

export interface GuardEntityMergeInput {
  readonly keepText: string;
  readonly dropText: string;
  readonly entities: ReadonlyArray<GuardEntityLike>;
  /** Override the guarded category set. */
  readonly categories?: ReadonlyArray<string>;
}

export interface MergeGuardVerdict {
  readonly allowed: boolean;
  /** Explainable refusal reason; null when allowed. */
  readonly reason: string | null;
  readonly keepAnchors: ReadonlyArray<string>;
  readonly dropAnchors: ReadonlyArray<string>;
}

/**
 * Anchor a text against guarded entities: every active entity whose
 * normalized name or alias occurs in the normalized text. The same
 * inclusion rule as fact-extraction's `entityAnchors`, restricted to the
 * guarded categories - shared verbatim since F3 (note-change truth
 * maintenance) through the one canonical match-form rule
 * ({@link matchVariantsOccurIn}): separator-folded on both sides, a
 * slug-prefixed form matching at the path-segment boundary, and every
 * occurrence word-bounded, so the fold never plants a mid-word hit
 * literal matching did not already have. The haystack expands through
 * its match variants ONCE per call - the same hoist `entityAnchors`
 * makes - not once per form per entity.
 */
function guardedAnchors(
  text: string,
  entities: ReadonlyArray<GuardEntityLike>,
  categories: ReadonlySet<string>,
): string[] {
  const haystackVariants = matchFormVariants(normalizeEntityName(text));
  const ids: string[] = [];
  for (const entity of entities) {
    if (!entityStatusInScope(entity.status, ENTITY_STATUS_SCOPE.canonical)) continue;
    if (!categories.has(entity.category.toLowerCase())) continue;
    const forms = [entity.name, ...entity.aliases].map((f) => normalizeEntityName(f));
    if (
      forms.some(
        (f) =>
          f.length >= MIN_ANCHOR_FORM_LENGTH &&
          matchVariantsOccurIn(matchFormVariants(f), haystackVariants),
      )
    )
      ids.push(entity.id);
  }
  return ids.toSorted();
}

/**
 * Decide whether merging two texts is entity-safe. Blocks ONLY when
 * both sides carry guarded anchors and the sets share nothing.
 */
export function guardEntityMerge(input: GuardEntityMergeInput): MergeGuardVerdict {
  const categories = new Set(
    (input.categories ?? GUARDED_ENTITY_CATEGORIES).map((c) => c.toLowerCase()),
  );
  const keepAnchors = guardedAnchors(input.keepText, input.entities, categories);
  const dropAnchors = guardedAnchors(input.dropText, input.entities, categories);

  const disjoint =
    keepAnchors.length > 0 &&
    dropAnchors.length > 0 &&
    !keepAnchors.some((id) => dropAnchors.includes(id));

  if (!disjoint) {
    return Object.freeze({
      allowed: true,
      reason: null,
      keepAnchors: Object.freeze(keepAnchors),
      dropAnchors: Object.freeze(dropAnchors),
    });
  }
  return Object.freeze({
    allowed: false,
    reason:
      `entity merge guard: keep anchors [${keepAnchors.join(", ")}] and ` +
      `drop anchors [${dropAnchors.join(", ")}] are disjoint - merging would ` +
      `collapse claims about different entities`,
    keepAnchors: Object.freeze(keepAnchors),
    dropAnchors: Object.freeze(dropAnchors),
  });
}
