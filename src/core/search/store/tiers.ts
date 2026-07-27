/**
 * Tiered-frontmatter identity (write-time-integrity-governance): the
 * per-document snapshot the last index pass recorded, and the
 * `tier_drift` rows that stage hand-edits of an identity field.
 */

import { Database } from "bun:sqlite";

/** Parse a JSON-encoded drift value; a corrupt cell surfaces as-is. */
function parseJsonValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * The tiered-frontmatter snapshot the last index pass recorded for a
 * document, or null when none exists.
 */
export function getTierSnapshot(db: Database, documentId: number): Record<string, unknown> | null {
  const row = db
    .query<{ tier_snapshot: string | null }, [number]>(
      "SELECT tier_snapshot FROM documents WHERE id = ?",
    )
    .get(documentId);
  if (!row || row.tier_snapshot === null) return null;
  try {
    const parsed: unknown = JSON.parse(row.tier_snapshot);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    return null;
  }
}

export function setTierSnapshot(
  db: Database,
  documentId: number,
  snapshot: Readonly<Record<string, unknown>>,
): void {
  db.run("UPDATE documents SET tier_snapshot = ? WHERE id = ?", [
    JSON.stringify(snapshot),
    documentId,
  ]);
}

/** Stage one identity-field hand-edit; (document, field) upserts. */
export function upsertTierDrift(
  db: Database,
  input: {
    readonly documentId: number;
    readonly field: string;
    readonly expected: unknown;
    readonly actual: unknown;
    readonly detectedAt: string;
  },
): void {
  db.run(
    "INSERT INTO tier_drift(document_id, field, expected, actual, detected_at) " +
      "VALUES (?, ?, ?, ?, ?) " +
      "ON CONFLICT(document_id, field) DO UPDATE SET actual = excluded.actual",
    [
      input.documentId,
      input.field,
      JSON.stringify(input.expected),
      JSON.stringify(input.actual),
      input.detectedAt,
    ],
  );
}

export function clearTierDrift(db: Database, documentId: number, field?: string): void {
  if (field === undefined) {
    db.run("DELETE FROM tier_drift WHERE document_id = ?", [documentId]);
  } else {
    db.run("DELETE FROM tier_drift WHERE document_id = ? AND field = ?", [documentId, field]);
  }
}

/** Open identity-drift findings, oldest first, with document paths. */
export function listTierDrift(db: Database): Array<{
  readonly documentId: number;
  readonly path: string;
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly detectedAt: string;
}> {
  return db
    .query<
      {
        document_id: number;
        path: string;
        field: string;
        expected: string;
        actual: string;
        detected_at: string;
      },
      []
    >(
      "SELECT t.document_id, d.path, t.field, t.expected, t.actual, t.detected_at " +
        "FROM tier_drift t JOIN documents d ON d.id = t.document_id " +
        "ORDER BY t.detected_at, t.id",
    )
    .all()
    .map((r) => ({
      documentId: r.document_id,
      path: r.path,
      field: r.field,
      expected: parseJsonValue(r.expected),
      actual: parseJsonValue(r.actual),
      detectedAt: r.detected_at,
    }));
}
