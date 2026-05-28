/**
 * Relation vocabulary - the single validation boundary for typed graph
 * semantics (design: docs/brainstorm/typed-graph-semantics/design.md).
 *
 * Every edge producer (the indexer reading frontmatter relation fields,
 * the MCP-config extractor) and every consumer (search surfacing, the
 * Brain-layer backlink index) reads relation names from here. No
 * relation string is hardcoded across call sites, and classification
 * happens at this one boundary.
 *
 * The vocabulary is data-driven and open: a default set lives here and
 * unknown relations are preserved by callers (and flagged by
 * `brain_doctor`), never silently dropped or hard-rejected at ingest.
 * Identifiers are language-neutral tokens, never human-facing prose, so
 * nothing here hardcodes a natural-language phrase.
 */

/**
 * The default semantic relation types. A frontmatter relation field
 * name is identical to the relation it produces (`contradicts:` →
 * `contradicts`), so this set doubles as the recognised frontmatter
 * relation-field set.
 */
export const DEFAULT_RELATION_TYPES = Object.freeze([
  "related",
  "extends",
  "contradicts",
  "superseded_by",
] as const);

export type DefaultRelationType = (typeof DEFAULT_RELATION_TYPES)[number];

const KNOWN = new Set<string>(DEFAULT_RELATION_TYPES);

/** NFC-normalise, trim, and lower-case a relation token for comparison. */
export function normalizeRelation(raw: string): string {
  return raw.normalize("NFC").trim().toLowerCase();
}

/** True when `rel` (after normalisation) is part of the known vocabulary. */
export function isKnownRelation(rel: string): boolean {
  return KNOWN.has(normalizeRelation(rel));
}

/**
 * Map a frontmatter field name to the relation it declares, or `null`
 * when the field is not a relation field. The field name and the
 * relation token are the same string; this helper is the one place that
 * asserts that mapping so call sites don't re-derive it.
 */
export function relationFromFrontmatterField(field: string): string | null {
  const norm = normalizeRelation(field);
  return KNOWN.has(norm) ? norm : null;
}
