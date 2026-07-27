/**
 * The `doc_aliases` table (v7, link-recall-intelligence): the alternate
 * names a document declares in frontmatter, and the pass that resolves
 * link targets through them.
 */

import { Database } from "bun:sqlite";

/**
 * Canonical alias/lookup-key normalisation for `doc_aliases` (v7):
 * trim, NFC-normalise, lower-case - the exact rule
 * `link-graph/alias-index.ts` applies on the Brain-artifact side, so
 * the two alias surfaces never disagree on a key.
 */
export function normalizeAlias(value: string): string {
  return value.trim().normalize("NFC").toLowerCase();
}

/**
 * Replace one document's frontmatter aliases. Values are normalised
 * via {@link normalizeAlias}; empties and duplicates are dropped.
 */
export function replaceDocAliases(
  db: Database,
  documentId: number,
  aliases: ReadonlyArray<string>,
): void {
  const normalised = [...new Set(aliases.map(normalizeAlias).filter((a) => a.length > 0))];
  db.exec("BEGIN");
  try {
    db.run("DELETE FROM doc_aliases WHERE document_id = ?", [documentId]);
    if (normalised.length > 0) {
      const insert = db.prepare<undefined, [number, string]>(
        "INSERT OR IGNORE INTO doc_aliases(document_id, alias) VALUES (?, ?)",
      );
      for (const alias of normalised) insert.run(documentId, alias);
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

/** Normalised aliases of one document, sorted. */
export function aliasesForDocument(db: Database, documentId: number): ReadonlyArray<string> {
  return db
    .query<{ alias: string }, [number]>(
      "SELECT alias FROM doc_aliases WHERE document_id = ? ORDER BY alias ASC",
    )
    .all(documentId)
    .map((r) => r.alias);
}

/**
 * Materialize `target_document_id` for unresolved, slash-free link
 * targets that match a declared alias. Runs AFTER
 * `resolveLinkTargets` so exact path matches always win.
 *
 * Shadowing rule (mirrors `alias-index.ts`): a target that equals a
 * real document basename is never alias-resolved - the read-time
 * basename fallback owns it. Collisions (two documents claim one
 * alias) resolve first-wins by sorted document path. Normalisation
 * happens in JS because SQLite `lower()` is ASCII-only.
 *
 * Returns the number of link rows resolved.
 */
export function resolveAliasTargets(db: Database): number {
  const unresolved = db
    .query<{ target_path: string }, []>(
      "SELECT DISTINCT target_path FROM links " +
        "WHERE target_document_id IS NULL AND target_path IS NOT NULL " +
        "AND link_type = 'wikilink' AND instr(target_path, '/') = 0",
    )
    .all();
  if (unresolved.length === 0) return 0;

  const aliasOwner = db.prepare<{ document_id: number }, [string]>(
    "SELECT a.document_id AS document_id FROM doc_aliases a " +
      "JOIN documents d ON d.id = a.document_id " +
      "WHERE a.alias = ? ORDER BY d.path ASC LIMIT 1",
  );
  // A real document basename owns the target (top-level `target.md` or
  // any nested `.../target.md`): both collapse to `basename = target`,
  // an index lookup instead of the old `path = target.md OR SUBSTR(...)`
  // full scan.
  const basenameExists = db.prepare<{ id: number }, [string]>(
    "SELECT id FROM documents WHERE basename = ? LIMIT 1",
  );
  const update = db.prepare<undefined, [number, string]>(
    "UPDATE links SET target_document_id = ? " +
      "WHERE target_document_id IS NULL AND target_path = ? AND link_type = 'wikilink'",
  );

  let resolved = 0;
  db.exec("BEGIN");
  try {
    for (const row of unresolved) {
      const key = normalizeAlias(row.target_path);
      if (key.length === 0) continue;
      // Skip targets a real document basename owns.
      if (basenameExists.get(row.target_path)) {
        continue;
      }
      const owner = aliasOwner.get(key);
      if (!owner) continue;
      update.run(owner.document_id, row.target_path);
      resolved += db.query<{ n: number }, []>("SELECT changes() AS n").get()?.n ?? 0;
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  return resolved;
}
