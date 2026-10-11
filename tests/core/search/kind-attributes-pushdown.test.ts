/**
 * Kind and promoted-key filter pushdown on the query path (recall-quality,
 * task C4).
 *
 * Two filters move from post-rank row drops into the lanes' SQL:
 *
 *   - `kind` - the v14 `chunks.chunk_kind` generated column. The keyword
 *     lane takes it into the WHERE clause before ORDER BY/LIMIT; the
 *     semantic lane filters beside the path predicate, inside the same 4x
 *     KNN overfetch the prefix branch has always shared.
 *   - the promoted property keys - `type` (documents.page_type, values
 *     normalized via `normalizeSchemaToken`), `tags` (the tag-link EXISTS),
 *     `pinned` (documents.pinned, pushed only for the unambiguous "true"
 *     spelling) and `visibility` (the JSON column via `json_each`). Their
 *     values are pushed AS INDEXED: `type` and `visibility` are matched in
 *     their stored canonical form, and `tags` matches the tag corpus the
 *     index holds (the inline tag links), not the live file - the same
 *     as-indexed vs as-on-disk divergence every other indexed facet has.
 *     Every UNPROMOTED key stays a post-rank live-file filter.
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
import { applyMigrations, ensureVecTable } from "../../../src/core/search/schema.ts";
import { search } from "../../../src/core/search/search.ts";
import { buildCacheKey } from "../../../src/core/search/query-cache.ts";
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
      "lattice delta anchor\n\n## Deeper\n\nlattice delta payload section",
    ),
  );
  writeMd(
    vault,
    "notes/note-b.md",
    note("Note B", "type: report\nstatus: active\n", "lattice delta report"),
  );
  writeMd(vault, "notes/note-c.md", note("Note C", "status: archived\n", "lattice delta archive"));
  writeMd(
    vault,
    "projects/plan.md",
    note("Plan", "type: note\nstatus: active\n", "lattice delta plan #urgent"),
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
        ["tags", ["urgent"]],
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
      "ptag.link_type = 'tag'",
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
    expect(split.pushdown).toEqual({ pageTypes: ["note"] });
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
        .query<{ id: number }, [string]>(
          "INSERT INTO documents(path, content_hash, mtime, size, created_at, updated_at, indexed_at) " +
            "VALUES ('notes/a.md', 'h', 0, 0, 'n', 'n', 'n') RETURNING id",
        )
        .get()!.id;
      for (const [index, text] of [
        [0, "lattice delta anchor head"],
        [1, "lattice delta payload section"],
      ] as const) {
        db.query(
          "INSERT INTO chunks(document_id, chunk_index, content, fts_content, content_hash, start_line, end_line, token_count, created_at, updated_at) " +
            "VALUES (?, ?, ?, ?, ?, 1, 1, 3, 'n', 'n')",
        ).run(docId, index, text, text, `h${index}`);
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
            "INSERT INTO chunks(document_id, chunk_index, content, fts_content, content_hash, start_line, end_line, token_count, created_at, updated_at) " +
              "VALUES (?, 0, 'x', 'x', 'h', 1, 1, 1, 'n', 'n') RETURNING id",
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
  test("kind scopes the answer to page or section chunks", async () => {
    const cfg = makeConfig({ vault, dbPath });
    await seedVault();
    // "payload" exists only in note-a's section chunk.
    const sections = await search(cfg, {
      query: "payload",
      kind: "section",
      keywordOnly: true,
      visibility: ["public"],
    });
    expect(sections.results.length).toBeGreaterThan(0);
    expect(sections.results.every((r) => r.path === "notes/note-a.md")).toBe(true);
    expect(sections.results.every((r) => r.content.includes("payload"))).toBe(true);
    const pages = await search(cfg, {
      query: "payload",
      kind: "page",
      keywordOnly: true,
      visibility: ["public"],
    });
    expect(pages.results.length).toBe(0);
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

  test("promoted pinned, visibility and tags push through their storage", async () => {
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
    const tagged = await search(cfg, {
      query: "delta",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([["tags", ["urgent"]]]),
    });
    expect(tagged.results.map((r) => r.path)).toEqual(["projects/plan.md"]);
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
    const kind = tool.inputSchema.properties["kind"];
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
    expect(out.results.map((r) => r.path)).toEqual(["notes/note-a.md"]);
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

/** A minimal config file inside the vault, for the MCP handler's resolver. */
function writeMcpConfig(vaultDir: string): string {
  const configPath = join(vaultDir, ".o2b-test-config.yaml");
  writeFileSync(configPath, 'search_recency_amplitude: "0"\n');
  return configPath;
}
