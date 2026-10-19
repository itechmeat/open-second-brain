/**
 * Entity-contamination check (t_e9692750): a synthesized conclusion
 * that mentions a registered entity absent from every cited source is
 * asserting provenance it does not have. The check is a pure
 * inclusion test over the canonical entity registry - same
 * normalization kernel as fact-extraction's anchors - so "Bob said
 * so" only survives synthesis when some cited source actually
 * mentions Bob.
 */

import {
  MIN_ANCHOR_FORM_LENGTH,
  matchFormVariants,
  matchVariantsOccurIn,
  normalizeEntityName,
} from "../entities/canonical.ts";
import { ENTITY_STATUS_SCOPE, entityStatusInScope } from "../entities/status-scope.ts";

/**
 * Frontmatter marker key stamped on a page whose synthesized conclusion
 * failed the entity-contamination check (asserted provenance for an
 * entity absent from every cited source). This module owns the name so
 * contamination stays a single boundary: the detector here and any
 * read-time trust consumer (the retrieval trust gate) agree on the one
 * structural key rather than each hardcoding it. Structural, not lexical.
 */
export const ENTITY_CONTAMINATION_FRONTMATTER_KEY = "entity_contamination";

/**
 * True when a raw frontmatter map carries a truthy entity-contamination
 * marker (boolean `true` or the string `"true"`). A missing or falsey
 * value is clean. Reads only the one structural key - never note prose.
 */
export function hasEntityContaminationMarker(meta: Readonly<Record<string, unknown>>): boolean {
  const value = meta[ENTITY_CONTAMINATION_FRONTMATTER_KEY];
  return value === true || value === "true";
}

/** The slice of a registry entity the check needs. */
export interface ContaminationEntityLike {
  readonly id: string;
  readonly name: string;
  readonly aliases: ReadonlyArray<string>;
  readonly status: string;
}

export interface ContaminationViolation {
  readonly entityId: string;
  readonly name: string;
}

export interface ContaminationResult {
  readonly clean: boolean;
  readonly violations: ReadonlyArray<ContaminationViolation>;
}

export interface ContaminationInput {
  readonly conclusion: string;
  readonly sources: ReadonlyArray<string>;
  readonly entities: ReadonlyArray<ContaminationEntityLike>;
}

/**
 * One entity's inclusion-test inputs, precomputed: every normalized form,
 * each already expanded into its match variants, so an entity is
 * tokenized ONCE per check no matter how many texts it is tested against.
 * The length floor is not applied here - `mentions` gates each form at
 * every use, so a short form costs one variant expansion and answers no.
 */
interface PreparedEntity {
  readonly entity: ContaminationEntityLike;
  readonly forms: ReadonlyArray<readonly [string, ReadonlyArray<string>]>;
}

function prepareEntity(entity: ContaminationEntityLike): PreparedEntity {
  const forms = [entity.name, ...entity.aliases].map((f) => {
    const normalized = normalizeEntityName(f);
    return [normalized, matchFormVariants(normalized)] as const;
  });
  return { entity, forms };
}

/**
 * The inclusion test behind the check - the twins' copy of
 * fact-extraction's anchoring rule, kept verbatim through the one
 * canonical match-form rule ({@link matchVariantsOccurIn}) since F3
 * (note-change truth maintenance): both sides fold to their canonical
 * (space) joins, a folder-prefixed form matching at the path-segment
 * boundary, and every occurrence leading-edge-checked (a no-space-script
 * neighbour suspends the requirement), so the fold never plants a
 * mid-word hit nothing anchored before. Takes the entity ALREADY
 * prepared through {@link prepareEntity} and a haystack ALREADY expanded
 * through {@link matchFormVariants} - each side tokenizes once, the
 * same hoist `entityAnchors` makes, not once per entity per source.
 */
function mentions(haystackVariants: ReadonlyArray<string>, prepared: PreparedEntity): boolean {
  return prepared.forms.some(
    ([form, variants]) =>
      form.length >= MIN_ANCHOR_FORM_LENGTH && matchVariantsOccurIn(variants, haystackVariants),
  );
}

/**
 * Every active registered entity mentioned in the conclusion must be
 * mentioned by at least one source. An empty registry or an empty
 * conclusion is trivially clean.
 */
export function checkEntityContamination(input: ContaminationInput): ContaminationResult {
  if (input.entities.length === 0 || input.conclusion.trim() === "") {
    return Object.freeze({ clean: true, violations: Object.freeze([]) });
  }
  // Each text expands through its match variants exactly once, up
  // front, and each entity's forms are prepared exactly once: identical
  // verdicts, the grid of entities x texts never re-tokenizes either
  // side.
  const conclusionVariants = matchFormVariants(normalizeEntityName(input.conclusion));
  const sourceVariants = input.sources.map((s) => matchFormVariants(normalizeEntityName(s)));
  const prepared = input.entities.map(prepareEntity);

  const violations: ContaminationViolation[] = [];
  for (const p of prepared) {
    if (!entityStatusInScope(p.entity.status, ENTITY_STATUS_SCOPE.canonical)) continue;
    if (!mentions(conclusionVariants, p)) continue;
    const cited = sourceVariants.some((variants) => mentions(variants, p));
    if (!cited) violations.push(Object.freeze({ entityId: p.entity.id, name: p.entity.name }));
  }
  violations.sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
  return Object.freeze({
    clean: violations.length === 0,
    violations: Object.freeze(violations),
  });
}
