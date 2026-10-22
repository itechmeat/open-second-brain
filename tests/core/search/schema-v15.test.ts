/**
 * Schema v15 (chunk skip-and-hold, Lane B task B2): the persistent hold
 * record.
 *
 * The v15 entry appends to the frozen `MIGRATIONS` array and runs inside
 * `applyMigrations`' single open transaction. It adds one table:
 *
 *   - `chunk_embedding_holds(chunk_id, model, window_tokens,
 *     embedding_signature, estimated_tokens, held_at)` - one row per
 *     chunk the embedding phase proved over a model's declared input
 *     window, under the (model, window, signature) key that made the
 *     proof. The pending-vector anti-join excludes only rows matching
 *     the CURRENT key, so a window or model change releases the hold back
 *     into pending without any migration; a chunk deleted or replaced at
 *     its document loses its holds through the FK cascade, exactly like
 *     the v14 attribute rows lose theirs with the document.
 *
 * The migration backfills NOTHING: a hold is a decision about a config
 * (window + signature), and a migration has no config to consult - an
 * index predating the feature simply keeps its chunks pending until the
 * next embedding pass decides (and records) for them.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import {
  CHUNK_HOLDS_TABLE,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  applyMigrations,
  findSchemaGaps,
  readSchemaVersion,
} from "../../../src/core/search/schema.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

const PRE_V15_SCHEMA_VERSION = 14;

let vault: string;
let dbPath: string;
let cleanup: () => void;

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("schema-v15"));
});
afterEach(() => cleanup());

async function seedVault(): Promise<void> {
  writeMd(vault, "note.md", "# Note\n\nlattice widget note body");
  await indexVault(makeConfig({ vault, dbPath }));
}

/** Drop the v15 artifact and stamp the version a pre-v15 binary wrote. */
function rewindToPreV15Schema(): void {
  const db = new Database(dbPath);
  try {
    db.exec(`DROP TABLE IF EXISTS ${CHUNK_HOLDS_TABLE}`);
    db.query("UPDATE index_state SET value = ? WHERE key = 'schema_version'").run(
      String(PRE_V15_SCHEMA_VERSION),
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

function tableSql(): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    // The name is this module's own constant, not input.
    return (
      db
        .query<{ sql: string | null }, []>(
          `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${CHUNK_HOLDS_TABLE}'`,
        )
        .get()?.sql ?? null
    );
  } finally {
    db.close();
  }
}

describe("the v15 entry", () => {
  test("appends to MIGRATIONS as the latest version", () => {
    expect(LATEST_SCHEMA_VERSION).toBe(15);
    expect(MIGRATIONS.length).toBe(15);
    expect(MIGRATIONS[MIGRATIONS.length - 1]!.version).toBe(15);
  });

  test("runs from a rewound v14 index and stamps the version", async () => {
    await seedVault();
    rewindToPreV15Schema();
    expect(migrate()).toBe(LATEST_SCHEMA_VERSION);
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(readSchemaVersion(db)).toBe(15);
    } finally {
      db.close();
    }
  });

  test("a rewound index reports the hold table as a schema gap until migrated", async () => {
    await seedVault();
    rewindToPreV15Schema();
    const db = new Database(dbPath);
    try {
      const gapsBefore = findSchemaGaps(db).map((g) => g.table);
      expect(gapsBefore).toContain(CHUNK_HOLDS_TABLE);
      applyMigrations(db);
      expect(findSchemaGaps(db)).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("idempotent: migrating a current index changes nothing", async () => {
    await seedVault();
    expect(migrate()).toBe(LATEST_SCHEMA_VERSION);
    const first = tableSql();
    expect(migrate()).toBe(LATEST_SCHEMA_VERSION);
    expect(tableSql()).toBe(first);
  });
});

describe("the hold table shape", () => {
  test("names the key triple, the estimate, the timestamp and the chunk FK", async () => {
    await seedVault();
    migrate();
    const db = new Database(dbPath, { readonly: true });
    try {
      const cols = db
        .query<{ name: string }, [string]>("SELECT name FROM pragma_table_info(?)")
        .all(CHUNK_HOLDS_TABLE)
        .map((c) => c.name);
      expect(cols).toContain("chunk_id");
      expect(cols).toContain("model");
      expect(cols).toContain("window_tokens");
      expect(cols).toContain("embedding_signature");
      expect(cols).toContain("estimated_tokens");
      expect(cols).toContain("held_at");
    } finally {
      db.close();
    }
    const sql = tableSql() ?? "";
    // The FK clause and its cascade are load-bearing: a re-index replaces
    // chunk rows, and a hold the chunk no longer has must vanish with it.
    expect(sql).toContain(`REFERENCES chunks(id) ON DELETE CASCADE`);
    expect(sql).toContain("PRIMARY KEY");
  });

  test("a replaced chunk row takes its holds with it (FK cascade)", async () => {
    await seedVault();
    migrate();
    const config = makeConfig({ vault, dbPath });
    const probe = new Database(dbPath);
    let chunkId = 0;
    let docId = 0;
    try {
      const row = probe
        .query<{ id: number; document_id: number }, []>(
          "SELECT id, document_id FROM chunks LIMIT 1",
        )
        .get();
      chunkId = row!.id;
      docId = row!.document_id;
    } finally {
      probe.close();
    }
    const store = await Store.open(config, { mode: "write" });
    try {
      store.recordChunkHolds([{ chunkId, estimatedTokens: 999, windowTokens: 512 }], {
        model: "test-model",
        embeddingSignature: "openai-compat:test-model:?",
      });
      expect(store.chunkHoldRowsFor(chunkId).length).toBe(1);
      // Re-indexing a document rewrites its chunks wholesale; the old rows
      // die, and their holds must die with them rather than key a ghost.
      // The cascade is enforced on the Store's own connection, which opens
      // with `PRAGMA foreign_keys = ON`.
      store.replaceChunks(docId, []);
      expect(store.chunkHoldRowsFor(chunkId)).toEqual([]);
    } finally {
      await store.close();
    }
  });
});
