/**
 * Kind and promoted-key filter pushdown on the query path (recall-quality,
 * task C4).
 *
 * Two filters move from post-rank row drops into the lanes' SQL:
 *
 *   - `kind` - the v14 `chunks.chunk_kind` column (written by the indexer;
 *     'page' is the page-head chunk). The keyword
 *     lane takes it into the WHERE clause before ORDER BY/LIMIT; the
 *     semantic lane filters beside the path predicate, inside the same 4x
 *     KNN overfetch the prefix branch has always shared.
 *   - the promoted property keys - `type` (documents.page_type, values
 *     normalized via `normalizeSchemaToken`), `pinned` (documents.pinned,
 *     pushed only for the unambiguous "true" spelling) and `visibility`
 *     (the JSON column via `json_each`). Their values are pushed AS
 *     INDEXED, matched in their stored canonical form.
 *
 * `tags` does NOT push (recall-quality review): the only tag rows the
 * index stores are the inline #hashtag links - frontmatter is stripped
 * before chunking, so `links.link_type = 'tag'` never sees a frontmatter
 * tag - while the live filter reads frontmatter `tags`. Pushing answered
 * a corpus the live filter never reads and dropped frontmatter-tagged
 * notes, so `tags` stays a post-rank live-file filter. Every UNPROMOTED
 * key stays post-rank too, and the promoted half also re-judges the
 * traversal-arm candidates (searchType "link") that never met the lanes'
 * SQL.
 *
 * Pinned here: the SQL builders' default and prefix-only strings are
 * byte-identical to pre-C4 (an absent filter never rewrites a query), a
 * mixed filter map pushes only its promoted half while the pool keeps the
 * overfetch for the rest, and the cache key grows for `kind`.
 */

import { Database } from "bun:sqlite";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import {
  ATTRIBUTE_MAX_KEYS_PER_DOCUMENT,
  applyMigrations,
  ensureVecTable,
} from "../../../src/core/search/schema.ts";
import { search } from "../../../src/core/search/search.ts";
import {
  buildCacheKey,
  canonicalAttributeNarrowing,
} from "../../../src/core/search/query-cache.ts";
import { keywordTopK, keywordTopKSql } from "../../../src/core/search/store/keyword.ts";
import { semanticTopK, semanticTopKSql } from "../../../src/core/search/store/vectors.ts";
import { resolvePoolFilters } from "../../../src/core/search/pipeline/pool-filters.ts";
import {
  isSearchKind,
  resolveKindFilter,
  resolvePropertyPushdown,
} from "../../../src/core/search/property-pushdown.ts";
import { SearchError } from "../../../src/core/search/search-error.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const VEC_AVAILABLE = sqliteVecLoadable();

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("kind-pushdown"));
});
afterEach(() => cleanup());

function note(name: string, frontmatter: string, body: string): string {
  return `---\n${frontmatter}---\n\n# ${name}\n\n${body}`;
}

/** Index the shared fixture: four pages with distinct promoted-key shapes. */
async function seedVault(): Promise<void> {
  writeMd(
    vault,
    "notes/note-a.md",
    note(
      "Note A",
      "type: note\nstatus: active\npinned: true\nvisibility: [public]\n",
      "lattice delta anchor\n\n## Deeper\n\nlattice payload section",
    ),
  );
  writeMd(
    vault,
    "notes/note-b.md",
    note("Note B", "type: report\nstatus: active\ntags: [urgent]\n", "lattice delta report"),
  );
  writeMd(vault, "notes/note-c.md", note("Note C", "status: archived\n", "lattice delta archive"));
  writeMd(
    vault,
    "projects/plan.md",
    note("Plan", "type: note\nstatus: active\n", "lattice delta plan #urgent"),
  );
  // A genuinely split document: the Deeper sections are padded past the
  // chunker's budget so they land in real section chunks, with a term
  // ("kiln") that exists only in a section body - never in the page head
  // or a heading the section context would carry.
  const filler = Array.from(
    { length: 400 },
    (_, i) => `kiln row ${i} padding the section body`,
  ).join("\n");
  writeMd(
    vault,
    "notes/deep.md",
    note(
      "Deep",
      "type: report\n",
      "lattice delta deep head\n\n## First\n\nlattice payload section\n\n" +
        `## Bay Two\n\nkiln charge one\n\n${filler}\n\nkiln charge two`,
    ),
  );
  await indexVault(makeConfig({ vault, dbPath }));
}

/**
 * A linked pair for the traversal-arm gate: alpha (type note) links bravo
 * (type report), whose body never matches the query - so bravo can only
 * enter the pool through link expansion, never through a lane's SQL.
 */
async function seedLinkedVault(): Promise<void> {
  writeMd(
    vault,
    "linked/alpha.md",
    note("Alpha", "type: note\nstatus: active\n", "delta bridge anchor\n\nsee [[linked/bravo.md]]"),
  );
  writeMd(
    vault,
    "linked/bravo.md",
    note("Bravo", "type: report\nstatus: active\n", "unrelated inventory body"),
  );
  await indexVault(makeConfig({ vault, dbPath }));
}

describe("SQL builders keep the default strings byte-identical", () => {
  test("keyword lane: no filters and prefix-only are the pre-C4 strings", () => {
    expect(keywordTopKSql({})).toBe(
      "SELECT c.id AS chunk_id, c.document_id AS document_id, bm25(chunk_fts, 1.0, 0.3) AS bm25 " +
        "FROM chunk_fts JOIN chunks c ON c.id = chunk_fts.rowid " +
        "WHERE chunk_fts MATCH ? ORDER BY bm25 ASC, chunk_id ASC LIMIT ?",
    );
    expect(keywordTopKSql({ pathPrefix: "notes" })).toBe(
      "SELECT c.id AS chunk_id, c.document_id AS document_id, bm25(chunk_fts, 1.0, 0.3) AS bm25 " +
        "FROM chunk_fts " +
        "JOIN chunks c ON c.id = chunk_fts.rowid " +
        "JOIN documents d ON d.id = c.document_id " +
        "WHERE chunk_fts MATCH ? AND d.path >= ? AND d.path < ? ORDER BY bm25 ASC, chunk_id ASC LIMIT ?",
    );
  });

  test("semantic lane: no filters and prefix-only are the pre-C4 strings", () => {
    expect(semanticTopKSql({})).toBe(
      "SELECT m.chunk_id AS chunk_id, c.document_id AS document_id, v.distance AS distance " +
        "FROM chunk_vec v " +
        "JOIN chunk_vec_map m ON m.vec_rowid = v.rowid " +
        "JOIN chunks c ON c.id = m.chunk_id " +
        "WHERE v.embedding MATCH ? AND k = ? ORDER BY v.distance ASC, m.chunk_id ASC",
    );
    expect(semanticTopKSql({ pathPrefix: "notes" })).toBe(
      "SELECT m.chunk_id AS chunk_id, c.document_id AS document_id, v.distance AS distance " +
        "FROM chunk_vec v " +
        "JOIN chunk_vec_map m ON m.vec_rowid = v.rowid " +
        "JOIN chunks c ON c.id = m.chunk_id " +
        "JOIN documents d ON d.id = c.document_id " +
        "WHERE v.embedding MATCH ? AND k = ? AND d.path >= ? AND d.path < ? " +
        "ORDER BY v.distance ASC, m.chunk_id ASC",
    );
  });

  test("kind lands in the WHERE clause before ORDER BY/LIMIT on the keyword lane", () => {
    const sql = keywordTopKSql({ kind: "section" });
    const where = sql.indexOf("WHERE");
    const kindPredicate = sql.indexOf("c.chunk_kind = ?");
    const order = sql.indexOf("ORDER BY");
    expect(kindPredicate).toBeGreaterThan(where);
    expect(kindPredicate).toBeLessThan(order);
    expect(sql).toContain("JOIN documents d ON d.id = c.document_id");
  });

  test("pushed predicates compose beside kind and the prefix", () => {
    const pushdown = resolvePropertyPushdown(
      new Map([
        ["type", ["Note"]],
        ["pinned", ["true"]],
        ["visibility", ["Public"]],
      ]),
    );
    expect(pushdown.fallback).toBeNull();
    const frag = pushdown.pushdown;
    expect(frag).not.toBeNull();
    const sql = keywordTopKSql({ pathPrefix: "notes", kind: "page", pushdown: frag! });
    const where = sql.indexOf("WHERE");
    for (const marker of [
      "d.path >= ?",
      "d.page_type IN (?)",
      "d.pinned = 1",
      "json_each(d.visibility)",
      "c.chunk_kind = ?",
    ]) {
      const at = sql.indexOf(marker);
      expect(at).toBeGreaterThan(where);
      expect(at).toBeLessThan(sql.indexOf("ORDER BY"));
    }
  });
});

describe("the promoted-key split", () => {
  test("pushes the promoted half and keeps unpromoted keys post-rank", () => {
    const split = resolvePropertyPushdown(
      new Map([
        ["type", ["note"]],
        ["status", ["active"]],
      ]),
    );
    // The unpromoted half also narrows candidates against the attributes
    // side table while keeping its post-rank arbiter (narrowing wave).
    expect(split.pushdown).toEqual({
      pageTypes: ["note"],
      attributeNarrowing: [{ key: "status", values: ["active"] }],
    });
    expect(split.fallback).not.toBeNull();
    expect([...split.fallback!.keys()]).toEqual(["status"]);
  });

  test("a fully promoted map leaves nothing post-rank", () => {
    const split = resolvePropertyPushdown(new Map([["pinned", ["true"]]]));
    expect(split.pushdown).toEqual({ pinned: true });
    expect(split.fallback).toBeNull();
  });

  test("an unpushable promoted spelling falls back instead of diverging", () => {
    // `pinned: ["false"]` cannot be pushed: the column folds absent and
    // false together, so the live filter must judge.
    const split = resolvePropertyPushdown(new Map([["pinned", ["false"]]]));
    expect(split.pushdown).toBeNull();
    expect([...split.fallback!.keys()]).toEqual(["pinned"]);
  });

  test("type and visibility values normalize to the stored token form", () => {
    const split = resolvePropertyPushdown(
      new Map([
        ["type", ["  Note  "]],
        ["visibility", [" Public "]],
      ]),
    );
    expect(split.pushdown).toEqual({ pageTypes: ["note"], visibilityTokens: ["public"] });
  });

  test("absent and empty maps push nothing", () => {
    expect(resolvePropertyPushdown(undefined).pushdown).toBeNull();
    expect(resolvePropertyPushdown(new Map()).pushdown).toBeNull();
    expect(resolvePropertyPushdown(new Map()).fallback).toBeNull();
  });

  test("the pool keeps the overfetch for a mixed map and drops it when fully pushed", () => {
    const mixed = resolvePoolFilters({
      query: "delta",
      properties: new Map([
        ["type", ["note"]],
        ["status", ["active"]],
      ]),
    });
    expect(mixed.canDropRows).toBe(true);
    expect([...mixed.properties!.keys()]).toEqual(["status"]);
    const allPromoted = resolvePoolFilters({
      query: "delta",
      properties: new Map([["type", ["note"]]]),
    });
    expect(allPromoted.canDropRows).toBe(false);
    expect(allPromoted.properties).toBeNull();
  });
});

describe("kind validation", () => {
  test("accepts the two chunk kinds and refuses the rest", () => {
    expect(resolveKindFilter("page")).toBe("page");
    expect(resolveKindFilter("section")).toBe("section");
    expect(resolveKindFilter(undefined)).toBeUndefined();
    expect(() => resolveKindFilter("headings")).toThrow(SearchError);
    expect(isSearchKind("page")).toBe(true);
    expect(isSearchKind("headline")).toBe(false);
  });
});

describe("kind pushdown on the keyword lane", () => {
  test("kind=page returns chunk 0 rows only; kind=section returns the rest", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(db);
      const docId = db
        .query<{ id: number }, []>(
          "INSERT INTO documents(path, content_hash, mtime, size, created_at, updated_at, indexed_at) " +
            "VALUES ('notes/a.md', 'h', 0, 0, 'n', 'n', 'n') RETURNING id",
        )
        .get()!.id;
      for (const [index, text, kind] of [
        [0, "lattice delta anchor head", "page"],
        [1, "lattice delta payload section", "section"],
      ] as const) {
        db.query(
          "INSERT INTO chunks(document_id, chunk_index, chunk_kind, content, fts_content, content_hash, start_line, end_line, token_count, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, ?, 1, 1, 3, 'n', 'n')",
        ).run(docId, index, kind, text, text, `h${index}`);
      }
      const pages = keywordTopK(db, '"delta"', { limit: 10, kind: "page" });
      const sections = keywordTopK(db, '"delta"', { limit: 10, kind: "section" });
      const index = (chunkId: number): number =>
        db
          .query<{ ci: number }, [number]>("SELECT chunk_index AS ci FROM chunks WHERE id = ?")
          .get(chunkId)!.ci;
      expect(pages.length).toBe(1);
      expect(index(pages[0]!.chunkId)).toBe(0);
      expect(sections.length).toBe(1);
      expect(index(sections[0]!.chunkId)).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe.skipIf(!VEC_AVAILABLE)("kind and pushdown on the semantic lane", () => {
  test("the post-KNN filter runs inside the overfetch", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(db);
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const vec = require("sqlite-vec") as { getLoadablePath(): string };
      db.loadExtension(vec.getLoadablePath());
      ensureVecTable(db, 4);
      const vector = new Float32Array([0.5, 0.1, 0.1, 0.1]);
      for (const [path, pageIndex, type] of [
        ["notes/a.md", 0, "note"],
        ["notes/b.md", 0, "report"],
      ] as const) {
        const docId = db
          .query<{ id: number }, [string, string]>(
            "INSERT INTO documents(path, page_type, content_hash, mtime, size, created_at, updated_at, indexed_at) " +
              "VALUES (?, ?, 'h', 0, 0, 'n', 'n', 'n') RETURNING id",
          )
          .get(path, type)!.id;
        const row = db
          .query<{ id: number }, [number]>(
            "INSERT INTO chunks(document_id, chunk_index, chunk_kind, content, fts_content, content_hash, start_line, end_line, token_count, created_at, updated_at) " +
              "VALUES (?, 0, 'page', 'x', 'x', 'h', 1, 1, 1, 'n', 'n') RETURNING id",
          )
          .get(docId)!;
        db.query(
          "INSERT INTO chunk_vec(rowid, embedding) VALUES (?, x'0000803f0000803f0000803f0000803f')",
        ).run(row.id);
        db.query("INSERT INTO chunk_vec_map(chunk_id, vec_rowid) VALUES (?, ?)").run(
          row.id,
          row.id,
        );
        void pageIndex;
        void vector;
      }
      const all = semanticTopK(db, true, vector, { limit: 10 });
      expect(all.length).toBe(2);
      const notes = semanticTopK(db, true, vector, {
        limit: 10,
        pushdown: { pageTypes: ["note"] },
      });
      expect(notes.length).toBe(1);
      const kinded = semanticTopK(db, true, vector, { limit: 10, kind: "page" });
      expect(kinded.length).toBe(2);
      const none = semanticTopK(db, true, vector, { limit: 10, kind: "section" });
      expect(none.length).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("end-to-end over an indexed vault", () => {
  test("kind:page finds the page head of a frontmatter note, not its YAML block", async () => {
    const cfg = makeConfig({ vault, dbPath });
    await seedVault();
    // The page head of note-a is chunk 1 - the intro ("lattice delta anchor"
    // sits there; the YAML block at chunk 0 is a section-under-the-head no
    // longer). Before the structural kind, kind:page answered only the YAML
    // chunk and a note's intro was unreachable through the page filter.
    const pages = await search(cfg, {
      query: "anchor",
      kind: "page",
      keywordOnly: true,
      visibility: ["public"],
    });
    expect(pages.results.map((r) => r.path)).toEqual(["notes/note-a.md"]);
    expect(pages.results.every((r) => !r.content.startsWith("---"))).toBe(true);
  });

  test("kind scopes the answer to page or section chunks", async () => {
    const cfg = makeConfig({ vault, dbPath });
    await seedVault();
    // "kiln" exists only in deep.md's section bodies - never in its page
    // head or a heading the section context could carry.
    const sections = await search(cfg, {
      query: "kiln",
      kind: "section",
      keywordOnly: true,
      visibility: ["public"],
    });
    expect(sections.results.length).toBeGreaterThan(0);
    expect(sections.results.every((r) => r.path === "notes/deep.md")).toBe(true);
    expect(sections.results.every((r) => r.content.includes("kiln"))).toBe(true);
    const pages = await search(cfg, {
      query: "kiln",
      kind: "page",
      keywordOnly: true,
      visibility: ["public"],
    });
    // The second pass answers at the document level: a kiln hit in a
    // section may surface deep.md's page head, but it never surfaces a
    // document whose own chunks did not match.
    expect(pages.results.every((r) => r.path === "notes/deep.md")).toBe(true);
  });

  test("promoted type pushes as the stored normalized token", async () => {
    const cfg = makeConfig({ vault, dbPath });
    await seedVault();
    const notes = await search(cfg, {
      query: "delta",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([["type", ["Note"]]]),
    });
    expect(notes.results.map((r) => r.path).toSorted()).toEqual([
      "notes/note-a.md",
      "projects/plan.md",
    ]);
  });

  test("promoted pinned and visibility push through their storage", async () => {
    const cfg = makeConfig({ vault, dbPath });
    await seedVault();
    const pinned = await search(cfg, {
      query: "delta",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([["pinned", ["true"]]]),
    });
    expect(pinned.results.map((r) => r.path)).toEqual(["notes/note-a.md"]);
    const visible = await search(cfg, {
      query: "delta",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([["visibility", ["public"]]]),
    });
    expect(visible.results.map((r) => r.path)).toEqual(["notes/note-a.md"]);
  });

  test("a tags filter answers the live frontmatter, not the inline-hashtag links", async () => {
    // The only tag rows the index stores are the inline #hashtags (frontmatter
    // is stripped before chunking, so `links.link_type = 'tag'` never sees a
    // frontmatter tag) - pushing a tags EXISTS answered a corpus the live
    // filter never reads and dropped frontmatter-tagged notes. Demoted to the
    // post-rank live filter, the arbiter: the frontmatter-tagged note-b
    // resolves, and plan.md - whose #urgent is inline only, so its
    // frontmatter has no `tags` key at all - is correctly excluded.
    const cfg = makeConfig({ vault, dbPath });
    await seedVault();
    const tagged = await search(cfg, {
      query: "delta",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([["tags", ["urgent"]]]),
    });
    expect(tagged.results.map((r) => r.path)).toEqual(["notes/note-b.md"]);
  });

  test("the tags key never pushes: it stays in the post-rank fallback half", () => {
    const split = resolvePropertyPushdown(new Map([["tags", ["urgent"]]]));
    expect(split.pushdown).toBeNull();
    expect(split.promoted).toBeNull();
    expect([...split.fallback!.keys()]).toEqual(["tags"]);
    const sql = keywordTopKSql({
      pathPrefix: "notes",
      pushdown: { pageTypes: ["note"] },
    });
    expect(sql).not.toContain("ptag");
    expect(sql).not.toContain("link_type");
  });

  test("the pushed type clause keeps the rows the column cannot speak for", () => {
    const sql = keywordTopKSql({ pushdown: { pageTypes: ["report"] } });
    expect(sql).toContain("(d.page_type IN (?) OR d.page_type IS NULL)");
  });

  test("a mixed map filters by both halves: promoted in SQL, the rest post-rank", async () => {
    const cfg = makeConfig({ vault, dbPath });
    await seedVault();
    const both = await search(cfg, {
      query: "delta",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([
        ["type", ["note"]],
        ["status", ["active"]],
      ]),
    });
    expect(both.results.map((r) => r.path).toSorted()).toEqual([
      "notes/note-a.md",
      "projects/plan.md",
    ]);
    const archived = await search(cfg, {
      query: "delta",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([
        ["type", ["note"]],
        ["status", ["archived"]],
      ]),
    });
    expect(archived.results).toEqual([]);
  });

  test("an unpromoted key keeps the live-file post-rank path", async () => {
    const cfg = makeConfig({ vault, dbPath });
    await seedVault();
    const active = await search(cfg, {
      query: "delta",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([["status", ["active"]]]),
    });
    expect(active.results.map((r) => r.path).toSorted()).toEqual([
      "notes/note-a.md",
      "notes/note-b.md",
      "projects/plan.md",
    ]);
  });
});

describe("the promoted filter gates traversal-arm candidates", () => {
  test("a type filter drops a link-expanded note of another kind", async () => {
    const cfg = makeConfig({ vault, dbPath });
    await seedLinkedVault();
    // Default maxHops is 1: bravo matches nothing, so the ONLY way it can
    // surface is link expansion off alpha - a candidate source the lanes'
    // SQL never judged. The live property filter must gate it anyway.
    const filtered = await search(cfg, {
      query: "delta",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([["type", ["note"]]]),
    });
    expect(filtered.results.map((r) => r.path)).toEqual(["linked/alpha.md"]);
  });

  test("without the filter the expansion still surfaces (the gate is the filter's)", async () => {
    const cfg = makeConfig({ vault, dbPath });
    await seedLinkedVault();
    const unfiltered = await search(cfg, {
      query: "delta",
      keywordOnly: true,
      visibility: ["public"],
    });
    expect(unfiltered.results.map((r) => r.path)).toContain("linked/bravo.md");
  });
});

/**
 * A mixed-shape corpus for the type pushdown's conditional faithfulness:
 * `documents.page_type` is written only for scalar-STRING frontmatter, so
 * an array, a number, a null or an object `type` leaves the column NULL
 * and the SQL cannot reproduce the live filter's verdict for them. Those
 * rows must stay post-rank (the live filter is the arbiter); only the
 * scalar-string shape answers as-indexed.
 */
async function seedMixedShapeVault(): Promise<void> {
  writeMd(vault, "mixed/string.md", note("String", "type: report\n", "delta scalar verdict"));
  writeMd(vault, "mixed/array.md", note("Array", "type: [report, misc]\n", "delta array verdict"));
  writeMd(vault, "mixed/number.md", note("Number", "type: 42\n", "delta numeric verdict"));
  writeMd(vault, "mixed/null.md", note("Null", "type:\n", "delta null verdict"));
  writeMd(vault, "mixed/absent.md", note("Absent", "status: active\n", "delta untyped verdict"));
  await indexVault(makeConfig({ vault, dbPath }));
}

describe("the type pushdown is shape-faithful over a mixed-shape corpus", () => {
  test("an array-typed page survives a filter naming one of its elements", async () => {
    // The defect: page_type is NULL for `type: [report, misc]`, so the bare
    // IN dropped a page the live filter matches element-wise.
    const cfg = makeConfig({ vault, dbPath });
    await seedMixedShapeVault();
    const reports = await search(cfg, {
      query: "delta",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([["type", ["report"]]]),
    });
    expect(reports.results.map((r) => r.path).toSorted()).toEqual([
      "mixed/array.md",
      "mixed/string.md",
    ]);
  });

  test("a numeric-looking scalar answers as-indexed through its stored token", async () => {
    // This parser keeps YAML scalars as strings, so `type: 42` stores
    // page_type "42" - a scalar shape the SQL reproduces exactly.
    const cfg = makeConfig({ vault, dbPath });
    await seedMixedShapeVault();
    const numeric = await search(cfg, {
      query: "delta",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([["type", ["42"]]]),
    });
    expect(numeric.results.map((r) => r.path)).toEqual(["mixed/number.md"]);
  });

  test("absent and null types stay excluded - the live filter's own verdict", async () => {
    const cfg = makeConfig({ vault, dbPath });
    await seedMixedShapeVault();
    for (const accepted of [["report"], ["42"], ["misc"]] as const) {
      const out = await search(cfg, {
        query: "delta",
        keywordOnly: true,
        visibility: ["public"],
        properties: new Map([["type", [...accepted]]]),
      });
      expect(out.results.map((r) => r.path)).not.toContain("mixed/absent.md");
      expect(out.results.map((r) => r.path)).not.toContain("mixed/null.md");
    }
  });
});

describe("the query cache key grows for kind", () => {
  const base = { query: "delta", limit: 5 };
  test("a kind partitions the key; absent stays byte-identical", () => {
    const plain = buildCacheKey(base, "plan", "cfg");
    const page = buildCacheKey({ ...base, kind: "page" }, "plan", "cfg");
    const section = buildCacheKey({ ...base, kind: "section" }, "plan", "cfg");
    const pageAgain = buildCacheKey({ ...base, kind: "page" }, "plan", "cfg");
    expect(page).not.toBe(plain);
    expect(section).not.toBe(page);
    expect(pageAgain).toBe(page);
  });
});

describe("the MCP and CLI surfaces", () => {
  test("brain_search advertises the kind enum", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildToolTable, findTool } = require("../../../src/mcp/tools.ts") as {
      buildToolTable(scope: string): ReturnType<typeof findTool>[];
      findTool(
        tools: unknown[],
        name: string,
      ): {
        inputSchema: { properties: Record<string, { enum?: string[] }> };
      };
    };
    const tool = findTool(buildToolTable("full") as unknown[], "brain_search");
    const kind = tool.inputSchema.properties["kind"]!;
    expect(kind).toBeDefined();
    expect(kind.enum).toEqual(["page", "section"]);
  });

  test("brain_search maps the kind argument onto the search options", async () => {
    await seedVault();
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildToolTable, findTool } = require("../../../src/mcp/tools.ts") as {
      buildToolTable(scope: string): { name: string; handler: unknown }[];
      findTool(
        tools: unknown[],
        name: string,
      ): {
        handler: (ctx: unknown, args: Record<string, unknown>) => Promise<Record<string, unknown>>;
      };
    };
    const tool = findTool(buildToolTable("full") as unknown[], "brain_search");
    const configPath = writeMcpConfig(vault);
    const ctx = { vault, configPath, repoRoot: null };
    const out = (await tool.handler(ctx, {
      query: "payload",
      keyword_only: true,
      visibility: ["public"],
      kind: "section",
    })) as { results: ReadonlyArray<{ path: string }> };
    // "payload" in note-a lives in the page-head chunk; the section-scoped
    // answer is deep.md's padded First section.
    expect(out.results.map((r) => r.path)).toEqual(["notes/deep.md"]);
  });

  test("brain_search refuses an unknown kind before any store I/O", async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { buildToolTable, findTool } = require("../../../src/mcp/tools.ts") as {
      buildToolTable(scope: string): unknown[];
      findTool(
        tools: unknown[],
        name: string,
      ): { handler: (ctx: unknown, args: Record<string, unknown>) => Promise<unknown> };
    };
    const tool = findTool(buildToolTable("full") as unknown[], "brain_search");
    await expect(
      tool.handler({ vault, configPath: null, repoRoot: null }, { query: "x", kind: "heading" }),
    ).rejects.toThrow(/kind/);
  });

  test("the CLI verb accepts --kind and refuses an unknown one", async () => {
    await seedVault();
    const { cmdSearchQuery } = await import("../../../src/cli/search/verbs/query.ts");
    await expect(
      cmdSearchQuery(["--vault", vault, "--db", dbPath, "--kind", "heading", "delta"]),
    ).rejects.toThrow(/--kind/);
    const code = await cmdSearchQuery([
      "--vault",
      vault,
      "--db",
      dbPath,
      "--json",
      "--keyword-only",
      "--kind",
      "section",
      "payload",
    ]);
    expect(code).toBe(0);
  });
});

describe("the unpromoted attribute narrowing (document_attributes)", () => {
  test("the split keeps unpromoted keys in the live fallback AND compiles them to narrowing", () => {
    const split = resolvePropertyPushdown(new Map([["status", ["active"]]]));
    // The live post-rank filter stays the arbiter: the key remains in the
    // fallback half, so the pool keeps its property-filter overfetch and
    // every surfaced row is re-judged against the live file.
    expect(split.fallback).not.toBeNull();
    expect([...split.fallback!.keys()]).toEqual(["status"]);
    expect(split.pushdown).toEqual({
      attributeNarrowing: [{ key: "status", values: ["active"] }],
    });
  });

  test("an unpushable promoted spelling never becomes narrowing", () => {
    // The attributes side table skips the promoted keys entirely, so a
    // promoted key has no narrowing rows to read: it stays a pure
    // post-rank filter, exactly as before the narrowing existed.
    const split = resolvePropertyPushdown(new Map([["pinned", ["false"]]]));
    expect(split.pushdown).toBeNull();
    expect([...split.fallback!.keys()]).toEqual(["pinned"]);
  });

  test("absent and empty maps narrow nothing", () => {
    expect(resolvePropertyPushdown(undefined).pushdown).toBeNull();
    expect(resolvePropertyPushdown(new Map()).pushdown).toBeNull();
    expect(resolvePropertyPushdown(new Map()).fallback).toBeNull();
  });

  test("the keyword lane WHERE gains the attributes EXISTS; the default string stays byte-identical", () => {
    expect(keywordTopKSql({})).not.toContain("document_attributes");
    const sql = keywordTopKSql({
      pushdown: { attributeNarrowing: [{ key: "status", values: ["active", "draft"] }] },
    });
    const where = sql.indexOf("WHERE");
    const exists = sql.indexOf("document_attributes");
    expect(exists).toBeGreaterThan(where);
    expect(exists).toBeLessThan(sql.indexOf("ORDER BY"));
    expect(sql).toContain("an0.key = ?");
    expect(sql).toContain("NOT EXISTS");
  });

  test("the lane narrows provable mismatches and keeps documents the table cannot speak for", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(db);
      const insertDoc = db.query<{ id: number }, [string]>(
        "INSERT INTO documents(path, content_hash, mtime, size, created_at, updated_at, indexed_at) " +
          "VALUES (?, 'h', 0, 0, 'n', 'n', 'n') RETURNING id",
      );
      const insertChunk = db.query(
        "INSERT INTO chunks(document_id, chunk_index, content, fts_content, content_hash, start_line, end_line, token_count, created_at, updated_at) " +
          "VALUES (?, 0, ?, ?, 'h', 1, 1, 3, 'n', 'n')",
      );
      const insertAttr = db.query(
        "INSERT OR IGNORE INTO document_attributes(document_id, key, value) VALUES (?, ?, ?)",
      );
      const doc = (path: string, text: string): number => {
        const id = insertDoc.get(path)!.id;
        insertChunk.run(id, text, text);
        return id;
      };
      const a = doc("notes/a.md", "lattice delta active");
      insertAttr.run(a, "status", "active");
      const b = doc("notes/b.md", "lattice delta archived");
      insertAttr.run(b, "status", "archived");
      // No attribute rows at all: the table cannot speak for this document.
      const c = doc("notes/c.md", "lattice delta plain");
      // Attributes at the key bound: the table holds key00..key63 and the
      // frontmatter may have declared more, so key63 has no stored verdict.
      const d = doc("notes/d.md", "lattice delta overflow");
      for (let i = 0; i < ATTRIBUTE_MAX_KEYS_PER_DOCUMENT; i++) {
        insertAttr.run(d, `key${String(i).padStart(2, "0")}`, `v${i}`);
      }

      const all = keywordTopK(db, '"delta"', { limit: 10 });
      expect(all.length).toBe(4);
      const narrowed = keywordTopK(db, '"delta"', {
        limit: 10,
        pushdown: { attributeNarrowing: [{ key: "status", values: ["active"] }] },
      });
      // b is a provable mismatch (stored rows, none accepted) and drops out
      // in SQL; a matches a stored row; c and d stay candidates because the
      // table cannot speak for them - the live post-rank filter decides
      // their fate over a pool one candidate smaller.
      expect(narrowed.length).toBe(3);
      expect(narrowed.map((h) => h.documentId)).not.toContain(b);
      expect(narrowed.map((h) => h.documentId).toSorted()).toEqual([a, c, d].toSorted());
      const unspoken = keywordTopK(db, '"delta"', {
        limit: 10,
        pushdown: { attributeNarrowing: [{ key: "key63", values: ["v63"] }] },
      });
      // key63 is over the bound: no document carries a stored verdict for
      // it, so SQL alone may drop nothing.
      expect(unspoken.length).toBe(4);
    } finally {
      db.close();
    }
  });

  test("end-to-end: narrowed candidates keep the post-rank-only answers and an over-bound key resolves live", async () => {
    const cfg = makeConfig({ vault, dbPath });
    writeMd(vault, "notes/note-a.md", note("Note A", "status: active\n", "lattice delta anchor"));
    writeMd(vault, "notes/note-b.md", note("Note B", "status: archived\n", "lattice delta report"));
    writeMd(vault, "notes/note-c.md", "# Note C\n\nlattice delta archive");
    const keys = Array.from({ length: 70 }, (_, i) => `key${String(i).padStart(2, "0")}: v${i}`);
    writeMd(vault, "notes/wide.md", `---\n${keys.join("\n")}\n---\n\n# Wide\n\nlattice delta wide`);
    await indexVault(cfg);

    // Differential pin: the answer equals the post-rank-only set - note-b
    // is narrowed away in SQL (provable mismatch), note-c only ever falls
    // to the live filter, and note-a passes both.
    const active = await search(cfg, {
      query: "delta",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([["status", ["active"]]]),
    });
    expect(active.results.map((r) => r.path)).toEqual(["notes/note-a.md"]);

    // The 65th key is past the 64-key bound: the table holds no verdict for
    // it, so the narrowing keeps wide.md and the live filter resolves it.
    const over = await search(cfg, {
      query: "delta",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([["key64", ["v64"]]]),
    });
    expect(over.results.map((r) => r.path)).toEqual(["notes/wide.md"]);

    // AND across keys: no document satisfies both halves.
    const none = await search(cfg, {
      query: "delta",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([
        ["status", ["active"]],
        ["key64", ["v64"]],
      ]),
    });
    expect(none.results).toEqual([]);
  });
});

describe("the query cache key grows for unpromoted attribute filters", () => {
  const base = { query: "delta", limit: 5 };
  test("the narrowing fold is present only for unpromoted keys", () => {
    expect(canonicalAttributeNarrowing(undefined)).toBeNull();
    expect(canonicalAttributeNarrowing(new Map())).toBeNull();
    expect(canonicalAttributeNarrowing(new Map([["type", ["note"]]]))).toBeNull();
    expect(canonicalAttributeNarrowing(new Map([["pinned", ["false"]]]))).toBeNull();
    expect(
      canonicalAttributeNarrowing(
        new Map([
          ["priority", ["3"]],
          ["status", ["active", "draft"]],
        ]),
      ),
    ).toEqual([
      { key: "priority", values: ["3"] },
      { key: "status", values: ["active", "draft"] },
    ]);
  });

  test("an unpromoted filter partitions the key and stays order-independent", () => {
    const status = buildCacheKey(
      { ...base, properties: new Map([["status", ["active"]]]) },
      "plan",
      "cfg",
    );
    expect(buildCacheKey(base, "plan", "cfg")).not.toBe(status);
    expect(
      buildCacheKey({ ...base, properties: new Map([["status", ["active"]]]) }, "plan", "cfg"),
    ).toBe(status);
    const both = buildCacheKey(
      {
        ...base,
        properties: new Map([
          ["status", ["active"]],
          ["priority", ["3"]],
        ]),
      },
      "plan",
      "cfg",
    );
    const reordered = buildCacheKey(
      {
        ...base,
        properties: new Map([
          ["priority", ["3"]],
          ["status", ["active"]],
        ]),
      },
      "plan",
      "cfg",
    );
    expect(both).toBe(reordered);
  });
});

/** A minimal config file inside the vault, for the MCP handler's resolver. */
function writeMcpConfig(vaultDir: string): string {
  const configPath = join(vaultDir, ".o2b-test-config.yaml");
  writeFileSync(configPath, 'search_recency_amplitude: "0"\n');
  return configPath;
}
