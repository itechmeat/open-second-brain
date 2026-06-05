/**
 * Link-type endpoint constraints (write-time-integrity-governance).
 *
 * The schema pack's `link_constraints` field declares, per link type,
 * which `source_type->target_type` page-type pairs may carry that
 * typed relation. Enforcement happens at materialization: the
 * indexer's post-pass marks violating edges blocked so they fall back
 * to plain untyped links instead of participating in typed-relation
 * recall (polarity, traversal). Constraints constrain materialization,
 * not authoring - the frontmatter stays untouched, the flags are
 * recomputed from the current pack on every index run, and a relation
 * with no declared constraints (or an endpoint whose page type is
 * unknown) is always allowed, so an unconfigured vault is unaffected.
 */

import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

export type LinkConstraintMap = Readonly<Record<string, ReadonlyArray<string>>>;

/** One typed edge whose endpoints violate the declared constraints. */
export interface LinkConstraintViolation {
  readonly relation: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly sourceType: string;
  readonly targetType: string;
  /** The pairs the schema pack declares for this relation. */
  readonly declared: ReadonlyArray<string>;
}

/**
 * Decide whether one typed edge may materialize. Fail-open on missing
 * information: a relation without declared constraints, or an endpoint
 * whose page type is unknown (no `type:` frontmatter, or the document
 * predates the `page_type` column), cannot be evaluated and passes.
 */
export function linkConstraintAllows(
  constraints: LinkConstraintMap,
  relation: string,
  sourceType: string | null,
  targetType: string | null,
): boolean {
  const declared = constraints[relation];
  if (declared === undefined || declared.length === 0) return true;
  if (sourceType === null || targetType === null) return true;
  return declared.includes(`${sourceType}->${targetType}`);
}

/** One blocked edge as the lint surface reads it back from the index. */
export interface BlockedRelationRow {
  readonly relation: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly sourceType: string | null;
  readonly targetType: string | null;
}

/**
 * Read the edges the last index pass blocked, straight from the index
 * database. Lint-surface companion to the indexer post-pass: read-only,
 * fail-soft - a missing index file, a pre-v6 schema, or any read error
 * yields an empty list rather than failing the lint.
 */
export function readBlockedRelationRows(dbPath: string): ReadonlyArray<BlockedRelationRow> {
  if (!existsSync(dbPath)) return [];
  let db: Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true });
    return db
      .query<
        {
          relation: string;
          source_path: string;
          target_path: string | null;
          source_type: string | null;
          target_type: string | null;
        },
        []
      >(
        "SELECT l.relation, sd.path AS source_path, l.target_path, " +
          "  sd.page_type AS source_type, td.page_type AS target_type " +
          "FROM links l " +
          "JOIN documents sd ON sd.id = l.source_document_id " +
          "LEFT JOIN documents td ON td.id = COALESCE(" +
          "    l.target_document_id, " +
          "    (SELECT d.id FROM documents d WHERE d.path = l.target_path || '.md'), " +
          "    (SELECT d.id FROM documents d " +
          "       WHERE SUBSTR(d.path, -(LENGTH(l.target_path) + 4)) = '/' || l.target_path || '.md' " +
          "       AND 1 = (SELECT COUNT(*) FROM documents d2 " +
          "                WHERE SUBSTR(d2.path, -(LENGTH(l.target_path) + 4)) = '/' || l.target_path || '.md'))" +
          "  ) " +
          "WHERE l.relation IS NOT NULL AND l.relation_blocked = 1 " +
          "ORDER BY sd.path, l.id",
      )
      .all()
      .map((r) => ({
        relation: r.relation,
        sourcePath: r.source_path,
        targetPath: r.target_path ?? "",
        sourceType: r.source_type,
        targetType: r.target_type,
      }));
  } catch {
    return [];
  } finally {
    db?.close();
  }
}
