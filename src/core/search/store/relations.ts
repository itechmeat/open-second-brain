/**
 * Typed relation edges (v3 / typed graph semantics): the `links` rows
 * whose `relation` is set, the schema-pack constraints that block them,
 * and the endpoint resolution those reads share.
 *
 * Separate from `links.ts` because the reason to change is different:
 * this module follows the relation vocabulary and its constraints, not
 * the syntactic link rows themselves.
 */

import { Database } from "bun:sqlite";

import { sqlPlaceholders } from "./sql.ts";

/**
 * Endpoint resolution for a typed edge, as one SQL expression over a
 * `links` row aliased `l`. Wikilink-style relation targets are usually
 * bare ids (`[[note]]` -> `note`) that the generic `resolveLinkTargets`
 * exact-path pass cannot match against `note.md`, so the ladder also
 * tries `<target>.md` and - when unambiguous - a path-suffix match.
 * Ambiguous suffixes stay unresolved.
 *
 * Shared by all three typed-edge reads below so an edge cannot count as
 * resolved in one and dangling in another.
 */
const TYPED_RELATION_TARGET_SQL =
  "COALESCE(" +
  "    l.target_document_id, " +
  "    (SELECT d.id FROM documents d WHERE d.path = l.target_path || '.md'), " +
  "    (SELECT d.id FROM documents d " +
  "       WHERE SUBSTR(d.path, -(LENGTH(l.target_path) + 4)) = '/' || l.target_path || '.md' " +
  "       AND 1 = (SELECT COUNT(*) FROM documents d2 " +
  "                WHERE SUBSTR(d2.path, -(LENGTH(l.target_path) + 4)) = '/' || l.target_path || '.md'))" +
  "  )";

/**
 * The join that hangs both endpoints' `page_type` off a typed edge: the
 * source document is required, the target is whatever
 * {@link TYPED_RELATION_TARGET_SQL} resolves to.
 */
const TYPED_RELATION_ENDPOINTS_SQL =
  "FROM links l " +
  "JOIN documents sd ON sd.id = l.source_document_id " +
  "LEFT JOIN documents td ON td.id = " +
  TYPED_RELATION_TARGET_SQL +
  " ";

/**
 * For each document id, the typed relation edges it declares
 * (v3 / typed graph semantics): rows whose `relation` is set, in
 * insertion order. The target is the edge's `target_path` as written.
 * Documents with no typed edges are absent from the returned map.
 */
export function typedRelationsForDocuments(
  db: Database,
  documentIds: ReadonlyArray<number>,
): Map<number, Array<{ relation: string; target: string }>> {
  const out = new Map<number, Array<{ relation: string; target: string }>>();
  if (documentIds.length === 0) return out;
  const placeholders = sqlPlaceholders(documentIds);
  const rows = db
    .query<
      {
        source_document_id: number;
        relation: string;
        target_path: string | null;
      },
      number[]
    >(
      "SELECT source_document_id, relation, target_path FROM links " +
        `WHERE source_document_id IN (${placeholders}) AND relation IS NOT NULL ` +
        "AND relation_blocked = 0 " +
        "ORDER BY id",
    )
    .all(...(documentIds as number[]));
  for (const r of rows) {
    const target = r.target_path ?? "";
    if (target === "") continue;
    const arr = out.get(r.source_document_id);
    const edge = { relation: r.relation, target };
    if (arr) arr.push(edge);
    else out.set(r.source_document_id, [edge]);
  }
  return out;
}

/**
 * Typed relation edges declared by the given documents, with the
 * target resolved to a document id when possible (recall-trust-suite,
 * relation polarity). Ambiguous basenames stay unresolved
 * (deterministic inertness beats guessing the wrong page).
 */
export function typedRelationEdgesForDocuments(
  db: Database,
  documentIds: ReadonlyArray<number>,
): Array<{
  readonly sourceDocumentId: number;
  readonly relation: string;
  readonly target: string;
  readonly targetDocumentId: number | null;
}> {
  if (documentIds.length === 0) return [];
  const placeholders = sqlPlaceholders(documentIds);
  const rows = db
    .query<
      {
        source_document_id: number;
        relation: string;
        target_path: string | null;
        resolved_target_id: number | null;
      },
      number[]
    >(
      "SELECT l.source_document_id, l.relation, l.target_path, " +
        `  ${TYPED_RELATION_TARGET_SQL} AS resolved_target_id ` +
        "FROM links l " +
        `WHERE l.source_document_id IN (${placeholders}) AND l.relation IS NOT NULL ` +
        "AND l.relation_blocked = 0 " +
        "ORDER BY l.id",
    )
    .all(...(documentIds as number[]));
  const out: Array<{
    sourceDocumentId: number;
    relation: string;
    target: string;
    targetDocumentId: number | null;
  }> = [];
  for (const r of rows) {
    const target = r.target_path ?? "";
    if (target === "") continue;
    out.push({
      sourceDocumentId: r.source_document_id,
      relation: r.relation,
      target,
      targetDocumentId: r.resolved_target_id,
    });
  }
  return out;
}

/**
 * Recompute every typed edge's `relation_blocked` flag from the
 * current schema-pack constraints (write-time-integrity-governance).
 * Runs after `resolveLinkTargets` on every index pass, so removing a
 * constraint restores blocked edges on the next run without touching
 * files. Returns the rows that ended up blocked. With an empty
 * constraint map the pass only resets stale flags.
 */
export function recomputeRelationConstraintFlags(
  db: Database,
  constraints: Readonly<Record<string, ReadonlyArray<string>>>,
): Array<{
  readonly relation: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly sourceType: string;
  readonly targetType: string;
  readonly declared: ReadonlyArray<string>;
}> {
  const rows = db
    .query<
      {
        id: number;
        relation: string;
        blocked: number;
        source_path: string;
        source_type: string | null;
        target_path: string | null;
        target_type: string | null;
      },
      []
    >(
      "SELECT l.id, l.relation, l.relation_blocked AS blocked, " +
        "  sd.path AS source_path, sd.page_type AS source_type, " +
        "  l.target_path, td.page_type AS target_type " +
        TYPED_RELATION_ENDPOINTS_SQL +
        "WHERE l.relation IS NOT NULL",
    )
    .all();
  const block = db.query("UPDATE links SET relation_blocked = 1 WHERE id = ?");
  const unblock = db.query("UPDATE links SET relation_blocked = 0 WHERE id = ?");
  const violations: Array<{
    relation: string;
    sourcePath: string;
    targetPath: string;
    sourceType: string;
    targetType: string;
    declared: ReadonlyArray<string>;
  }> = [];
  for (const row of rows) {
    const declared = constraints[row.relation];
    const allowed =
      declared === undefined ||
      declared.length === 0 ||
      row.source_type === null ||
      row.target_type === null ||
      declared.includes(`${row.source_type}->${row.target_type}`);
    if (allowed) {
      if (row.blocked !== 0) unblock.run(row.id);
      continue;
    }
    if (row.blocked === 0) block.run(row.id);
    violations.push({
      relation: row.relation,
      sourcePath: row.source_path,
      targetPath: row.target_path ?? "",
      sourceType: row.source_type!,
      targetType: row.target_type!,
      declared: declared!,
    });
  }
  return violations;
}

/**
 * The typed edges currently blocked by link constraints, for lint
 * surfacing. Read-only over the flags the last index pass computed.
 */
export function blockedRelationRows(db: Database): Array<{
  readonly relation: string;
  readonly sourcePath: string;
  readonly targetPath: string;
  readonly sourceType: string | null;
  readonly targetType: string | null;
}> {
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
        TYPED_RELATION_ENDPOINTS_SQL +
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
}
