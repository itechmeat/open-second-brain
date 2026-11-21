/**
 * Chunker version 4 extracts entities from whole tokens only. An index
 * written by version 3 holds the same chunks with entity rows of the old
 * rules (`a9`, `dc68` for the device id `a9dc68ab`), so after an update
 * a query naming the id lost its entity boost on every index that was
 * upgraded but not rebuilt. The upgrade now serves the old index at once,
 * and the heal that follows brings its entities current: in place when
 * the index holds stored embeddings (a keyword-only rebuild would drop
 * them), through a rebuild otherwise.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { Database } from "bun:sqlite";

import { CHUNKER_VERSION } from "../../../src/core/search/chunker.ts";
import { countStoredEmbeddings, indexVault } from "../../../src/core/search/indexer.ts";
import { search } from "../../../src/core/search/search.ts";
import { healIndex, inspectIndex } from "../../../src/core/search/self-heal.ts";
import { STORE_INDEX_GENERATION_KEY } from "../../../src/core/search/brain-store/constants.ts";
import { stampSchemaVersion } from "../../helpers/schema-rewind.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let v: ReturnType<typeof createTempVault>;

beforeEach(() => {
  v = createTempVault("entity-refresh");
  writeMd(v.vault, "devices/main.md", "# Main machine\n\nThe main machine is device a9dc68ab.\n");
  writeMd(v.vault, "devices/other.md", "# Other machine\n\nThe other machine runs the backups.\n");
});
afterEach(() => v.cleanup());

function open(): Database {
  return new Database(v.dbPath);
}

/** Leave the index as chunker version 3 left it: the same chunks, the old entity rows. */
function rewindToChunkerV3(): void {
  const db = open();
  try {
    db.exec("DELETE FROM chunk_entities WHERE entity = 'a9dc68ab'");
    const chunk = db
      .query<{ id: number }, []>("SELECT id FROM chunks WHERE content LIKE '%a9dc68ab%'")
      .get()!.id;
    for (const fragment of ["a9", "dc68"]) {
      db.run("INSERT INTO chunk_entities(chunk_id, entity) VALUES (?, ?)", [chunk, fragment]);
    }
    db.run("UPDATE index_state SET value = '3' WHERE key = 'chunker_version'");
  } finally {
    db.close(true);
  }
}

function entities(): string[] {
  const db = open();
  try {
    return db
      .query<{ entity: string }, []>("SELECT DISTINCT entity FROM chunk_entities ORDER BY entity")
      .all()
      .map((r) => r.entity);
  } finally {
    db.close(true);
  }
}

function state(key: string): string | null {
  const db = open();
  try {
    return (
      db.query<{ value: string }, [string]>("SELECT value FROM index_state WHERE key = ?").get(key)
        ?.value ?? null
    );
  } finally {
    db.close(true);
  }
}

/** A stored vector row, as an embedding pass leaves one (the count is what a rebuild would lose). */
function addStoredEmbedding(): void {
  const db = open();
  try {
    const chunk = db.query<{ id: number }, []>("SELECT id FROM chunks LIMIT 1").get()!.id;
    db.run(
      "INSERT INTO embeddings(chunk_id, model, dimension, embedding_hash, created_at, updated_at) " +
        "VALUES (?, 'fake-model', 4, 'h', '', '')",
      [chunk],
    );
  } finally {
    db.close(true);
  }
}

async function entityReasons(): Promise<string[]> {
  const outcome = await search(makeConfig({ vault: v.vault, dbPath: v.dbPath }), {
    query: "a9dc68ab",
    recordAccess: false,
    verbose: true,
  } as Parameters<typeof search>[1]);
  const hit = outcome.results.find((r) => r.path === "devices/main.md");
  return (hit?.reasons ?? []).filter((r) => r.startsWith("entity_match"));
}

test("an index of chunker version 3 is not current, and asks for its entities only", async () => {
  await indexVault(makeConfig({ vault: v.vault, dbPath: v.dbPath }));
  expect(state("chunker_version")).toBe(String(CHUNKER_VERSION));
  rewindToChunkerV3();
  expect(inspectIndex(makeConfig({ vault: v.vault, dbPath: v.dbPath }))).toBe("entities-stale");
});

test("an older-schema index of chunker version 3 is served at once, not rebuilt in the search", async () => {
  const cfg = makeConfig({ vault: v.vault, dbPath: v.dbPath });
  await indexVault(cfg);
  rewindToChunkerV3();
  stampSchemaVersion(v.dbPath, 17);
  const generation = state(STORE_INDEX_GENERATION_KEY);

  const outcome = await search(cfg, { query: "backups", recordAccess: false });

  expect(outcome.results.map((r) => r.path)).toContain("devices/other.md");
  // Upgraded in place, the same file: no rebuild ran in the search.
  expect(state("schema_version")).not.toBe("17");
  expect(state(STORE_INDEX_GENERATION_KEY)).toBe(generation);
  expect(inspectIndex(cfg)).toBe("entities-stale");
});

test("the heal re-extracts the entities in place and keeps every stored embedding", async () => {
  const cfg = makeConfig({ vault: v.vault, dbPath: v.dbPath });
  await indexVault(cfg);
  rewindToChunkerV3();
  addStoredEmbedding();
  const generation = state(STORE_INDEX_GENERATION_KEY);
  expect(entities()).toContain("dc68");

  const outcome = await healIndex(cfg);

  expect(outcome.kind).toBe("migrated");
  expect(countStoredEmbeddings(v.dbPath)).toBe(1);
  expect(state(STORE_INDEX_GENERATION_KEY)).toBe(generation);
  expect(entities()).toContain("a9dc68ab");
  expect(entities()).not.toContain("dc68");
  expect(state("chunker_version")).toBe(String(CHUNKER_VERSION));
  expect(inspectIndex(cfg)).toBe("current");
  expect(existsSync(`${v.dbPath}.bak`)).toBe(false);
});

test("the heal rebuilds an index with no stored embeddings, and the entity boost comes back", async () => {
  const cfg = makeConfig({ vault: v.vault, dbPath: v.dbPath });
  await indexVault(cfg);
  rewindToChunkerV3();
  expect(await entityReasons()).toEqual([]);

  const outcome = await healIndex(cfg);

  expect(outcome.kind).toBe("rebuilt");
  expect(entities()).toContain("a9dc68ab");
  expect(inspectIndex(cfg)).toBe("current");
  expect((await entityReasons()).length).toBe(1);
});
