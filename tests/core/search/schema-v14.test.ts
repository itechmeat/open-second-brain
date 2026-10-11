/**
 * Schema v14 (recall-quality, tasks C2/C3): the kind discriminator, the
 * taxonomy indexes and the bounded document-attributes side table.
 *
 * The v14 entry appends to the frozen `MIGRATIONS` array and therefore runs
 * inside `applyMigrations`' single open transaction. It adds:
 *
 *   - `chunks.chunk_kind`, a VIRTUAL generated column ('page' for
 *     `chunk_index = 0`, else 'section') with `idx_chunks_kind` - a pure
 *     function of existing columns, so the upgrade is metadata-only and
 *     stores nothing;
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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import {
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  REINDEX_COMMAND,
  applyMigrations,
  findSchemaGaps,
  readSchemaVersion,
} from "../../../src/core/search/schema.ts";
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
  test("is a VIRTUAL generated column with an index", async () => {
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
      // hidden = 2 marks a VIRTUAL generated column: computed on read,
      // stored nowhere.
      expect(col?.hidden).toBe(2);
      expect(
        db
          .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index'")
          .all()
          .map((r) => r.name),
      ).toContain("idx_chunks_kind");
      const kinds = db
        .query<{ chunk_index: number; chunk_kind: string }, []>(
          "SELECT chunk_index, chunk_kind FROM chunks ORDER BY document_id, chunk_index",
        )
        .all();
      expect(kinds.filter((k) => k.chunk_index === 0).every((k) => k.chunk_kind === "page")).toBe(
        true,
      );
      expect(
        kinds.filter((k) => k.chunk_index !== 0).every((k) => k.chunk_kind === "section"),
      ).toBe(true);
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

  test("caps values per key at 16 and drops over-long values", async () => {
    writeMd(
      vault,
      "wide.md",
      `---\nletters: [${Array.from({ length: 20 }, (_, i) => `v${i}`).join(", ")}]\nbig: ${OVERSIZED_VALUE}\n---\n\n# Wide\n\nlattice wide widget`,
    );
    await indexVault(makeConfig({ vault, dbPath }));
    rewindToPreV14Schema();
    migrate();
    const rows = attributesFor("wide.md");
    expect(rows.filter((r) => r.key === "letters").length).toBe(16);
    expect(rows.some((r) => r.key === "big")).toBe(false);
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
