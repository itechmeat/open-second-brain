/**
 * The `links` table: every wikilink, markdown link and tag a document
 * emits, the passes that materialize their targets, and the graph reads
 * (inbound, outbound, tags, census) built on top of them.
 */

import { Database } from "bun:sqlite";

import { nowIso, sqlPlaceholders } from "./sql.ts";

export interface LinkInput {
  readonly sourceChunkId: number | null;
  readonly targetPath: string | null;
  readonly linkText: string | null;
  readonly linkType: "wikilink" | "markdown_link" | "tag";
  /**
   * Semantic relation type for this edge (v3 / typed graph semantics),
   * orthogonal to `linkType`. `null`/absent for plain syntactic links;
   * set for frontmatter-relation and MCP-config edges. Validated
   * against the open vocabulary in src/core/graph/relation-vocab.ts.
   */
  readonly relation?: string | null;
}

/** Vault-wide link-resolution census (see {@link linkResolutionCounts}). */
export interface LinkResolutionCounts {
  /**
   * Link rows carrying a target path. Tag rows have `target_path IS
   * NULL` and are excluded - a tag has nothing to resolve to.
   */
  readonly total: number;
  /**
   * Rows the read-time resolution ladder cannot resolve to any
   * document - broken links as a reader experiences them.
   */
  readonly unresolved: number;
}

/**
 * The link kinds that carry a navigable target. Tag rows are excluded
 * everywhere this appears, and the two spellings of that exclusion are
 * this one constant.
 */
const NAVIGABLE_LINK_TYPES_SQL = "('wikilink','markdown_link')";

/**
 * The READ-TIME link-resolution ladder, as one SQL expression over a
 * `links` row aliased `l`, yielding the resolved document id or NULL.
 *
 * Three rungs, in order: the materialized `target_document_id` that
 * `resolveLinkTargets` / `resolveAliasTargets` wrote, then a
 * `<target>.md` exact path match, then an UNAMBIGUOUS nested-basename
 * match (`basename = target` with exactly one such nested document -
 * a top-level `target.md` has no leading slash and belongs to the exact
 * rung above).
 *
 * Defined once and shared by {@link resolvedDocLinkPairs} (which
 * follows it) and {@link linkResolutionCounts} (which counts what
 * it leaves over), so "resolvable" and "broken" can never drift apart
 * into two different opinions of the same vault.
 */
const RESOLVED_LINK_TARGET_SQL =
  "COALESCE(" +
  "  l.target_document_id, " +
  "  (SELECT d.id FROM documents d WHERE d.path = l.target_path || '.md'), " +
  "  (SELECT d.id FROM documents d " +
  "     WHERE d.basename = l.target_path AND instr(d.path, '/') > 0 " +
  "     AND 1 = (SELECT COUNT(*) FROM documents d2 " +
  "              WHERE d2.basename = l.target_path AND instr(d2.path, '/') > 0))" +
  ")";

export function replaceLinks(
  db: Database,
  sourceDocumentId: number,
  links: ReadonlyArray<LinkInput>,
): void {
  db.exec("BEGIN");
  try {
    db.run("DELETE FROM links WHERE source_document_id = ?", [sourceDocumentId]);
    if (links.length > 0) {
      const insert = db.prepare<
        undefined,
        [number, number | null, string | null, string | null, string, string | null, string]
      >(
        "INSERT INTO links(source_document_id, source_chunk_id, target_path, link_text, link_type, relation, created_at) " +
          "VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      const now = nowIso();
      for (const l of links) {
        insert.run(
          sourceDocumentId,
          l.sourceChunkId,
          l.targetPath,
          l.linkText,
          l.linkType,
          l.relation ?? null,
          now,
        );
      }
    }
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
}

export function resolveLinkTargets(db: Database): void {
  db.run(
    "UPDATE links SET target_document_id = (SELECT id FROM documents WHERE documents.path = links.target_path) " +
      "WHERE target_path IS NOT NULL",
  );
}

/**
 * Vault-wide link-resolution census (context-integrity-gates, unit G).
 *
 * `unresolved` counts the link rows that carry a target path and that
 * {@link RESOLVED_LINK_TARGET_SQL} - the SAME ladder
 * {@link resolvedDocLinkPairs} follows - cannot resolve to any
 * document. That is what "broken" means to a reader: a materialized
 * id, a `<target>.md` exact match, and an unambiguous basename all
 * count as resolved, and only what survives all three rungs is
 * reported.
 *
 * The narrower `target_document_id IS NULL` predicate is NOT used
 * here. It also fires on every basename-style `[[note]]`, which the
 * ladder resolves perfectly well and which an Obsidian-shaped vault
 * is written in - a count that rises on a healthy edit is a gate that
 * gets bumped rather than obeyed.
 *
 * Index-backed on every rung: `idx_links_target_path` bounds the
 * scan, `documents.path` is UNIQUE, and the basename rungs
 * equality-join `idx_documents_basename`.
 */
export function linkResolutionCounts(db: Database): LinkResolutionCounts {
  const row = db
    .query<{ total: number; unresolved: number | null }, []>(
      "SELECT count(*) AS total, " +
        `sum(CASE WHEN ${RESOLVED_LINK_TARGET_SQL} IS NULL THEN 1 ELSE 0 END) AS unresolved ` +
        "FROM links l WHERE l.target_path IS NOT NULL",
    )
    .get();
  return Object.freeze({ total: row?.total ?? 0, unresolved: row?.unresolved ?? 0 });
}

/** One unresolved link target and the documents that reference it. */
export interface DanglingLinkTarget {
  /** The target spelling the link carried, verbatim. */
  readonly target: string;
  /** Vault-relative paths of the referencing documents, sorted. */
  readonly sources: ReadonlyArray<string>;
}

/**
 * The unresolved link targets themselves, grouped by target.
 *
 * {@link linkResolutionCounts} could say HOW MANY links resolve to
 * nothing and nothing else, so a consumer wanting to act on one - write
 * the missing note, fix the link - had to re-derive the set with its own
 * scan under its own definition. This is the same predicate as the count,
 * over {@link RESOLVED_LINK_TARGET_SQL}, so the list and the number can
 * never disagree about which links are broken.
 *
 * `limit` caps the TARGETS returned, not the rows, and the ordering is
 * total (`target`, then `source`) so two runs over an unchanged index
 * return the same page. Tag rows carry no target path and are excluded by
 * the same `target_path IS NOT NULL` clause the count uses.
 */
export function listDangling(db: Database, limit: number): ReadonlyArray<DanglingLinkTarget> {
  const rows = db
    .query<{ target: string; source: string }, []>(
      "SELECT DISTINCT l.target_path AS target, d.path AS source " +
        "FROM links l JOIN documents d ON d.id = l.source_document_id " +
        `WHERE l.target_path IS NOT NULL AND ${RESOLVED_LINK_TARGET_SQL} IS NULL ` +
        "ORDER BY target, source",
    )
    .all();
  const out: DanglingLinkTarget[] = [];
  const sourcesByTarget = new Map<string, string[]>();
  for (const row of rows) {
    let sources = sourcesByTarget.get(row.target);
    if (sources === undefined) {
      if (out.length >= limit) continue;
      sources = [];
      sourcesByTarget.set(row.target, sources);
      out.push(Object.freeze({ target: row.target, sources }) as DanglingLinkTarget);
    }
    sources.push(row.source);
  }
  return Object.freeze(out.map((t) => Object.freeze({ ...t, sources: Object.freeze(t.sources) })));
}

/**
 * Every link edge resolved to a (source, target) document-id pair,
 * deduplicated, using the same conservative resolution ladder as
 * `typedRelationEdgesForDocuments`: materialized id first,
 * then `<target>.md` exact, then an UNAMBIGUOUS basename suffix.
 * Unresolvable edges are absent. Read-only; feeds bridge discovery
 * and community detection (link-recall-intelligence).
 */
export function resolvedDocLinkPairs(
  db: Database,
): Array<{ readonly source: number; readonly target: number }> {
  const rows = db
    .query<{ source: number; target: number | null }, []>(
      // The ladder itself lives in RESOLVED_LINK_TARGET_SQL, shared
      // with `linkResolutionCounts` so the edges this yields and the
      // rows that gate counts as broken are two views of one rule.
      "SELECT DISTINCT l.source_document_id AS source, " +
        `  ${RESOLVED_LINK_TARGET_SQL} AS target ` +
        "FROM links l WHERE l.target_path IS NOT NULL",
    )
    .all();
  const out: Array<{ source: number; target: number }> = [];
  for (const r of rows) {
    if (r.target !== null) out.push({ source: r.source, target: r.target });
  }
  return out;
}

/**
 * For each chunk id, return the document ids that link TO that
 * chunk's document via wikilink or markdown_link. Pure data; the
 * ranker decides how to convert this into a boost.
 */
export function inboundLinkSources(
  db: Database,
  candidateChunkIds: ReadonlyArray<number>,
): Map<number, Set<number>> {
  const out = new Map<number, Set<number>>();
  if (candidateChunkIds.length === 0) return out;
  const placeholders = sqlPlaceholders(candidateChunkIds);
  const rows = db
    .query<{ chunk_id: number; source_document_id: number }, number[]>(
      "SELECT c.id AS chunk_id, l.source_document_id " +
        `FROM chunks c JOIN links l ON l.target_document_id = c.document_id ` +
        `WHERE c.id IN (${placeholders}) AND l.link_type IN ${NAVIGABLE_LINK_TYPES_SQL} ` +
        `  AND l.source_document_id != c.document_id`,
    )
    .all(...(candidateChunkIds as number[]));
  for (const r of rows) {
    let set = out.get(r.chunk_id);
    if (!set) {
      set = new Set();
      out.set(r.chunk_id, set);
    }
    set.add(r.source_document_id);
  }
  return out;
}

/**
 * For each source document id, the list of resolved outbound link
 * target document ids (wikilink / markdown_link only; tags and
 * unresolved targets excluded; self-links dropped). Used by the
 * recall traversal layer to walk one or more hops out from a hit.
 */
export function outboundLinkTargets(
  db: Database,
  sourceDocumentIds: ReadonlyArray<number>,
): Map<number, number[]> {
  const out = new Map<number, number[]>();
  if (sourceDocumentIds.length === 0) return out;
  const placeholders = sqlPlaceholders(sourceDocumentIds);
  const rows = db
    .query<{ source_document_id: number; target_document_id: number }, number[]>(
      "SELECT DISTINCT l.source_document_id, l.target_document_id " +
        `FROM links l ` +
        `WHERE l.source_document_id IN (${placeholders}) ` +
        `  AND l.target_document_id IS NOT NULL ` +
        `  AND l.target_document_id != l.source_document_id ` +
        `  AND l.link_type IN ${NAVIGABLE_LINK_TYPES_SQL} ` +
        `ORDER BY l.source_document_id, l.target_document_id`,
    )
    .all(...(sourceDocumentIds as number[]));
  for (const r of rows) {
    let list = out.get(r.source_document_id);
    if (!list) {
      list = [];
      out.set(r.source_document_id, list);
    }
    list.push(r.target_document_id);
  }
  return out;
}

/**
 * For each chunk id, the set of tag link_text values associated with
 * its document. Two chunks "share a tag" iff their tag sets intersect.
 */
export function tagsByChunkDocument(
  db: Database,
  candidateChunkIds: ReadonlyArray<number>,
): Map<number, Set<string>> {
  const out = new Map<number, Set<string>>();
  if (candidateChunkIds.length === 0) return out;
  const placeholders = sqlPlaceholders(candidateChunkIds);
  const rows = db
    .query<{ chunk_id: number; tag: string }, number[]>(
      "SELECT c.id AS chunk_id, l.link_text AS tag " +
        `FROM chunks c JOIN links l ON l.source_document_id = c.document_id ` +
        `WHERE c.id IN (${placeholders}) AND l.link_type = 'tag' AND l.link_text IS NOT NULL`,
    )
    .all(...(candidateChunkIds as number[]));
  for (const r of rows) {
    let set = out.get(r.chunk_id);
    if (!set) {
      set = new Set();
      out.set(r.chunk_id, set);
    }
    set.add(r.tag);
  }
  return out;
}
