/**
 * Property-filter pushdown (recall-quality, C4): which entries of a caller's
 * `properties` filter map can be answered by the index, and the SQL they
 * compile to.
 *
 * Two tiers of storage back the promoted keys, each already materialized by
 * earlier migrations:
 *
 *   - `type`    -> `documents.page_type` (v6), stored as the normalized
 *                  token (`normalizeSchemaToken`: NFC + trim + lower);
 *   - `tags`    -> the tag links (`links.link_type = 'tag'`, the inline tag
 *                  corpus the index holds);
 *   - `pinned`  -> `documents.pinned` (v13), 1/0;
 *   - `visibility` -> `documents.visibility` (v12), the JSON array of
 *                  normalized tokens.
 *
 * Pushed keys answer AS INDEXED, in their stored canonical form - the same
 * relationship to the live file that every other indexed facet (the content
 * itself, the materialized bounds) has. Unpromoted keys keep the post-rank
 * live-file filter, so a mixed map deliberately straddles the two tiers.
 *
 * The unpromoted keys get a third treatment on top of their post-rank
 * filter (recall-quality, the attribute-narrowing wave): the v14
 * `document_attributes` side table lets them NARROW the candidate pool in
 * SQL. A narrowing never decides the answer - the bounded table can
 * silently lack rows for over-bound documents, so a document the table
 * cannot speak for is kept and the live post-rank filter stays the
 * arbiter; the narrowing only shrinks what gets hydrated and reranked.
 * The promoted keys never narrow: the side table deliberately skips them,
 * so there are no rows to read.
 *
 * A promoted key is pushed only when the push is FAITHFUL to the live
 * filter's verdict for every value the caller asked for; anything else
 * falls back rather than silently diverging:
 *
 *   - `pinned` is pushed only for the accepted set {"true"}. The column
 *     folds "absent" and "not pinned" into 0, and `parsePinned` refuses
 *     exotic spellings to false, so a filter for "false" (or "yes", or a
 *     number) must judge the live frontmatter;
 *   - `type` and `visibility` values are pushed normalized; a value that
 *     normalizes to the empty token is unpushable (the stored column is
 *     never the empty string, while the live filter could still match an
 *     empty frontmatter scalar), and the whole key falls back;
 *   - a key with no accepted values matches nothing under the live
 *     filter's semantics, which is the post-rank path's exact behaviour.
 */

import { normalizeSchemaToken } from "../brain/schema-vocab.ts";
import { PROMOTED_ATTRIBUTE_KEYS } from "./schema.ts";
import { attributeNarrowingFragment, type AttributeNarrowing } from "./store/documents.ts";
import { SearchError } from "./search-error.ts";

/** The chunk kinds a `kind` filter may name, and the only valid values. */
export const SEARCH_KINDS = ["page", "section"] as const;

export type SearchKind = (typeof SEARCH_KINDS)[number];

export function isSearchKind(value: unknown): value is SearchKind {
  return value === "page" || value === "section";
}

/** The `kind` option of a search, validated at the request boundary. */
export function resolveKindFilter(raw: unknown): SearchKind | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isSearchKind(raw)) {
    throw new SearchError(
      "INVALID_INPUT",
      `kind must be one of ${SEARCH_KINDS.join(", ")}; got ${JSON.stringify(raw)}`,
    );
  }
  return raw;
}

/**
 * The promoted property keys and the SQL predicates they compile to. The
 * v14 attributes side table deliberately does NOT carry these keys (the
 * promoted set is skipped at extraction), so each predicate reads its key's
 * dedicated storage.
 */
export interface PropertyPushdown {
  /** `documents.page_type` membership, normalized tokens. */
  readonly pageTypes?: ReadonlyArray<string>;
  /** `documents.pinned = 1`, pushed only for the accepted set {"true"}. */
  readonly pinned?: boolean;
  /** The tag-link EXISTS, values matched exactly as the index stored them. */
  readonly tags?: ReadonlyArray<string>;
  /** `json_each(documents.visibility)` membership, normalized tokens. */
  readonly visibilityTokens?: ReadonlyArray<string>;
  /**
   * The unpromoted keys' candidate-narrowing predicates against
   * `document_attributes` (see {@link attributeNarrowingFragment}). These
   * keys ALSO stay in the post-rank fallback half: the narrowing only
   * shrinks the pool, the live filter still decides every row.
   */
  readonly attributeNarrowing?: ReadonlyArray<AttributeNarrowing>;
}

/** The result of splitting a caller's property filter map. */
export interface PropertyFilterSplit {
  /** The promoted half, already compiled to storage predicates; null if none. */
  readonly pushdown: PropertyPushdown | null;
  /**
   * The promoted half AS THE CALLER WROTE IT (raw keys and values, the
   * live-filter shape), or null when nothing was promoted. The post-rank
   * gate re-judges the candidate sources the lanes' SQL never saw -
   * traversal-arm rows - with the same live predicate the fallback half
   * runs, so a promoted filter constrains every result regardless of where
   * the candidate entered the pool.
   */
  readonly promoted: PropertyFilterMap | null;
  /**
   * The remaining keys for the post-rank live-file filter; null when
   * nothing is left (the pool then needs no filter overfetch for
   * properties).
   */
  readonly fallback: PropertyFilterMap | null;
}

export type PropertyFilterMap = ReadonlyMap<string, ReadonlyArray<string>>;

function pushableNormalized(values: ReadonlyArray<string>): ReadonlyArray<string> | null {
  if (values.length === 0) return null;
  const normalized = values.map((v) => normalizeSchemaToken(v));
  if (normalized.some((t) => t.length === 0)) return null;
  return normalized;
}

/**
 * The unpromoted keys of a property filter map, as the attribute-narrowing
 * read consumes them: keys in the NFC spelling the indexer stores, values
 * verbatim (the stored scalar form is the exact string the live filter
 * compares). Promoted keys never narrow - the side table skips them at
 * extraction, so there is nothing there to read - and a key with no
 * accepted values narrows nothing (the post-rank half answers its
 * match-nothing semantics faithfully). Null when no key qualifies.
 *
 * Shared with the query-cache key builder so the cache and the lanes read
 * one definition of "narrowing-eligible".
 */
export function attributeNarrowingEntries(
  properties: PropertyFilterMap | undefined,
): ReadonlyArray<AttributeNarrowing> | null {
  if (!properties || properties.size === 0) return null;
  const out: AttributeNarrowing[] = [];
  for (const [key, values] of properties) {
    if (PROMOTED_ATTRIBUTE_KEYS.has(key)) continue;
    if (values.length === 0) continue;
    out.push(Object.freeze({ key: key.normalize("NFC"), values: Object.freeze([...values]) }));
  }
  return out.length > 0 ? Object.freeze(out) : null;
}

/**
 * Split a property filter map into its pushable (promoted, as-indexed) and
 * post-rank (live-file) halves. Absent/empty maps split to null/null: no
 * predicate is pushed and no post-rank filter runs, byte-identical to a
 * pre-pushdown query.
 */
export function resolvePropertyPushdown(
  properties: PropertyFilterMap | undefined,
): PropertyFilterSplit {
  if (!properties || properties.size === 0) {
    return { pushdown: null, promoted: null, fallback: null };
  }
  const acc: {
    pageTypes?: ReadonlyArray<string>;
    pinned?: boolean;
    tags?: ReadonlyArray<string>;
    visibilityTokens?: ReadonlyArray<string>;
  } = {};
  const promotedMap = new Map<string, string[]>();
  const fallback = new Map<string, string[]>();
  for (const [key, values] of properties) {
    const accepted = [...values];
    let pushed = false;
    if (key === "type") {
      const normalized = pushableNormalized(accepted);
      if (normalized !== null) {
        acc.pageTypes = normalized;
        promotedMap.set(key, accepted);
        pushed = true;
      }
    } else if (key === "visibility") {
      const normalized = pushableNormalized(accepted);
      if (normalized !== null) {
        acc.visibilityTokens = normalized;
        promotedMap.set(key, accepted);
        pushed = true;
      }
    } else if (key === "pinned") {
      // Faithful only when every accepted spelling is the unambiguous
      // "true": the column cannot separate false from absent, and the
      // parser folds exotic spellings to false on the live side too.
      if (accepted.length > 0 && accepted.every((v) => v === "true")) {
        acc.pinned = true;
        promotedMap.set(key, accepted);
        pushed = true;
      }
    } else if (key === "tags") {
      // Exact match against the stored tag text; an empty accepted list
      // matches nothing, which the post-rank path answers faithfully.
      if (accepted.length > 0) {
        acc.tags = accepted;
        promotedMap.set(key, accepted);
        pushed = true;
      }
    }
    if (!pushed) fallback.set(key, accepted);
  }
  // The unpromoted half also narrows the candidate pool against the v14
  // attributes side table (`attributeNarrowingFragment` for the
  // arbitration shape): SQL may exclude only a provable mismatch, and the
  // keys stay in `fallback` above, so the live post-rank filter still
  // judges every surfaced row.
  const narrowing = attributeNarrowingEntries(properties);
  const promoted =
    acc.pageTypes !== undefined ||
    acc.pinned === true ||
    acc.tags !== undefined ||
    acc.visibilityTokens !== undefined;
  return {
    pushdown:
      promoted || narrowing !== null
        ? Object.freeze({
            ...(promoted
              ? {
                  ...(acc.pageTypes !== undefined ? { pageTypes: acc.pageTypes } : {}),
                  ...(acc.pinned === true ? { pinned: true } : {}),
                  ...(acc.tags !== undefined ? { tags: acc.tags } : {}),
                  ...(acc.visibilityTokens !== undefined
                    ? { visibilityTokens: acc.visibilityTokens }
                    : {}),
                }
              : {}),
            ...(narrowing !== null ? { attributeNarrowing: narrowing } : {}),
          })
        : null,
    promoted: promotedMap.size > 0 ? promotedMap : null,
    fallback: fallback.size > 0 ? fallback : null,
  };
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}

/**
 * Compile a pushdown to the WHERE fragment (AND-joined, no leading AND)
 * and its bindings, or null when nothing is pushed. Every predicate is
 * written against the `d` alias of the documents table, and the tag EXISTS
 * aliases its own link row (`ptag`) so it cannot collide with a caller of
 * the enclosing query.
 */
export function pushdownSqlFragment(
  pushdown: PropertyPushdown | null | undefined,
): { sql: string; bindings: string[] } | null {
  if (!pushdown) return null;
  const clauses: string[] = [];
  const bindings: string[] = [];
  if (pushdown.pageTypes !== undefined) {
    clauses.push(`d.page_type IN (${placeholders(pushdown.pageTypes.length)})`);
    bindings.push(...pushdown.pageTypes);
  }
  if (pushdown.pinned === true) {
    clauses.push("d.pinned = 1");
  }
  if (pushdown.tags !== undefined) {
    clauses.push(
      `EXISTS (SELECT 1 FROM links ptag WHERE ptag.source_document_id = d.id ` +
        `AND ptag.link_type = 'tag' AND ptag.link_text IN (${placeholders(pushdown.tags.length)}))`,
    );
    bindings.push(...pushdown.tags);
  }
  if (pushdown.visibilityTokens !== undefined) {
    clauses.push(
      `EXISTS (SELECT 1 FROM json_each(d.visibility) pvis ` +
        `WHERE pvis.value IN (${placeholders(pushdown.visibilityTokens.length)}))`,
    );
    bindings.push(...pushdown.visibilityTokens);
  }
  if (pushdown.attributeNarrowing !== undefined) {
    // Candidate narrowing only (recall-quality): the fragment keeps every
    // document the bounded table cannot speak for, and the keys stay in the
    // post-rank fallback, so this never decides a row on its own.
    const narrowing = attributeNarrowingFragment(pushdown.attributeNarrowing);
    if (narrowing !== null) {
      clauses.push(narrowing.sql);
      bindings.push(...narrowing.bindings);
    }
  }
  if (clauses.length === 0) return null;
  return { sql: clauses.join(" AND "), bindings };
}
