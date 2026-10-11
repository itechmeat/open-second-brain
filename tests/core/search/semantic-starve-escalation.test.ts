/**
 * The semantic lane's bounded window escalation on filter starvation
 * (PR #248 review M2).
 *
 * The kind, pushdown and prefix predicates run AFTER vec0 selects its k
 * nearest rows, so a selective filter can drop most of the naive
 * `limit * 4` window and leave the lane little or nothing: the worst
 * case is `kind=page`, where each document contributes exactly one page
 * chunk that rarely sits near a query vector. The lane now widens its
 * window - at most two escalations, never past vec0's own k ceiling -
 * before it gives up, and when it is STILL starved it says so with a
 * named notice on stderr instead of answering with a silently short
 * result. An unfiltered lane never escalates: a short answer there is
 * an exhausted corpus, not a starved filter.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";
import { applyMigrations, ensureVecTable } from "../../../src/core/search/schema.ts";
import { semanticTopK } from "../../../src/core/search/store/vectors.ts";

const VEC_AVAILABLE = sqliteVecLoadable();

/** The probe query direction; sections sit near it, the page sits orthogonal. */
const QUERY = new Float32Array([1, 0, 0, 0]);

function f32(components: ReadonlyArray<number>): Buffer {
  return Buffer.from(Float32Array.from(components).buffer);
}

/**
 * A store whose nearest neighbours starve a `kind=page` filter at the
 * naive window: `nearSections` section chunks hug the query vector while
 * the single page chunk sits orthogononal to it. With `limit` at 3 the
 * naive window is 12 - exactly the section count - so the page chunk is
 * never selected without an escalation.
 */
function seedStarvedStore(nearSections: number): Database {
  const db = new Database(":memory:");
  applyMigrations(db);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const vec = require("sqlite-vec") as { getLoadablePath(): string };
  db.loadExtension(vec.getLoadablePath());
  ensureVecTable(db, 4);
  const insertDoc = db.query<{ id: number }, [string]>(
    "INSERT INTO documents(path, content_hash, mtime, size, created_at, updated_at, indexed_at) " +
      "VALUES (?, 'h', 0, 0, 'n', 'n', 'n') RETURNING id",
  );
  const insertChunk = db.query<{ id: number }, [number, string]>(
    "INSERT INTO chunks(document_id, chunk_index, chunk_kind, content, fts_content, content_hash, " +
      "start_line, end_line, token_count, created_at, updated_at) " +
      "VALUES (?, 0, ?, 'x', 'x', 'h', 1, 1, 1, 'n', 'n') RETURNING id",
  );
  const insertVec = db.query("INSERT INTO chunk_vec(rowid, embedding) VALUES (?, ?)");
  const insertMap = db.query("INSERT INTO chunk_vec_map(chunk_id, vec_rowid) VALUES (?, ?)");
  const chunk = (path: string, kind: "page" | "section", embedding: Buffer): void => {
    const docId = insertDoc.get(path)!.id;
    const rowId = insertChunk.get(docId, kind)!.id;
    insertVec.run(rowId, embedding);
    insertMap.run(rowId, rowId);
  };
  for (let i = 0; i < nearSections; i++) {
    chunk(`notes/section-${i}.md`, "section", f32([1, 0.01 * (i + 1), 0, 0]));
  }
  return db;
}

function seedPageChunk(db: Database): void {
  const docId = db
    .query<{ id: number }, []>(
      "INSERT INTO documents(path, content_hash, mtime, size, created_at, updated_at, indexed_at) " +
        "VALUES ('notes/the-page.md', 'h', 0, 0, 'n', 'n', 'n') RETURNING id",
    )
    .get()!.id;
  const rowId = db
    .query<{ id: number }, [number]>(
      "INSERT INTO chunks(document_id, chunk_index, chunk_kind, content, fts_content, content_hash, " +
        "start_line, end_line, token_count, created_at, updated_at) " +
        "VALUES (?, 0, 'page', 'x', 'x', 'h', 1, 1, 1, 'n', 'n') RETURNING id",
    )
    .get(docId)!.id;
  db.query("INSERT INTO chunk_vec(rowid, embedding) VALUES (?, ?)").run(rowId, f32([0, 1, 0, 0]));
  db.query("INSERT INTO chunk_vec_map(chunk_id, vec_rowid) VALUES (?, ?)").run(rowId, rowId);
}

describe.skipIf(!VEC_AVAILABLE)("the filtered semantic lane widens before it starves", () => {
  let stderr: ReturnType<typeof spyOn> | undefined;

  beforeEach(() => {
    stderr = spyOn(console, "error");
  });
  afterEach(() => {
    stderr?.mockRestore();
    stderr = undefined;
  });

  test("a selective kind filter escalates past the naive window and answers", () => {
    const db = seedStarvedStore(12);
    try {
      seedPageChunk(db);
      // The naive window (k = 3 * 4 = 12) holds only section chunks, so a
      // lane without escalation answers a selective page filter with nothing.
      const pages = semanticTopK(db, true, QUERY, { limit: 3, kind: "page" });
      expect(pages).toHaveLength(1);
      const pageChunk = db
        .query<{ id: number }, []>("SELECT id FROM chunks WHERE chunk_kind = 'page'")
        .get()!.id;
      expect(pages[0]!.chunkId).toBe(pageChunk);
      // The escalation succeeded, so the lane is not starved: no notice.
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  test("still starved after the bounded escalations, the lane names the degradation", () => {
    // 600 sections put the population far past the capped window, so no
    // widening can judge every chunk: from k=12 the two escalations reach
    // 192 and stop, the page filter still kept nothing, and rows may exist
    // beyond the window - the one case that is honestly a starvation.
    const db = seedStarvedStore(600);
    try {
      const pages = semanticTopK(db, true, QUERY, { limit: 3, kind: "page" });
      expect(pages).toHaveLength(0);
      expect(stderr).toHaveBeenCalledTimes(1);
      const message = String(stderr.mock.calls[0]?.[0]);
      expect(message).toContain("semantic-lane-filter-starved");
      // Two escalations from the naive 12, then the bound: 12 -> 48 -> 192.
      expect(message).toContain("192");
      expect(message).toContain("600");
    } finally {
      db.close();
    }
  });

  test("a window that already judged the whole store is not starvation", () => {
    // No page chunk exists and the naive window already covers every
    // embedded chunk: the filter judged the entire store, so the empty
    // answer is the corpus's own shape - no widening, no notice.
    const db = seedStarvedStore(12);
    try {
      const pages = semanticTopK(db, true, QUERY, { limit: 3, kind: "page" });
      expect(pages).toHaveLength(0);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });

  test("an unfiltered lane never escalates and never claims starvation", () => {
    const db = seedStarvedStore(4);
    try {
      // Fewer rows than the limit with no filter is an exhausted corpus,
      // not a starved filter: byte-identical answer, no notice.
      const all = semanticTopK(db, true, QUERY, { limit: 10 });
      expect(all).toHaveLength(4);
      expect(stderr).not.toHaveBeenCalled();
    } finally {
      db.close();
    }
  });
});
