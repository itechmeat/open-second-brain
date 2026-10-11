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
 *   - `pinned`  -> `documents.pinned` (v13), 1/0;
 *   - `visibility` -> `documents.visibility` (v12), the JSON array of
 *                  normalized tokens.
 *
 * `tags` does NOT push (recall-quality review). The only tag rows the
 * index holds are the inline #hashtags: the indexer extracts links from
 * the CHUNK BODIES and frontmatter is stripped before chunking, so
 * `links.link_type = 'tag'` never sees a frontmatter tag - while the live
 * filter reads frontmatter `tags`. A tags EXISTS therefore answered a
 * corpus the live filter never reads and produced false negatives for
 * every frontmatter-tagged note. Making it faithful would need new
 * storage for frontmatter tags; until that exists the key is DEMOTED to
 * the post-rank live filter, which is the arbiter.
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
 * The narrowing's exclusion arm carries one further bound, the freshness
 * gate (answer-trust repair, M1): the stored rows are a snapshot taken at
 * index time, so an exclusion is only provable while the live file still
 * matches the snapshot it was taken from. The gate lives at the store
 * facade ({@link withoutAttributeNarrowing} names the probe half): a
 * candidate the fragment would exclude is kept anyway when its live stat
 * fingerprint no longer matches the indexed one, and the live post-rank
 * filter - which reads the file and owns the "judged live" contract - gets
 * the final word. This module stays pure SQL: the fragment never touches
 * the filesystem.
 *
 * A promoted key is pushed only when the push is FAITHFUL to the live
 * filter's verdict for every value the caller asked for; anything else
 * falls back rather than silently diverging:
 *
 *   - `pinned` is pushed only for the accepted set {"true"}. The column
 *     folds "absent" and "not pinned" into 0, and `parsePinned` refuses
 *     exotic spellings to false, so a filter for "false" (or "yes", or a
 *     number) must judge the live frontmatter; the pushed clause reads
 *     `(pinned = 1 OR pinned IS NULL)` because an in-place upgrade leaves
 *     every carried-over row unmeasured (the v13 lazy story never
 *     backfilled it) - those rows are admitted as candidates and the
 *     post-rank promoted-NULL gate judges each by the live pinned filter,
 *     per row, never from SQL (`pipeline/pool-filters.ts`);
 *   - `type` and `visibility` values are pushed normalized; a value that
 *     normalizes to the empty token is unpushable (the stored column is
 *     never the empty string, while the live filter could still match an
 *     empty frontmatter scalar), and the whole key falls back;
 *   - `type` is CONDITIONALLY faithful over value shapes (recall-quality
 *     review): `documents.page_type` is written only for scalar-string
 *     frontmatter, so the pushed clause reads
 *     `page_type IN (...) OR page_type IS NULL`. The IN arm answers the
 *     scalar shapes as-indexed; the NULL arm keeps every row whose shape
 *     the column cannot speak for - an array `type` most notably, which
 *     the live filter matches element-wise - as a candidate, and the
 *     post-rank promoted-NULL gate arbitrates exactly those rows under
 *     the live filter (`pipeline/pool-filters.ts`), per row by the
 *     STORED column: a NULL page_type is judged live whatever the query
 *     and whatever the live shape (the arm that admitted the row proves
 *     nothing - a stale-NULL row whose file meanwhile says a speakable
 *     scalar must not inherit a SQL verdict it never received), while a
 *     non-NULL page_type keeps its SQL verdict;
 *   - a key with no accepted values matches nothing under the live
 *     filter's semantics, which is the post-rank path's exact behaviour.
 */

import type { Database } from "bun:sqlite";

import { normalizeSchemaToken } from "../brain/schema-vocab.ts";
import { DOCUMENT_ATTRIBUTES_TABLE, PROMOTED_ATTRIBUTE_KEYS } from "./schema.ts";
import { SearchError } from "./search-error.ts";

/** The chunk kinds a `kind` filter may name, and the only valid values. */
export const SEARCH_KINDS = ["page", "section"] as const;

/**
 * One unpromoted property filter compiled to the attribute-narrowing read:
 * the exact `key → values[]` shape the live filter judges, with the key in
 * the NFC spelling the indexer stores.
 */
export interface AttributeNarrowing {
  readonly key: string;
  readonly values: ReadonlyArray<string>;
}

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
  /** `(d.pinned = 1 OR d.pinned IS NULL)`, pushed only for {"true"}. */
  readonly pinned?: boolean;
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
    }
    // `tags` deliberately has no push branch: the only stored tag corpus is
    // the inline-hashtag links, the live filter reads frontmatter tags, and
    // the key is demoted to the post-rank half (see the module header).
    if (!pushed) fallback.set(key, accepted);
  }
  // The unpromoted half also narrows the candidate pool against the v14
  // attributes side table (`attributeNarrowingFragment` for the
  // arbitration shape): SQL may exclude only a provable mismatch, and the
  // keys stay in `fallback` above, so the live post-rank filter still
  // judges every surfaced row.
  const narrowing = attributeNarrowingEntries(properties);
  const promoted =
    acc.pageTypes !== undefined || acc.pinned === true || acc.visibilityTokens !== undefined;
  return {
    pushdown:
      promoted || narrowing !== null
        ? Object.freeze({
            ...(promoted
              ? {
                  ...(acc.pageTypes !== undefined ? { pageTypes: acc.pageTypes } : {}),
                  ...(acc.pinned === true ? { pinned: true } : {}),
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
 * The narrowing WHERE fragment for one {@link AttributeNarrowing} list,
 * AND-joined across keys, written against the `d` alias of the documents
 * table every pushdown consumer already joins.
 *
 * This is a CANDIDATE-NARROWING predicate, never a faithful row drop, and
 * the shape says so: a document is excluded only when the table holds rows
 * for the key AND none of them is accepted. The `NOT EXISTS` arm keeps a
 * document the table is silent about, because silence has two honest
 * causes: the document never declared the key, or the extractor silenced
 * the WHOLE key because one of its values passed a bound (64 keys per
 * document, 16 values per key, 256 bytes per value -
 * `documentAttributesFromFrontmatter` stores no rows for a partly stored
 * key, recall-quality review H2) - silence is not a verdict. The live
 * post-rank filter stays the arbiter over the narrowed pool: nothing here
 * may decide the answer alone, it only shrinks what gets hydrated and
 * reranked.
 *
 * Values are matched verbatim in the stored scalar `String(value)` form
 * (`documentAttributesFromFrontmatter` stores numbers and booleans exactly
 * as the live filter stringifies them), so a stored row answers only what
 * the live filter would have answered for the same row. The exclusion arm
 * is further bounded by the store-level freshness gate - see
 * {@link withoutAttributeNarrowing} - which keeps every candidate whose
 * indexed snapshot may be stale. Null when there is nothing to narrow
 * with.
 */
export function attributeNarrowingFragment(
  entries: ReadonlyArray<AttributeNarrowing>,
): { sql: string; bindings: string[] } | null {
  const usable = entries.filter((e) => e.values.length > 0);
  if (usable.length === 0) return null;
  const clauses: string[] = [];
  const bindings: string[] = [];
  for (const [i, entry] of usable.entries()) {
    clauses.push(
      `(EXISTS (SELECT 1 FROM ${DOCUMENT_ATTRIBUTES_TABLE} an${i} ` +
        `WHERE an${i}.document_id = d.id AND an${i}.key = ? ` +
        `AND an${i}.value IN (${placeholders(entry.values.length)})) ` +
        `OR NOT EXISTS (SELECT 1 FROM ${DOCUMENT_ATTRIBUTES_TABLE} anx${i} ` +
        `WHERE anx${i}.document_id = d.id AND anx${i}.key = ?))`,
    );
    bindings.push(entry.key, ...entry.values, entry.key);
  }
  return { sql: clauses.join(" AND "), bindings };
}

/**
 * The freshness gate's probe half (answer-trust repair, M1): the pushdown
 * with its attribute narrowing stripped, or null when nothing is left.
 *
 * The narrowing fragment excludes on the attribute SNAPSHOT, and a
 * snapshot can silently lag its file - a document indexed `status: draft`
 * and edited to `status: done` must not vanish from a `status=done` query
 * when the contract says "narrow on the attribute snapshot, judged live"
 * (`brain_search`'s own `properties` schema). So the store facade re-runs
 * the lane read through this probe (the promoted predicates unchanged, the
 * narrowing lifted, the same window) and treats the difference as the set
 * of candidates the narrowing would exclude; each of those gets one
 * liveness check against the indexed stat fingerprint (the Store's
 * freshness gate in `src/core/search/store.ts`), and the stale ones fall
 * through to the live post-rank filter as candidates. A candidate whose
 * fingerprint still matches is proven fresh, its SQL exclusion stands, and
 * the path is byte-identical to the ungated read - the gate never reads
 * file contents, and neither does this half.
 */
export function withoutAttributeNarrowing(pushdown: PropertyPushdown): PropertyPushdown | null {
  const promoted: PropertyPushdown = {
    ...(pushdown.pageTypes !== undefined ? { pageTypes: pushdown.pageTypes } : {}),
    ...(pushdown.pinned === true ? { pinned: true } : {}),
    ...(pushdown.visibilityTokens !== undefined
      ? { visibilityTokens: pushdown.visibilityTokens }
      : {}),
  };
  const hasPromoted =
    promoted.pageTypes !== undefined ||
    promoted.pinned === true ||
    promoted.visibilityTokens !== undefined;
  return hasPromoted ? Object.freeze(promoted) : null;
}

/**
 * The documents the narrowing would exclude: for any entry, the documents
 * carrying at least one stored row for its key and none of the accepted
 * values. The complement of the fragment's keep set, so tests (and any
 * set-based consumer) can pin the same arbitration semantics without
 * parsing SQL: a document with no rows for the key is never excluded here,
 * which is exactly the `NOT EXISTS` arm above.
 */
export function documentIdsExcludedByAttributeNarrowing(
  db: Database,
  entries: ReadonlyArray<AttributeNarrowing>,
): Set<number> {
  const out = new Set<number>();
  for (const entry of entries) {
    if (entry.values.length === 0) continue;
    const rows = db
      .query<{ document_id: number }, [string, ...string[]]>(
        `SELECT DISTINCT fe.document_id AS document_id FROM ${DOCUMENT_ATTRIBUTES_TABLE} fe ` +
          `WHERE fe.key = ? AND NOT EXISTS (SELECT 1 FROM ${DOCUMENT_ATTRIBUTES_TABLE} fm ` +
          `WHERE fm.document_id = fe.document_id AND fm.key = ? ` +
          `AND fm.value IN (${placeholders(entry.values.length)}))`,
      )
      .all(entry.key, entry.key, ...entry.values);
    for (const row of rows) out.add(row.document_id);
  }
  return out;
}

/**
 * Compile a pushdown to the WHERE fragment (AND-joined, no leading AND)
 * and its bindings, or null when nothing is pushed. Every predicate is
 * written against the `d` alias of the documents table.
 */
export function pushdownSqlFragment(
  pushdown: PropertyPushdown | null | undefined,
): { sql: string; bindings: string[] } | null {
  if (!pushdown) return null;
  const clauses: string[] = [];
  const bindings: string[] = [];
  if (pushdown.pageTypes !== undefined) {
    // Conditionally faithful (see the module header): the IN arm answers
    // the scalar-string shapes the column stores; the NULL arm keeps every
    // row whose `type` shape the column cannot speak for - the post-rank
    // promoted-NULL gate arbitrates those under the live filter.
    clauses.push(
      `(d.page_type IN (${placeholders(pushdown.pageTypes.length)}) OR d.page_type IS NULL)`,
    );
    bindings.push(...pushdown.pageTypes);
  }
  if (pushdown.pinned === true) {
    // The v13 column is NULL on every row an in-place upgrade carried over
    // (the lazy story never backfilled it), so the bare equality answered
    // an upgraded index with zero results where the live filter matched.
    // The NULL arm admits those rows as candidates; the post-rank
    // promoted-NULL gate judges each of them by the live pinned filter,
    // never from SQL (pool-filters.ts).
    clauses.push("(d.pinned = 1 OR d.pinned IS NULL)");
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
    // post-rank fallback, so this never decides a row on its own. The
    // snapshot the rows hold can also lag the file it was taken from; the
    // store's freshness gate ({@link withoutAttributeNarrowing}) re-runs
    // the lane read without this fragment and falls stale candidates
    // through to the live filter instead of letting the SQL exclusion
    // stand. This module stays pure SQL - no filesystem access here.
    const narrowing = attributeNarrowingFragment(pushdown.attributeNarrowing);
    if (narrowing !== null) {
      clauses.push(narrowing.sql);
      bindings.push(...narrowing.bindings);
    }
  }
  if (clauses.length === 0) return null;
  return { sql: clauses.join(" AND "), bindings };
}
