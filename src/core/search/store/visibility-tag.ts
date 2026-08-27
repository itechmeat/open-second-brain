/**
 * What the index knows about `visibility:` frontmatter, read off the
 * column the indexer materialises rather than by scanning chunk bodies
 * (private-is-not-a-suggestion, unit 6).
 *
 * ## What this replaced, and why
 *
 * Until v12 the answer came from a `LIKE '%visibility:%'` scan of every
 * document's `chunk_index = 0` row - a full table scan whose cheapest
 * case was a vault that DOES use the field and whose worst case was the
 * common one, and which was imprecise in a direction it could not
 * correct: a frontmatter VALUE quoting the literal `visibility:` (a title
 * quoting the word, say) read as a tagged vault when none existed.
 *
 * `documents.visibility` is that same fact, decided by the same
 * {@link pageVisibility} the read boundary uses, written once per upsert
 * and backfilled for pre-existing rows by migration 12. The scan and its
 * substring guess are both gone.
 *
 * ## Three states, and why the count of the third is reported
 *
 * NULL means the index holds no chunk zero for that document and
 * therefore measured nothing. It is not "no tokens", and
 * {@link countUnmeasuredDocuments} exists so `search check` can report
 * that population rather than absorb it into the measured one.
 *
 * ## What this is NOT
 *
 * It is not the read boundary. That is the live frontmatter check at the
 * three read roots (`isPathReadableAtReach`), which reads the FILE. A
 * column is a snapshot of the last index run, and a page reserved a
 * minute ago must be reserved now rather than at the next run - so the
 * column reports, and the file decides.
 */

import { Database } from "bun:sqlite";

import { DOCUMENT_VISIBILITY_COLUMN, DOCUMENT_VISIBILITY_NONE } from "../schema.ts";
import { peekReadonlyIndex, type IndexPeek } from "./state.ts";

/**
 * True when at least one document was measured and declares at least one
 * visibility token. Exact: `[]` is the measured-and-empty value and NULL
 * is the unmeasured one, so neither can read as a tagged page.
 */
export function anyVisibilityTagPresent(db: Database): boolean {
  const row = db
    .query<{ present: number }, [string]>(
      `SELECT EXISTS(SELECT 1 FROM documents ` +
        `WHERE ${DOCUMENT_VISIBILITY_COLUMN} IS NOT NULL ` +
        `AND ${DOCUMENT_VISIBILITY_COLUMN} <> ?1) AS present`,
    )
    .get(DOCUMENT_VISIBILITY_NONE);
  return row?.present === 1;
}

/**
 * How many indexed documents the index measured nothing for.
 *
 * Reported rather than absorbed: these rows are the legacy population a
 * migration could not read, and a diagnostic that folded them into "no
 * tokens" would be answering a question nobody could check.
 */
export function countUnmeasuredDocuments(db: Database): number {
  const row = db
    .query<{ n: number }, []>(
      `SELECT COUNT(*) AS n FROM documents WHERE ${DOCUMENT_VISIBILITY_COLUMN} IS NULL`,
    )
    .get();
  return row?.n ?? 0;
}

/**
 * How many indexed documents declare the token reserved against remote
 * reads - the population this boundary withholds from a remote caller.
 *
 * `json_each` rather than a substring match, so a token that CONTAINS the
 * reserved one is not counted as it.
 */
export function countRemoteReservedDocuments(db: Database, token: string): number {
  const row = db
    .query<{ n: number }, [string]>(
      `SELECT COUNT(*) AS n FROM documents ` +
        `WHERE ${DOCUMENT_VISIBILITY_COLUMN} IS NOT NULL ` +
        `AND EXISTS(SELECT 1 FROM json_each(documents.${DOCUMENT_VISIBILITY_COLUMN}) ` +
        `WHERE json_each.value = ?1)`,
    )
    .get(token);
  return row?.n ?? 0;
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

/**
 * The two populations `search check` reports beside the presence flag,
 * read in one open so the diagnostic pays one probe rather than three.
 */
export interface VisibilityColumnCensus {
  readonly tagged: boolean;
  readonly unmeasured: number;
  readonly reserved: number;
}

export function peekVisibilityColumnCensus(
  dbPath: string,
  reservedToken: string,
): IndexPeek<VisibilityColumnCensus> {
  return peekReadonlyIndex(dbPath, (_read, db) => ({
    tagged: anyVisibilityTagPresent(db),
    unmeasured: countUnmeasuredDocuments(db),
    reserved: countRemoteReservedDocuments(db, reservedToken),
  }));
}
