/**
 * `documents.visibility`, and the migration that fills it for an index
 * that predates it (private-is-not-a-suggestion, unit 6).
 *
 * The consultant's recommended shape was "a missing column value means
 * private, and the legacy population self-heals". Verified against
 * source, that is a total search blackout: `applyMigrations` adds a
 * column with NULL for every existing row, so on upgrade every document
 * in every vault - including the overwhelming majority that have never
 * used `visibility:` at all - would answer as reserved until a full
 * reindex. This file is the executable form of the correction: the
 * migration BACKFILLS, from the frontmatter the index already stores as
 * its own chunk at `chunk_index = 0`.
 *
 * Three column states, all three distinct:
 *
 *   - a JSON array of the page's normalised tokens - measured;
 *   - `[]` - measured, and the page declares none;
 *   - NULL - the index cannot measure this document, which is a third
 *     state and not a synonym for the second.
 *
 * ## One premise of the plan, refuted here
 *
 * The plan expected an UNTERMINATED frontmatter block to land in the
 * third state. It cannot: `chunker.ts`'s `readFrontmatter` drops the
 * opening `---` and keeps the rest as body, so chunk zero of such a page
 * is byte-indistinguishable from chunk zero of a page with no
 * frontmatter at all, and no reader of the index can tell them apart.
 *
 * It also does not matter, which is why the correction is a rewording
 * rather than a redesign: `parseFrontmatterText` reads an unterminated
 * block on the REAL FILE as declaring nothing too, so the column and the
 * live boundary at the three read roots agree. The third state is
 * therefore what it says it is - a document the index holds no chunk
 * zero for - and it is pinned below from that shape rather than from an
 * unterminated block.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { REMOTE_DENY_VISIBILITY_TOKEN } from "../../../src/core/graph/visibility.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import {
  DOCUMENT_VISIBILITY_COLUMN,
  LATEST_SCHEMA_VERSION,
  applyMigrations,
  readSchemaVersion,
} from "../../../src/core/search/schema.ts";
import { search } from "../../../src/core/search/search.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

/** The schema version this column was introduced at. */
const PRE_COLUMN_SCHEMA_VERSION = 11;

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("visibility-column"));
});
afterEach(() => cleanup());

/**
 * Rewind a freshly built index to the schema this column was added at, so
 * the migration runs over rows an older binary wrote. Dropping the column
 * and the version stamp together is exactly the state such an index is in.
 */
function rewindToPreColumnSchema(): void {
  const db = new Database(dbPath);
  try {
    db.exec(`ALTER TABLE documents DROP COLUMN ${DOCUMENT_VISIBILITY_COLUMN}`);
    db.query("UPDATE index_state SET value = ? WHERE key = 'schema_version'").run(
      String(PRE_COLUMN_SCHEMA_VERSION),
    );
  } finally {
    db.close();
  }
}

function visibilityByPath(): Map<string, string | null> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db
      .query<{ path: string; visibility: string | null }, []>(
        `SELECT path, ${DOCUMENT_VISIBILITY_COLUMN} AS visibility FROM documents`,
      )
      .all();
    return new Map(rows.map((r) => [r.path, r.visibility]));
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

async function seedThreeStates(): Promise<void> {
  writeMd(vault, "plain.md", "# Plain\n\nlattice widget ordinary");
  writeMd(
    vault,
    "reserved.md",
    `---\nvisibility: [${REMOTE_DENY_VISIBILITY_TOKEN}]\n---\n# Reserved\n\nlattice widget reserved`,
  );
  // An unterminated block declares nothing, on the file and in the index
  // alike - see the module docblock.
  writeMd(vault, "unterminated.md", "---\nvisibility: [team]\n\n# Broken\n\nlattice widget broken");
  await indexVault(makeConfig({ vault, dbPath }));
}

describe("the migration over a pre-column index", () => {
  test("backfills the three states from the frontmatter the index already holds", async () => {
    await seedThreeStates();
    rewindToPreColumnSchema();
    expect(migrate()).toBe(LATEST_SCHEMA_VERSION);

    const byPath = visibilityByPath();
    expect(byPath.get("plain.md")).toBe("[]");
    expect(byPath.get("reserved.md")).toBe(JSON.stringify([REMOTE_DENY_VISIBILITY_TOKEN]));
    expect(byPath.get("unterminated.md")).toBe("[]");
  });

  test("leaves a document the index holds no chunk zero for unmeasured", async () => {
    await seedThreeStates();
    rewindToPreColumnSchema();
    // A row an older binary wrote whose chunks are gone: the index holds
    // nothing to measure, and "no tokens" would be a claim nobody made.
    const db = new Database(dbPath);
    try {
      db.query(
        "DELETE FROM chunks WHERE document_id = (SELECT id FROM documents WHERE path = ?)",
      ).run("plain.md");
    } finally {
      db.close();
    }
    migrate();
    expect(visibilityByPath().get("plain.md")).toBeNull();
  });

  test("leaves a vault that never used the field answering identically", async () => {
    writeMd(vault, "a.md", "# A\n\nlattice alpha");
    writeMd(vault, "b.md", "# B\n\nlattice beta");
    const cfg = makeConfig({ vault, dbPath });
    await indexVault(cfg);
    const before = await search(cfg, { query: "lattice", limit: 10 });

    rewindToPreColumnSchema();
    migrate();

    const after = await search(cfg, { query: "lattice", limit: 10 });
    expect(after.results.map((r) => r.path)).toEqual(before.results.map((r) => r.path));
    expect([...visibilityByPath().values()]).toEqual(["[]", "[]"]);
  });

  test("is idempotent: migrating an already-current index changes nothing", async () => {
    await seedThreeStates();
    const first = visibilityByPath();
    expect(migrate()).toBe(LATEST_SCHEMA_VERSION);
    expect(visibilityByPath()).toEqual(first);
  });
});

describe("the indexer", () => {
  test("writes the column on every upsert, without a migration", async () => {
    await seedThreeStates();
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(readSchemaVersion(db)).toBe(LATEST_SCHEMA_VERSION);
    } finally {
      db.close();
    }
    const byPath = visibilityByPath();
    expect(byPath.get("plain.md")).toBe("[]");
    expect(byPath.get("reserved.md")).toBe(JSON.stringify([REMOTE_DENY_VISIBILITY_TOKEN]));
    expect(byPath.get("unterminated.md")).toBe("[]");
  });

  test("normalises the stored tokens the way the predicate compares them", async () => {
    writeMd(vault, "mixed.md", "---\nvisibility: ['  Private ', TEAM]\n---\n\nlattice widget");
    await indexVault(makeConfig({ vault, dbPath }));
    expect(visibilityByPath().get("mixed.md")).toBe(
      JSON.stringify([REMOTE_DENY_VISIBILITY_TOKEN, "team"]),
    );
  });
});
