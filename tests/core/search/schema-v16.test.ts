/**
 * Schema v16 (privacy-marker visibility restamp): the one-pass
 * re-measurement of `documents.visibility` for rows whose chunk-zero
 * frontmatter carries an informal privacy marker key.
 *
 * The column has existed since v12, and the v12 backfill ran ONCE, for
 * `IS NULL` rows. An index migrated to v12-v14 by a pre-marker binary
 * holds marker pages stamped from the declared `visibility:` alone - a
 * non-NULL `[]` - and the incremental indexer skips an unchanged file, so
 * no later run corrects them. Consumers reading the column alone
 * undercount exactly the pages the column exists to make countable.
 *
 * The migration is DDL-free: the schema it produces is v15's, so the
 * manifest check cannot see it. Its effects are only in row values, and
 * those are what the tests below pin: a marker row re-stamped with the
 * reserved token, a row already carrying the marker-aware value
 * unchanged, a formal row untouched, and a NULL row (no chunk zero)
 * left NULL.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import {
  DOCUMENT_VISIBILITY_COLUMN,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  applyMigrations,
  encodeDocumentVisibility,
  readSchemaVersion,
} from "../../../src/core/search/schema.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const PRE_V16_SCHEMA_VERSION = 15;

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("schema-v16"));
});
afterEach(() => cleanup());

async function seedVault(): Promise<void> {
  writeMd(vault, "marked.md", "---\naccess: private\n---\n\nMarked heron counts.\n");
  writeMd(vault, "formal.md", "---\nvisibility: [team]\n---\n\nTeam runbook.\n");
  writeMd(vault, "plain.md", "# Plain\n\nNothing declared.\n");
  await indexVault(makeConfig({ vault, dbPath }));
}

/** Stamp the column as a pre-marker binary wrote it, then rewind to v15. */
function rewindWithPreMarkerStamps(stamps: Readonly<Record<string, string>>): void {
  const db = new Database(dbPath);
  try {
    const set = db.query<never, [string, string]>(
      `UPDATE documents SET ${DOCUMENT_VISIBILITY_COLUMN} = ?1 WHERE path = ?2`,
    );
    for (const [path, value] of Object.entries(stamps)) set.run(value, path);
    db.query("UPDATE index_state SET value = ? WHERE key = 'schema_version'").run(
      String(PRE_V16_SCHEMA_VERSION),
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

/** The visibility column of one document, by its path. */
function columnOf(path: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (
      db
        .query<{ visibility: string | null }, [string]>(
          `SELECT ${DOCUMENT_VISIBILITY_COLUMN} AS visibility FROM documents WHERE path = ?1`,
        )
        .get(path)?.visibility ?? null
    );
  } finally {
    db.close();
  }
}

describe("the v16 entry", () => {
  test("appends to MIGRATIONS as the latest version and adds no DDL", () => {
    expect(LATEST_SCHEMA_VERSION).toBe(16);
    expect(MIGRATIONS.length).toBe(16);
    expect(MIGRATIONS[MIGRATIONS.length - 1]!.version).toBe(16);
  });

  test("runs from a rewound v15 index and stamps the version", async () => {
    await seedVault();
    rewindWithPreMarkerStamps({ "marked.md": "[]" });
    expect(migrate()).toBe(LATEST_SCHEMA_VERSION);
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(readSchemaVersion(db)).toBe(16);
    } finally {
      db.close();
    }
  });
});

describe("the marker restamp", () => {
  test("a pre-marker-stamped marker row gains the reserved token", async () => {
    await seedVault();
    // What a pre-marker binary wrote: the declared `visibility:` alone.
    rewindWithPreMarkerStamps({ "marked.md": encodeDocumentVisibility([]) });
    migrate();
    expect(columnOf("marked.md")).toBe(encodeDocumentVisibility(["private"]));
  });

  test("a formal row and a plain row are left exactly as they were", async () => {
    await seedVault();
    rewindWithPreMarkerStamps({
      "formal.md": encodeDocumentVisibility(["team"]),
      "plain.md": encodeDocumentVisibility([]),
    });
    migrate();
    expect(columnOf("formal.md")).toBe(encodeDocumentVisibility(["team"]));
    expect(columnOf("plain.md")).toBe(encodeDocumentVisibility([]));
  });

  test("a marker row already carrying the marker-aware value is unchanged", async () => {
    await seedVault();
    // The current indexer already writes the marker-aware value; a
    // re-run over it is a no-op.
    rewindWithPreMarkerStamps({ "marked.md": encodeDocumentVisibility(["private"]) });
    migrate();
    expect(columnOf("marked.md")).toBe(encodeDocumentVisibility(["private"]));
  });

  test("a capitalized marker key on the page is caught too", async () => {
    writeMd(vault, "cased.md", "---\nAccess: private\n---\n\nCased claim.\n");
    writeMd(vault, "plain.md", "# Plain\n\nNothing declared.\n");
    await indexVault(makeConfig({ vault, dbPath }));
    rewindWithPreMarkerStamps({ "cased.md": encodeDocumentVisibility([]) });
    migrate();
    expect(columnOf("cased.md")).toBe(encodeDocumentVisibility(["private"]));
  });

  test("a row with no chunk zero stays NULL even when a marker was hand-stamped before", async () => {
    await seedVault();
    const db = new Database(dbPath);
    try {
      // There is nothing to measure once the chunk rows are gone: the
      // honest answer stays "the index holds nothing", not a guess.
      db.query(
        "DELETE FROM chunks WHERE document_id = (SELECT id FROM documents WHERE path = ?1)",
      ).run("marked.md");
      db.exec(`UPDATE documents SET ${DOCUMENT_VISIBILITY_COLUMN} = NULL WHERE path = 'marked.md'`);
      db.query("UPDATE index_state SET value = ? WHERE key = 'schema_version'").run(
        String(PRE_V16_SCHEMA_VERSION),
      );
    } finally {
      db.close();
    }
    migrate();
    expect(columnOf("marked.md")).toBeNull();
  });

  test("idempotent: migrating a current index changes nothing", async () => {
    await seedVault();
    expect(migrate()).toBe(LATEST_SCHEMA_VERSION);
    const before = [columnOf("marked.md"), columnOf("formal.md"), columnOf("plain.md")];
    expect(migrate()).toBe(LATEST_SCHEMA_VERSION);
    expect([columnOf("marked.md"), columnOf("formal.md"), columnOf("plain.md")]).toEqual(before);
  });
});
