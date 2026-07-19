/**
 * Entity-contamination check (t_e9692750): a synthesized conclusion
 * that mentions a registered entity absent from every cited source is
 * asserting provenance it does not have. The check is a pure
 * inclusion test over the canonical entity registry - same
 * normalization kernel as fact-extraction's anchors - so "Bob said
 * so" only survives synthesis when some cited source actually
 * mentions Bob.
 */

import { normalizeEntityName } from "../entities/canonical.ts";

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

function mentions(haystack: string, entity: ContaminationEntityLike): boolean {
  const forms = [entity.name, ...entity.aliases].map((f) => normalizeEntityName(f));
  return forms.some((f) => f.length >= 3 && haystack.includes(f));
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
  const conclusion = normalizeEntityName(input.conclusion);
  const sources = input.sources.map((s) => normalizeEntityName(s));

  const violations: ContaminationViolation[] = [];
  for (const entity of input.entities) {
    if (entity.status !== "active") continue;
    if (!mentions(conclusion, entity)) continue;
    const cited = sources.some((source) => mentions(source, entity));
    if (!cited) violations.push(Object.freeze({ entityId: entity.id, name: entity.name }));
  }
  violations.sort((a, b) => (a.entityId < b.entityId ? -1 : a.entityId > b.entityId ? 1 : 0));
  return Object.freeze({
    clean: violations.length === 0,
    violations: Object.freeze(violations),
  });
}
