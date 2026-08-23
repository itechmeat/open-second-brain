/**
 * Whether the index holds ANY evidence that a page declares
 * `visibility:` frontmatter, read without a vault walk
 * (nothing-writes-silently, unit H).
 *
 * The chunker (`chunker.ts`'s `packBlocks`) emits a page's frontmatter
 * block as its own chunk, verbatim, ahead of every other chunk the page
 * produces - so `chunks.content` at `chunk_index = 0` IS the page's raw
 * YAML text when the page has frontmatter at all, and the FIRST real
 * content chunk (never frontmatter) when it does not. That is a
 * structural fact about how the index is built, not a coincidence this
 * module is trusting: it is exercised as `INTRUDER_CHUNK_INDEX_ZERO` in
 * `tests/core/search/visibility-tag-presence.test.ts`.
 *
 * That makes "does any page use `visibility:`" answerable from the
 * ALREADY-BUILT index - no filesystem walk, no per-page frontmatter
 * parse, and no new table. It is imprecise in the direction that costs
 * nothing: a
 * frontmatter VALUE that happens to contain the literal substring
 * `visibility:` (a title field quoting the word, say) reads as a tagged
 * vault when none exists. `search check`'s honesty finding this feeds
 * is worded to survive that - it names a caller-supplied filter, not an
 * exact count of tagged pages - and the alternative, parsing every
 * frontmatter block back out of `chunks` to confirm the key rather than
 * the substring, re-derives the vault-walk cost this module exists to
 * avoid.
 *
 * ## What it costs, stated rather than implied
 *
 * It is a SCAN of `chunks`, not an index lookup. No index serves it and
 * none could: the only index on the table is `idx_chunks_document`
 * (`schema.ts`), and a leading-wildcard `LIKE` is unindexable in any
 * case, so `chunk_index = ?` is a filter applied per row rather than a
 * seek. `EXISTS` stops at the first match, which makes a vault that DOES
 * use the field cheap and the common case - a vault that never has -
 * the worst one: every chunk body is read to conclude "no".
 *
 * What makes that affordable is WHERE it runs, not how small it is: once
 * per `indexCheck`, an operator-invoked diagnostic, and nowhere on a
 * query path. A caller wanting this answer per search would need a
 * recorded flag rather than this scan.
 */

import { Database } from "bun:sqlite";

import { peekReadonlyIndex, type IndexPeek } from "./state.ts";

/** The `chunk_index` a page's frontmatter block lands at, when it has one. */
const FRONTMATTER_CHUNK_INDEX = 0;

/** Substring a frontmatter chunk carries when the page declares the key. */
const VISIBILITY_KEY_PATTERN = "%visibility:%";

/**
 * True when at least one document's `chunk_index = 0` row contains the
 * literal substring `visibility:`. One `LIKE` scan of `chunks`, stopping
 * at the first hit - see the module docblock for what that costs and why
 * this is not the indexed lookup its shape suggests.
 */
export function anyVisibilityTagPresent(db: Database): boolean {
  const row = db
    .query<{ present: number }, [string, number]>(
      "SELECT EXISTS(SELECT 1 FROM chunks WHERE content LIKE ?1 AND chunk_index = ?2) AS present",
    )
    .get(VISIBILITY_KEY_PATTERN, FRONTMATTER_CHUNK_INDEX);
  return row?.present === 1;
}

/**
 * {@link anyVisibilityTagPresent} for an index path, without opening a
 * `Store` - the same seam {@link peekPendingVectorsSync} and
 * {@link readEmbedderRecordCensusSync} use, and for the same reason:
 * `indexCheck` probes an in-memory database and never touches the real
 * index otherwise.
 */
export function peekVisibilityTagPresence(dbPath: string): IndexPeek<boolean> {
  return peekReadonlyIndex(dbPath, (_read, db) => anyVisibilityTagPresent(db));
}
