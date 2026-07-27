/**
 * The `documents` table: one row per indexed vault file, its identity
 * (path, basename, title), its stat fingerprint, and the frontmatter
 * facets later phases join on without re-reading the file.
 */

import { Database } from "bun:sqlite";

import { documentBasename } from "../schema.ts";
import { SearchError } from "../types.ts";
import { nowIso } from "./sql.ts";
import { purgeVecRowsForDocument } from "./vectors.ts";

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
        string,
        string,
        string,
      ]
    >(
      "INSERT INTO documents(path, basename, title, content_hash, mtime, size, page_type, authored_at, created_at, updated_at, indexed_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) " +
        "ON CONFLICT(path) DO UPDATE SET " +
        "  basename = excluded.basename, " +
        "  title = excluded.title, " +
        "  content_hash = excluded.content_hash, " +
        "  mtime = excluded.mtime, " +
        "  size = excluded.size, " +
        "  page_type = excluded.page_type, " +
        "  authored_at = excluded.authored_at, " +
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
