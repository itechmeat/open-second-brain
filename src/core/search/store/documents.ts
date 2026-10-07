/**
 * The `documents` table: one row per indexed vault file, its identity
 * (path, basename, title), its stat fingerprint, and the frontmatter
 * facets later phases join on without re-reading the file.
 */

import { Database } from "bun:sqlite";

import { isEventAnchorSource, type EventAnchor } from "../event-anchor.ts";
import {
  DOCUMENT_VISIBILITY_COLUMN,
  EVENT_TIME_MAX_COLUMN,
  EVENT_TIME_MIN_COLUMN,
  PINNED_COLUMN,
  documentBasename,
  encodeDocumentVisibility,
} from "../schema.ts";
import { SearchError } from "../types.ts";
import { nowIso } from "./sql.ts";
import { purgeVecRowsForDocument } from "./vectors.ts";

/**
 * `documents.event_anchor_examined`: whether an anchor-aware binary has
 * ever resolved this document's event anchor. SQLite has no boolean, so
 * the two values are named once here rather than written as bare 0/1 at
 * each of the four sites that read or write them.
 */
const EXAMINED_YES = 1;
const EXAMINED_NO = 0;

/**
 * `documents.pinned`: the per-note `pinned` frontmatter flag (v13,
 * schema half of t_f7bef96a), named once for the same reason - SQLite
 * has no boolean, and a bare 0/1 at each write site invites a third
 * value nobody registered.
 */
const PINNED_YES = 1;
const PINNED_NO = 0;

export interface DocumentInput {
  readonly path: string; // vault-relative POSIX
  readonly title: string | null;
  readonly contentHash: string;
  readonly mtime: number; // unix seconds
  readonly size: number;
  /**
   * The page's declared frontmatter `type` (normalized token), or null
   * when undeclared. Persisted so link-constraint enforcement can join
   * endpoint types without re-reading files (v6).
   */
  readonly pageType?: string | null;
  /**
   * Transcript turn instant this note was authored at, in unix seconds
   * (conversation chronology, S1 / t_347e8224). Derived from the
   * `authored_at` frontmatter field. Absent / null for a note with no
   * turn instant, which then ranks byte-identically to pre-feature.
   */
  readonly authoredAt?: number | null;
  /**
   * The interval this note is ABOUT, resolved from its own frontmatter or
   * body by `resolveEventAnchor` (provenance at the boundary, v11), with
   * the registered token naming which rung produced it.
   *
   * The three states are distinct and all three are recorded:
   *
   *   - an `EventAnchor` - the caller resolved one;
   *   - `null` - the caller resolved the anchor and the note declares no
   *     readable date, so it keeps ranking on storage mtime exactly as
   *     before the anchor existed;
   *   - ABSENT - the caller did not resolve an anchor at all. The row is
   *     then marked unexamined and `o2b search event-anchor-backfill`
   *     finds it. Omitting the field is not the same statement as
   *     passing `null`, and the column that separates them exists
   *     because a hard time filter now depends on the difference.
   */
  readonly eventAnchor?: EventAnchor | null;
  /**
   * The document's RESOLVED event-time window bounds in unix ms (v13),
   * resolved by `resolveDocumentEventTimeWindow` under the shared rung
   * order (frontmatter validity window > event anchor - admitted rungs
   * only). At least one side is non-null for a declared window; a null
   * side is a declared open one.
   *
   * Absent or null on both keeps the columns NULL - the unmeasured
   * state the query side judges by storage mtime, exactly as before
   * these columns existed.
   */
  readonly eventTimeMinMs?: number | null;
  readonly eventTimeMaxMs?: number | null;
  /**
   * The page's per-note `pinned` frontmatter flag (schema half of
   * t_f7bef96a), persisted so ranking can consume it without re-reading
   * files.
   *
   * ABSENT means the caller did not look, and the column is left NULL -
   * "not pinned" and "nobody looked" are different statements, and only
   * the first is something the page said.
   */
  readonly pinned?: boolean;
  /**
   * The page's normalised `visibility:` tokens, as {@link pageVisibility}
   * reads them - an empty array for a page that declares none (v12).
   *
   * ABSENT means the caller did not measure them, and the column is left
   * NULL. That is a third state and not a synonym for the empty array:
   * "this page declares no visibility" and "nobody looked" are different
   * statements, and only the first is something the page said.
   *
   * The column records what the INDEX knows. It is not the read boundary
   * - that is the live frontmatter check at the three read roots
   * (`isPathReadableAtReach`), which reads the file rather than a
   * snapshot of it and is therefore never stale by a whole index run.
   * Those roots additionally honour this column when they serve indexed
   * text, so a stale private chunk stays private (see
   * {@link indexedVisibilityByPaths}).
   */
  readonly visibility?: ReadonlyArray<string>;
}

export interface DocumentSummary {
  readonly id: number;
  readonly contentHash: string;
  readonly mtime: number;
  readonly size: number;
}

export function listDocuments(db: Database): Map<string, DocumentSummary> {
  const rows = db
    .query<
      {
        id: number;
        path: string;
        content_hash: string;
        mtime: number;
        size: number;
      },
      []
    >("SELECT id, path, content_hash, mtime, size FROM documents")
    .all();
  const map = new Map<string, DocumentSummary>();
  for (const r of rows) {
    map.set(r.path, {
      id: r.id,
      contentHash: r.content_hash,
      mtime: r.mtime,
      size: r.size,
    });
  }
  return map;
}

/**
 * The visibility tokens the index MEASURED for each of `paths`, keyed by
 * path. A path with no row, a NULL (unmeasured) column, or a value that
 * does not decode to a string array is absent from the map: only a
 * measurement is a statement the page made.
 *
 * Read by the reach boundary because a search result serves the INDEXED
 * bytes, not the file's: when a page reserved at index time has since
 * been deleted or moved and a public page written at its path, the file
 * says "public" while the snippet is the private body. See
 * `isPathReadableAtReach`.
 */
export function indexedVisibilityByPaths(
  db: Database,
  paths: ReadonlyArray<string>,
): Map<string, ReadonlyArray<string>> {
  const out = new Map<string, ReadonlyArray<string>>();
  if (paths.length === 0) return out;
  const query = db.query<{ visibility: string | null }, [string]>(
    `SELECT ${DOCUMENT_VISIBILITY_COLUMN} AS visibility FROM documents WHERE path = ?`,
  );
  for (const path of new Set(paths)) {
    const raw = query.get(path)?.visibility ?? null;
    if (raw === null) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      continue;
    }
    if (Array.isArray(decoded) && decoded.every((t) => typeof t === "string")) {
      out.set(path, Object.freeze([...(decoded as string[])]));
    }
  }
  return out;
}

export function getDocumentIdByPath(db: Database, path: string): number | null {
  const row = db
    .query<{ id: number }, [string]>("SELECT id FROM documents WHERE path = ?")
    .get(path);
  return row?.id ?? null;
}

export function upsertDocument(db: Database, doc: DocumentInput): number {
  const now = nowIso();
  // SQLite RETURNING on INSERT...ON CONFLICT works in 3.35+; bun:sqlite ships modern SQLite.
  const row = db
    .query<
      { id: number },
      [
        string,
        string,
        string | null,
        string,
        number,
        number,
        string | null,
        number | null,
        number | null,
        number | null,
        string | null,
        number,
        string | null,
        number | null,
        number | null,
        number | null,
        string,
        string,
        string,
      ]
    >(
      "INSERT INTO documents(path, basename, title, content_hash, mtime, size, page_type, authored_at, " +
        "  event_anchor_start_ms, event_anchor_end_ms, event_anchor_source, event_anchor_examined, " +
        `  ${DOCUMENT_VISIBILITY_COLUMN}, ` +
        `  ${EVENT_TIME_MIN_COLUMN}, ${EVENT_TIME_MAX_COLUMN}, ${PINNED_COLUMN}, ` +
        "  created_at, updated_at, indexed_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(path) DO UPDATE SET " +
        "  basename = excluded.basename, " +
        "  title = excluded.title, " +
        "  content_hash = excluded.content_hash, " +
        "  mtime = excluded.mtime, " +
        "  size = excluded.size, " +
        "  page_type = excluded.page_type, " +
        "  authored_at = excluded.authored_at, " +
        "  event_anchor_start_ms = excluded.event_anchor_start_ms, " +
        "  event_anchor_end_ms = excluded.event_anchor_end_ms, " +
        "  event_anchor_source = excluded.event_anchor_source, " +
        "  event_anchor_examined = excluded.event_anchor_examined, " +
        `  ${DOCUMENT_VISIBILITY_COLUMN} = excluded.${DOCUMENT_VISIBILITY_COLUMN}, ` +
        `  ${EVENT_TIME_MIN_COLUMN} = excluded.${EVENT_TIME_MIN_COLUMN}, ` +
        `  ${EVENT_TIME_MAX_COLUMN} = excluded.${EVENT_TIME_MAX_COLUMN}, ` +
        `  ${PINNED_COLUMN} = excluded.${PINNED_COLUMN}, ` +
        "  updated_at = excluded.updated_at, " +
        "  indexed_at = excluded.indexed_at " +
        "RETURNING id",
    )
    .get(
      doc.path,
      documentBasename(doc.path),
      doc.title,
      doc.contentHash,
      doc.mtime,
      doc.size,
      doc.pageType ?? null,
      doc.authoredAt ?? null,
      doc.eventAnchor?.startMs ?? null,
      doc.eventAnchor?.endMs ?? null,
      doc.eventAnchor?.source ?? null,
      // Examined iff the caller stated an answer. `null` IS an answer
      // ("this note declares nothing"); leaving the field out is not.
      doc.eventAnchor === undefined ? EXAMINED_NO : EXAMINED_YES,
      // Absent means unmeasured, which is NULL - see `DocumentInput`.
      doc.visibility === undefined ? null : encodeDocumentVisibility(doc.visibility),
      doc.eventTimeMinMs ?? null,
      doc.eventTimeMaxMs ?? null,
      doc.pinned === undefined ? null : doc.pinned ? PINNED_YES : PINNED_NO,
      now,
      now,
      now,
    );
  if (!row) {
    throw new SearchError("INDEX_UNREADABLE", `upsertDocument returned no id for '${doc.path}'`);
  }
  return row.id;
}

/**
 * The documents among `documentIds` the index MEASURED as pinned
 * (`documents.pinned = 1`, v13; t_f7bef96a).
 *
 * Scoped to the caller's candidates and to pinned rows only, so a search
 * reads the handful of rows that can earn the boost rather than every
 * measured row of the corpus. A measured-unpinned row and a row the v13
 * migration carried over unmeasured both answer "not in the set": neither
 * earns a boost, and neither is reported, so an unpinned result's shape
 * is unchanged by the feature.
 */
export function pinnedDocumentIds(db: Database, documentIds: ReadonlyArray<number>): Set<number> {
  const out = new Set<number>();
  if (documentIds.length === 0) return out;
  const rows = db
    .query<{ id: number }, [number, string]>(
      `SELECT id FROM documents WHERE ${PINNED_COLUMN} = ? ` +
        `AND id IN (SELECT value FROM json_each(?))`,
    )
    .all(PINNED_YES, JSON.stringify([...new Set(documentIds)]));
  for (const r of rows) out.add(r.id);
  return out;
}

/**
 * The materialised event anchor of one path, or null when the document is
 * absent from the index or declared no readable date (v11).
 *
 * A row carrying an anchor whose source token is not in the registered
 * vocabulary, or whose bounds are both NULL beside a non-NULL source, is
 * an index this binary cannot interpret - it raises rather than returning
 * null, because "no anchor" and "an anchor I cannot read" are different
 * answers and the caller must not receive the first when the truth is the
 * second.
 *
 * A row that was never EXAMINED also returns null, and deliberately does
 * not raise: it holds exactly the answer the previous binary held, so
 * the query degrades to storage mtime precisely as it did before this
 * feature, rather than failing every query on an index that predates it.
 * That state is not left silent either - it is counted by
 * {@link countUnexaminedEventAnchors}, reported by every index run, and
 * closed by `o2b search event-anchor-backfill --apply`.
 */
export function eventAnchorForPath(db: Database, path: string): EventAnchor | null {
  const row = db
    .query<
      {
        event_anchor_start_ms: number | null;
        event_anchor_end_ms: number | null;
        event_anchor_source: string | null;
      },
      [string]
    >(
      "SELECT event_anchor_start_ms, event_anchor_end_ms, event_anchor_source " +
        "FROM documents WHERE path = ?",
    )
    .get(path);
  if (!row || row.event_anchor_source === null) return null;
  if (!isEventAnchorSource(row.event_anchor_source)) {
    throw new SearchError(
      "INDEX_UNREADABLE",
      `documents.event_anchor_source for '${path}' is not a registered anchor source: '${row.event_anchor_source}'`,
    );
  }
  if (row.event_anchor_start_ms === null && row.event_anchor_end_ms === null) {
    throw new SearchError(
      "INDEX_UNREADABLE",
      `documents row for '${path}' names an anchor source with no bounds on either side`,
    );
  }
  return Object.freeze({
    startMs: row.event_anchor_start_ms,
    endMs: row.event_anchor_end_ms,
    source: row.event_anchor_source,
  });
}

/**
 * Vault-relative paths of the documents no anchor-aware binary has ever
 * examined (v11), in stable path order.
 *
 * These are the rows a v10 index carried across the migration: the
 * columns exist, the fastpaths correctly decline to recompute anything
 * for content that did not change, and so nothing ever populates them.
 * They are NOT documents that declare no date - that is the state this
 * list exists to be distinguishable from.
 */
export function unexaminedEventAnchorPaths(db: Database): string[] {
  return db
    .query<{ path: string }, [number]>(
      "SELECT path FROM documents WHERE event_anchor_examined = ? ORDER BY path",
    )
    .all(EXAMINED_NO)
    .map((r) => r.path);
}

/** How many documents no anchor-aware binary has ever examined (v11). */
export function countUnexaminedEventAnchors(db: Database): number {
  return (
    db
      .query<{ c: number }, [number]>(
        "SELECT count(*) AS c FROM documents WHERE event_anchor_examined = ?",
      )
      .get(EXAMINED_NO)?.c ?? 0
  );
}

/**
 * Record the event anchor of an already-indexed document and mark it
 * examined, touching nothing else on the row - no chunks, no links, no
 * stat fingerprint. This is the backfill's only write.
 *
 * `null` stores the verdict "this note declares no readable date", which
 * is a result and not an absence of one.
 */
export function setEventAnchor(db: Database, path: string, anchor: EventAnchor | null): void {
  db.run(
    "UPDATE documents SET event_anchor_start_ms = ?, event_anchor_end_ms = ?, " +
      "event_anchor_source = ?, event_anchor_examined = ?, updated_at = ? WHERE path = ?",
    [
      anchor?.startMs ?? null,
      anchor?.endMs ?? null,
      anchor?.source ?? null,
      EXAMINED_YES,
      nowIso(),
      path,
    ],
  );
}

/**
 * Delete a document and everything that hangs off it. The vec rows
 * are removed first because the FK cascade does not reach the
 * `chunk_vec` virtual table.
 */
export function deleteDocument(db: Database, vecLoaded: boolean, path: string): void {
  const id = getDocumentIdByPath(db, path);
  if (id === null) return;
  purgeVecRowsForDocument(db, vecLoaded, id);
  db.run("DELETE FROM documents WHERE id = ?", [id]);
}

/**
 * Touch a document's mtime and size without changing its title,
 * hash, or triggering chunk replacement. Used by the indexer's
 * mtime-fastpath fallback to re-arm the stat cache after a
 * same-content touch.
 */
export function touchDocument(db: Database, path: string, mtime: number, size: number): void {
  const now = nowIso();
  db.run(
    "UPDATE documents SET mtime = ?, size = ?, updated_at = ?, indexed_at = ? WHERE path = ?",
    [mtime, size, now, now, path],
  );
}

/**
 * Document id -> { path, title } for every indexed document, reading
 * ONLY the `documents` table (never chunk bodies). The graph query
 * pre-pass uses this for its index-only short-circuit so it can rank and
 * answer from index metadata with zero note bodies hydrated.
 */
export function documentTitles(
  db: Database,
): Map<number, { readonly path: string; readonly title: string | null }> {
  const out = new Map<number, { path: string; title: string | null }>();
  const rows = db
    .query<{ id: number; path: string; title: string | null }, []>(
      "SELECT id, path, title FROM documents",
    )
    .all();
  for (const r of rows) out.set(r.id, { path: r.path, title: r.title });
  return out;
}

export function countDocuments(db: Database): number {
  return db.query<{ c: number }, []>("SELECT count(*) AS c FROM documents").get()?.c ?? 0;
}

/**
 * How many documents sit under one raw path prefix, matched with the
 * same `substr` form the pending-vector census uses so the two agree.
 */
export function countDocumentsUnderPrefix(db: Database, prefix: string): number {
  return (
    db
      .query<{ c: number }, [string, string]>(
        "SELECT count(*) AS c FROM documents WHERE substr(path, 1, length(?)) = ?",
      )
      .get(prefix, prefix)?.c ?? 0
  );
}
