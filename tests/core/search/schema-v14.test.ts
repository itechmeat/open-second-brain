/**
 * Schema v14 (recall-quality, tasks C2/C3): the kind discriminator, the
 * taxonomy indexes and the bounded document-attributes side table.
 *
 * The v14 entry appends to the frozen `MIGRATIONS` array and therefore runs
 * inside `applyMigrations`' single open transaction. It adds:
 *
 *   - `chunks.chunk_kind`, a plain column - 'page' for the page-HEAD
 *     chunk (the first content chunk: chunk 1 when the document has a
 *     frontmatter block at chunk 0, chunk 0 itself otherwise), 'section'
 *     for everything else - with `idx_chunks_kind`. The indexer writes it
 *     at insert and the migration backfills existing rows by measuring
 *     chunk 0's content (a re-index rewrites it authoritatively);
 *   - `idx_documents_page_type` over the already-materialized `type`
 *     column;
 *   - `document_attributes(document_id, key, value)`, backfilled from
 *     chunk 0 by the v12 recipe (the frontmatter is already in the index),
 *     with the promoted keys - `type`, `tags`, `pinned`, `visibility`,
 *     `aliases` - skipped because each keeps its dedicated column or table
 *     as the single source of truth, and with hard bounds (64 keys per
 *     document, 16 values per key, 256 bytes per value) that DECREMENT the
 *     attribute set instead of failing the index.
 *
 * Nothing that v14 does not own may change: the vector storage tables
 * (`embeddings`, `chunk_vec`, `chunk_vec_map`) and every pre-existing row
 * compare byte-identical across the migration.
 */

import { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { documentIdsExcludedByAttributeNarrowing } from "../../../src/core/search/property-pushdown.ts";
import {
  ATTRIBUTE_MAX_VALUE_BYTES,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  REINDEX_COMMAND,
  applyMigrations,
  findSchemaGaps,
  readSchemaVersion,
} from "../../../src/core/search/schema.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const PRE_V14_SCHEMA_VERSION = 13;
const VEC_AVAILABLE = sqliteVecLoadable();

/** A value one byte over the per-value bound, to prove dropping. */
const OVERSIZED_VALUE = "x".repeat(257);

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("schema-v14"));
});
afterEach(() => cleanup());

/** The v14 keys frontmatter, one file exercising extraction and promotion skips. */
function typedFrontmatter(): string {
  return [
    "---",
    "type: note",
    "tags: [urgent]",
    "pinned: true",
    "visibility: [public]",
    "aliases: [Typed]",
    "status: active",
    "projects: [alpha, beta]",
    "---",
    "",
    "# Typed",
    "",
    "lattice typed widget",
    "",
  ].join("\n");
}

/** Seed a small indexed vault with frontmatter, pending vectors and links. */
async function seedVault(): Promise<void> {
  writeMd(vault, "typed.md", typedFrontmatter());
  writeMd(vault, "plain.md", "# Plain\n\nlattice plain widget");
  await indexVault(makeConfig({ vault, dbPath }));
  // Synthetic vector-storage rows, exactly the shape an embedded index
  // holds, so the migration can be proven not to touch them. Inserted at
  // the CURRENT schema: the rewind below removes only v14 artifacts.
  const db = new Database(dbPath);
  try {
    db.exec(
      "INSERT INTO embeddings(chunk_id, model, dimension, embedding_hash, created_at, updated_at) " +
        "SELECT id, 'test-model', 4, 'ehash', '2026-10-11T00:00:00.000Z', '2026-10-11T00:00:00.000Z' " +
        "FROM chunks ORDER BY id LIMIT 1",
    );
    db.exec(
      "INSERT INTO chunk_vec_map(chunk_id, vec_rowid) " +
        "SELECT chunk_id, 4242 FROM embeddings LIMIT 1",
    );
  } finally {
    db.close();
  }
}

/**
 * Rewind a freshly built index to the schema this migration was added at:
 * drop the v14 artifacts and stamp the version an older binary wrote.
 */
function rewindToPreV14Schema(): void {
  const db = new Database(dbPath);
  try {
    db.exec("DROP INDEX IF EXISTS idx_chunks_kind");
    db.exec("DROP INDEX IF EXISTS idx_documents_page_type");
    db.exec("DROP INDEX IF EXISTS idx_document_attributes_key_value");
    db.exec("DROP TABLE IF EXISTS document_attributes");
    db.exec("ALTER TABLE chunks DROP COLUMN chunk_kind");
    db.query("UPDATE index_state SET value = ? WHERE key = 'schema_version'").run(
      String(PRE_V14_SCHEMA_VERSION),
    );
  } finally {
    db.close();
  }
}

function migrate(): number {
  const db = new Database(dbPath);
  try {
    return applyMigrations(db);
  } finally {
    db.close();
  }
}

/** Row dumps of every table v14 must not disturb (explicit columns only). */
function snapshotUntouchedTables(): Map<string, string> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const present = new Set(
      db
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name),
    );
    if (present.has("chunk_vec")) {
      // Reading a vec0 table requires its module, on a readonly connection
      // too. The snapshot only reads, so loading is side-effect-free.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const vec = require("sqlite-vec") as { getLoadablePath(): string };
      db.loadExtension(vec.getLoadablePath());
    }
    const tables = [
      "documents",
      "links",
      "doc_aliases",
      "embeddings",
      "chunk_vec_map",
      ...(VEC_AVAILABLE && present.has("chunk_vec") ? ["chunk_vec"] : []),
    ];
    const out = new Map<string, string>();
    for (const table of tables) {
      // A vec0 virtual table cannot be introspected without the module
      // loaded; its shape is fixed, so spell its columns.
      const cols =
        table === "chunk_vec"
          ? ["embedding", "rowid"]
          : db
              .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
              .all(table)
              .map((c) => c.name)
              .toSorted();
      const rows = db
        .query<Record<string, unknown>, []>(
          `SELECT ${table === "chunk_vec" ? "rowid, embedding" : "*"} FROM "${table}"`,
        )
        .all()
        .map((row) => cols.map((c) => JSON.stringify(row[c])).join("\u241f"))
        .toSorted();
      out.set(table, rows.join("\u241e"));
    }
    return out;
  } finally {
    db.close();
  }
}

function attributeRows(): ReadonlyArray<{ document_id: number; key: string; value: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<{ document_id: number; key: string; value: string }, []>(
        "SELECT document_id, key, value FROM document_attributes ORDER BY document_id, key, value",
      )
      .all();
  } finally {
    db.close();
  }
}

function attributesFor(path: string): ReadonlyArray<{ key: string; value: string }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<{ key: string; value: string }, [string]>(
        "SELECT a.key AS key, a.value AS value FROM document_attributes a " +
          "JOIN documents d ON d.id = a.document_id WHERE d.path = ? " +
          "ORDER BY a.key, a.value",
      )
      .all(path);
  } finally {
    db.close();
  }
}

describe("the v14 entry", () => {
  test("appends to MIGRATIONS as the latest version", () => {
    expect(LATEST_SCHEMA_VERSION).toBe(14);
    expect(MIGRATIONS.length).toBe(14);
    expect(MIGRATIONS[MIGRATIONS.length - 1]!.version).toBe(14);
  });

  test("runs from a rewound v13 index and stamps the version", async () => {
    await seedVault();
    rewindToPreV14Schema();
    expect(migrate()).toBe(LATEST_SCHEMA_VERSION);
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(readSchemaVersion(db)).toBe(14);
    } finally {
      db.close();
    }
  });

  test("leaves a current index unchanged (idempotent open)", async () => {
    await seedVault();
    const before = snapshotUntouchedTables();
    expect(migrate()).toBe(LATEST_SCHEMA_VERSION);
    expect(snapshotUntouchedTables()).toEqual(before);
  });
});

describe("chunk_kind", () => {
  test("is a stored column backfilled by the page-head rule, with an index", async () => {
    await seedVault();
    rewindToPreV14Schema();
    migrate();
    const db = new Database(dbPath, { readonly: true });
    try {
      const col = db
        .query<{ name: string; hidden: number }, []>(
          "SELECT name, hidden FROM pragma_table_xinfo('chunks')",
        )
        .all()
        .find((c) => c.name === "chunk_kind");
      // hidden = 0: a plain stored column the writer and the backfill fill
      // (the old position-only VIRTUAL draft made kind:page match the YAML
      // block instead of the page head).
      expect(col?.hidden).toBe(0);
      expect(
        db
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'")
          .all()
          .map((r) => r.name),
      ).toContain("idx_chunks_kind");
      const rows = db
        .query<{ path: string; chunk_index: number; chunk_kind: string; content: string }, []>(
          "SELECT d.path AS path, c.chunk_index AS chunk_index, c.chunk_kind AS chunk_kind, " +
            "c.content AS content FROM chunks c JOIN documents d ON d.id = c.document_id " +
            "ORDER BY d.path, c.chunk_index",
        )
        .all();
      // The head rule, measured per document: the page chunk is the first
      // content chunk (chunk 1 when chunk 0 is the `---` fence, chunk 0
      // otherwise); every other chunk is a section.
      for (const path of [...new Set(rows.map((r) => r.path))]) {
        const doc = rows.filter((r) => r.path === path);
        const head = doc[0]!.content.startsWith("---") ? Math.min(1, doc.length - 1) : 0;
        for (const row of doc) {
          expect(row.chunk_kind).toBe(row.chunk_index === head ? "page" : "section");
        }
        expect(doc.filter((r) => r.chunk_kind === "page").length).toBe(1);
      }
    } finally {
      db.close();
    }
  });
});

describe("taxonomy indexes", () => {
  test("idx_documents_page_type exists over the materialized type column", async () => {
    await seedVault();
    rewindToPreV14Schema();
    migrate();
    const db = new Database(dbPath, { readonly: true });
    try {
      const index = db
        .query<{ tbl_name: string; sql: string }, []>(
          "SELECT tbl_name, sql FROM sqlite_master WHERE type = 'index' AND name = 'idx_documents_page_type'",
        )
        .get();
      expect(index?.tbl_name).toBe("documents");
      expect(index?.sql).toContain("page_type");
    } finally {
      db.close();
    }
  });
});

describe("document_attributes backfill", () => {
  test("extracts arbitrary scalar and array keys from chunk 0", async () => {
    await seedVault();
    rewindToPreV14Schema();
    migrate();
    expect(attributesFor("typed.md")).toEqual([
      { key: "projects", value: "alpha" },
      { key: "projects", value: "beta" },
      { key: "status", value: "active" },
    ]);
  });

  test("skips the promoted keys that keep dedicated storage", async () => {
    await seedVault();
    rewindToPreV14Schema();
    migrate();
    const keys = attributesFor("typed.md").map((r) => r.key);
    for (const promoted of ["type", "tags", "pinned", "visibility", "aliases"]) {
      expect(keys).not.toContain(promoted);
    }
  });

  test("a document with no chunk zero gets no attributes", async () => {
    await seedVault();
    rewindToPreV14Schema();
    const db = new Database(dbPath);
    try {
      db.exec(
        "DELETE FROM chunks WHERE document_id = (SELECT id FROM documents WHERE path = 'plain.md')",
      );
    } finally {
      db.close();
    }
    migrate();
    expect(attributesFor("plain.md")).toEqual([]);
  });

  test("caps keys per document at 64 without failing", async () => {
    const many = Array.from({ length: 70 }, (_, i) => `key${String(i).padStart(2, "0")}: v${i}`);
    writeMd(vault, "many.md", `---\n${many.join("\n")}\n---\n\n# Many\n\nlattice many widget`);
    await indexVault(makeConfig({ vault, dbPath }));
    rewindToPreV14Schema();
    migrate();
    expect(attributesFor("many.md").length).toBe(64);
  });

  test("a partly-stored key stores no rows: a drop silences the whole key", async () => {
    // H2 (recall-quality review): the narrowing may only rule documents IN
    // ("silence is not a verdict"). A key with SOME rows stored and some
    // values dropped would act as proof of a mismatch for a value the
    // extractor never kept - so any dropped value (an element past the
    // 16-value cap, a value over the 256-byte cap) stores NO rows for the
    // key at all, and the NOT EXISTS arm of the narrowing keeps the
    // document for the live filter.
    writeMd(
      vault,
      "wide.md",
      `---\nletters: [${Array.from({ length: 20 }, (_, i) => `v${i}`).join(", ")}]\nsource: [${OVERSIZED_VALUE}, x]\nbig: ${OVERSIZED_VALUE}\n---\n\n# Wide\n\nlattice wide widget`,
    );
    await indexVault(makeConfig({ vault, dbPath }));
    rewindToPreV14Schema();
    migrate();
    const rows = attributesFor("wide.md");
    expect(rows.some((r) => r.key === "letters")).toBe(false);
    expect(rows.some((r) => r.key === "source")).toBe(false);
    expect(rows.some((r) => r.key === "big")).toBe(false);
  });

  test("a key under the bounds still stores its rows", async () => {
    writeMd(
      vault,
      "ok.md",
      `---\nletters: [${Array.from({ length: 16 }, (_, i) => `v${i}`).join(", ")}]\nbig: ${"x".repeat(ATTRIBUTE_MAX_VALUE_BYTES)}\n---\n\n# Ok\n\nlattice ok widget`,
    );
    await indexVault(makeConfig({ vault, dbPath }));
    rewindToPreV14Schema();
    migrate();
    const rows = attributesFor("ok.md");
    expect(rows.filter((r) => r.key === "letters").length).toBe(16);
    expect(rows.some((r) => r.key === "big")).toBe(true);
  });
});

describe("the narrowing never excludes a document at the storage bounds (H2)", () => {
  test("an over-cap value and an element past the value cap answer through the live filter", async () => {
    const longUrl = `https://example.invalid/${"p".repeat(320)}`;
    writeMd(
      vault,
      "bounds.md",
      `---\nsource: [${longUrl}, x]\nrefs: [${Array.from({ length: 20 }, (_, i) => `r${i}`).join(", ")}]\n---\n\n# Bounds\n\nlattice bounds widget`,
    );
    writeMd(vault, "plain.md", "# Plain\n\nlattice plain widget");
    await indexVault(makeConfig({ vault, dbPath }));
    const db = new Database(dbPath, { readonly: true });
    try {
      // The narrowing's own exclusion set: both filters must exclude
      // nothing - the extractor stored no rows for either key, so the
      // table cannot speak against the document.
      for (const entry of [
        { key: "source", values: [longUrl] },
        { key: "refs", values: ["r19"] },
      ]) {
        expect([...documentIdsExcludedByAttributeNarrowing(db, [entry])]).toEqual([]);
      }
    } finally {
      db.close();
    }
    // End to end: before the fix the SQL narrowed both notes away and the
    // live filter never saw them; now they survive to the live filter,
    // which accepts both.
    const cfg = makeConfig({ vault, dbPath });
    const bySource = await search(cfg, {
      query: "bounds",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([["source", [longUrl]]]),
    });
    expect(bySource.results.map((r) => r.path)).toEqual(["bounds.md"]);
    const byRefs = await search(cfg, {
      query: "bounds",
      keywordOnly: true,
      visibility: ["public"],
      properties: new Map([["refs", ["r19"]]]),
    });
    expect(byRefs.results.map((r) => r.path)).toEqual(["bounds.md"]);
  });
});

describe("v14 touches nothing it does not own", () => {
  test("vector storage and pre-existing rows compare byte-identical", async () => {
    await seedVault();
    rewindToPreV14Schema();
    const before = snapshotUntouchedTables();
    expect(before.get("embeddings")!.length).toBeGreaterThan(0);
    migrate();
    expect(snapshotUntouchedTables()).toEqual(before);
  });

  test("chunk_vec is byte-identical when the extension is loaded", async () => {
    if (!VEC_AVAILABLE) return;
    await seedVault();
    const setup = new Database(dbPath);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const vec = require("sqlite-vec") as { getLoadablePath(): string };
      setup.loadExtension(vec.getLoadablePath());
      setup.exec("CREATE VIRTUAL TABLE IF NOT EXISTS chunk_vec USING vec0(embedding float[4])");
      setup.exec(
        "INSERT INTO chunk_vec(rowid, embedding) VALUES (4242, x'0000803f0000803f0000803f0000803f')",
      );
    } finally {
      setup.close();
    }
    rewindToPreV14Schema();
    const before = snapshotUntouchedTables();
    migrate();
    expect(snapshotUntouchedTables().get("chunk_vec")).toBe(before.get("chunk_vec"));
  });
});

describe("the indexer attribute writes", () => {
  test("writes attributes on every upsert, from the same frontmatter parse as the notices", async () => {
    await seedVault();
    // No rewind, no backfill: these rows come from the indexer itself.
    expect(attributesFor("typed.md")).toEqual([
      { key: "projects", value: "alpha" },
      { key: "projects", value: "beta" },
      { key: "status", value: "active" },
    ]);
  });

  test("the content_hash fastpath skips unchanged documents exactly as today", async () => {
    const cfg = makeConfig({ vault, dbPath });
    writeMd(vault, "typed.md", typedFrontmatter());
    await indexVault(cfg);
    const before = attributesFor("typed.md");
    const stats = await indexVault(cfg);
    expect(stats.unchanged).toBe(1);
    expect(attributesFor("typed.md")).toEqual(before);
  });

  test("an update replaces the stored attribute set wholesale", async () => {
    const cfg = makeConfig({ vault, dbPath });
    writeMd(vault, "typed.md", typedFrontmatter());
    await indexVault(cfg);
    writeMd(
      vault,
      "typed.md",
      "---\nstatus: archived\nprojects: [gamma]\n---\n\n# Typed\n\nlattice typed widget",
    );
    const stats = await indexVault(cfg);
    expect(stats.unchanged).toBe(0);
    expect(attributesFor("typed.md")).toEqual([
      { key: "projects", value: "gamma" },
      { key: "status", value: "archived" },
    ]);
  });

  test("a delete takes the attribute rows with the document", async () => {
    const cfg = makeConfig({ vault, dbPath });
    writeMd(vault, "typed.md", typedFrontmatter());
    await indexVault(cfg);
    rmSync(`${vault}/typed.md`);
    await indexVault(cfg);
    expect(attributesFor("typed.md")).toEqual([]);
    expect(attributeRows().length).toBe(0);
  });

  test("the write path is bounded like the backfill", async () => {
    const cfg = makeConfig({ vault, dbPath });
    const many = Array.from({ length: 70 }, (_, i) => `key${String(i).padStart(2, "0")}: v${i}`);
    writeMd(vault, "many.md", `---\n${many.join("\n")}\n---\n\n# Many\n\nlattice many widget`);
    await indexVault(cfg);
    expect(attributesFor("many.md").length).toBe(64);
  });
});

describe("the attribute narrowing read (query path)", () => {
  test("the stored scalar String form answers the narrowing; silence never excludes", async () => {
    const cfg = makeConfig({ vault, dbPath });
    writeMd(
      vault,
      "scalars.md",
      "---\npriority: 3\nflag: true\nstatus: active\n---\n\n# Scalars\n\nlattice scalars widget",
    );
    writeMd(vault, "other.md", "---\npriority: 9\n---\n\n# Other\n\nlattice other widget");
    await indexVault(cfg);
    const db = new Database(dbPath, { readonly: true });
    try {
      const idByPath = new Map(
        db
          .query<{ path: string; id: number }, []>("SELECT path, id FROM documents")
          .all()
          .map((r) => [r.path, r.id] as const),
      );
      const scalars = idByPath.get("scalars.md")!;
      const other = idByPath.get("other.md")!;
      const excluded = documentIdsExcludedByAttributeNarrowing(db, [
        { key: "priority", values: ["3"] },
      ]);
      // other.md stores priority as "9": a provable mismatch. scalars.md
      // stores the number as the same "3" the live filter compares, so it
      // matches; plain.md stores no priority at all, and a table with no
      // rows for a key may never speak against a document.
      expect([...excluded].toSorted()).toEqual([other].toSorted());
      expect(excluded.has(scalars)).toBe(false);
      expect(
        documentIdsExcludedByAttributeNarrowing(db, [{ key: "absent-key", values: ["x"] }]).size,
      ).toBe(0);
    } finally {
      db.close();
    }
  });
});

describe("the expected-schema manifest and the refusal", () => {
  test("the gap check self-derives green on a migrated index", async () => {
    await seedVault();
    rewindToPreV14Schema();
    migrate();
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(findSchemaGaps(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a store above LATEST is still refused with the reindex command", () => {
    const db = new Database(":memory:");
    try {
      applyMigrations(db);
      db.query("UPDATE index_state SET value = ? WHERE key = 'schema_version'").run(
        String(LATEST_SCHEMA_VERSION + 1),
      );
      expect(() => applyMigrations(db)).toThrow(/o2b search reindex/);
      expect(() => applyMigrations(db)).toThrow(REINDEX_COMMAND);
    } finally {
      db.close();
    }
  });
});
