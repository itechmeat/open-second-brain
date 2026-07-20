/**
 * Relational-query parser (t_09b7ccea).
 *
 * Detects a relationship-shaped query STRUCTURALLY and vocabulary-driven,
 * never with a natural-language word list:
 *   - seeds are wikilink targets (`[[X]]`) - a structural signal;
 *   - edge types are query tokens that are a SUBSET of the edge-type
 *     vocabulary supplied by the caller (schema-pack link types plus the
 *     default relation vocabulary). A token outside the vocabulary is not
 *     an edge type and is ignored (subset validation).
 *
 * A query is relationship-shaped only when it names at least one seed AND
 * at least one edge type; anything else returns null and retrieval is
 * unchanged. The parser is pure and deterministic.
 */

import { WIKILINK_TARGET_RE } from "../brain/wikilink.ts";
import { normalizeRelation } from "../graph/relation-vocab.ts";

export interface RelationalQuery {
  /** Wikilink seed targets (bare ids), in first-seen order, deduped. */
  readonly seeds: ReadonlyArray<string>;
  /** Edge types to traverse, a subset of the vocabulary, deduped. */
  readonly edgeTypes: ReadonlyArray<string>;
}

/** Split into comparable tokens; underscores stay (e.g. `depends_on`). */
function tokenize(query: string): string[] {
  return query
    .split(/[^\p{L}\p{N}_]+/u)
    .map((t) => normalizeRelation(t))
    .filter((t) => t.length > 0);
}

function extractSeeds(query: string): string[] {
  const seeds: string[] = [];
  const seen = new Set<string>();
  for (const m of query.matchAll(WIKILINK_TARGET_RE)) {
    const target = m[1]?.trim();
    if (target === undefined || target.length === 0) continue;
    if (seen.has(target)) continue;
    seen.add(target);
    seeds.push(target);
  }
  return seeds;
}

/**
 * Parse a relationship-shaped query, or null when it is not one. The
 * `vocabulary` is the recognised edge-type set (schema-pack link types plus
 * the default relation vocabulary), already normalized by the caller.
 */
export function parseRelationalQuery(
  query: string,
  vocabulary: ReadonlyArray<string>,
): RelationalQuery | null {
  const vocab = new Set(vocabulary.map((v) => normalizeRelation(v)));
  if (vocab.size === 0) return null;

  const seeds = extractSeeds(query);
  if (seeds.length === 0) return null;

  const edgeTypes: string[] = [];
  const seen = new Set<string>();
  for (const token of tokenize(query)) {
    if (!vocab.has(token) || seen.has(token)) continue;
    seen.add(token);
    edgeTypes.push(token);
  }
  if (edgeTypes.length === 0) return null;

  return Object.freeze({
    seeds: Object.freeze(seeds),
    edgeTypes: Object.freeze(edgeTypes),
  });
}
