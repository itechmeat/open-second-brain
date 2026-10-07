/**
 * Re-indexing a changed document keeps every chunk whose position and
 * content did not change in place (same row, same id) and rewrites only
 * the chunks that did. A daily log that grows all day then costs the
 * appended tail on each run, not the whole file: before, every chunk was
 * deleted and re-inserted, full-text rows included.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { indexVault } from "../../../src/core/search/indexer.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;

/** A section of about 900 words, more than one 800-word chunk can hold alone. */
function section(name: string): string {
  const words = Array.from({ length: 900 }, (_, i) => `${name}${i % 50}`).join(" ");
  return `## ${name}\n\n${words}\n`;
}

const LOG = "notes/log.md";

beforeEach(() => {
  ({ vault, dbPath, cleanup } = createTempVault("chunk-preserving"));
  writeMd(vault, LOG, `# Log\n\n${section("alpha")}\n${section("bravo")}\n${section("charlie")}`);
  // Indexed after the log, so the log's chunks are not the highest rowids:
  // SQLite would otherwise hand a delete-and-reinsert the same ids back.
  writeMd(vault, "notes/zz-other.md", `# Other\n\n${section("zulu")}`);
});

afterEach(() => cleanup());

interface ChunkRow {
  id: number;
  chunk_index: number;
  content_hash: string;
}

function chunks(): ChunkRow[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<ChunkRow, [string]>(
        "SELECT c.id, c.chunk_index, c.content_hash FROM chunks c " +
          "JOIN documents d ON d.id = c.document_id WHERE d.path = ? ORDER BY c.chunk_index",
      )
      .all(LOG);
  } finally {
    db.close();
  }
}

function ftsHits(term: string): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db
      .query<{ n: number }, [string]>("SELECT count(*) AS n FROM chunk_fts WHERE chunk_fts MATCH ?")
      .get(term)!.n;
  } finally {
    db.close();
  }
}

function entityRows(): number {
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.query<{ n: number }, []>("SELECT count(*) AS n FROM chunk_entities").get()!.n;
  } finally {
    db.close();
  }
}

test("appending to a document keeps every earlier chunk in place", async () => {
  const config = makeConfig({ vault, dbPath });
  await indexVault(config);
  const before = chunks();
  expect(before.length).toBeGreaterThanOrEqual(3);

  writeMd(
    vault,
    LOG,
    `# Log\n\n${section("alpha")}\n${section("bravo")}\n${section("charlie")}\n${section("delta")}`,
  );
  await indexVault(config);
  const after = chunks();

  expect(after.length).toBeGreaterThan(before.length);
  // Every chunk but the last of the old document survives with its id.
  const kept = before.slice(0, -1);
  expect(after.slice(0, kept.length)).toEqual(kept);
  expect(ftsHits("delta7")).toBeGreaterThan(0);
  expect(ftsHits("alpha7")).toBeGreaterThan(0);
});

test("editing the middle rewrites only the chunks that changed", async () => {
  const config = makeConfig({ vault, dbPath });
  await indexVault(config);
  const before = chunks();

  writeMd(vault, LOG, `# Log\n\n${section("alpha")}\n${section("bravo2")}\n${section("charlie")}`);
  await indexVault(config);
  const after = chunks();

  const sameHash = (a: ChunkRow, b: ChunkRow): boolean =>
    a.chunk_index === b.chunk_index && a.content_hash === b.content_hash;
  for (const row of after) {
    const old = before.find((b) => sameHash(b, row));
    // A chunk at the same position with the same content keeps its id;
    // a changed one is a new row.
    if (old !== undefined) expect(row.id).toBe(old.id);
    else expect(before.map((b) => b.id)).not.toContain(row.id);
  }
  expect(after.filter((r) => before.some((b) => b.id === r.id)).length).toBeGreaterThan(0);
  expect(ftsHits("bravo27")).toBeGreaterThan(0);
  expect(ftsHits("bravo7")).toBe(0);
});

test("shrinking a document removes the chunks past its new end, full-text rows included", async () => {
  const config = makeConfig({ vault, dbPath });
  await indexVault(config);
  writeMd(vault, LOG, `# Log\n\n${section("alpha")}`);
  await indexVault(config);
  expect(ftsHits("charlie7")).toBe(0);
  expect(ftsHits("alpha7")).toBeGreaterThan(0);
  const after = chunks();
  expect(after.map((c) => c.chunk_index)).toEqual(after.map((_, i) => i));
});

test("a kept chunk keeps its entities and a rewritten one gets fresh ones", async () => {
  writeMd(vault, LOG, `# Log\n\nMeeting with Ada Lovelace.\n\n${section("alpha")}`);
  const config = makeConfig({ vault, dbPath });
  await indexVault(config);
  const entitiesBefore = entityRows();
  writeMd(
    vault,
    LOG,
    `# Log\n\nMeeting with Ada Lovelace.\n\n${section("alpha")}\n${section("bravo")}`,
  );
  await indexVault(config);
  expect(entityRows()).toBeGreaterThanOrEqual(entitiesBefore);
});

test("a chunk whose stored full-text form is out of date is rewritten, not kept", async () => {
  const config = makeConfig({ vault, dbPath });
  await indexVault(config);
  // What a release that changes how full-text content is derived would
  // leave behind: same content and hash, a different stored FTS form.
  const db = new Database(dbPath);
  db.run(
    "UPDATE chunks SET fts_content = 'stale-form' WHERE chunk_index = 0 AND document_id = " +
      "(SELECT id FROM documents WHERE path = ?)",
    [LOG],
  );
  db.close();
  writeMd(
    vault,
    LOG,
    `# Log\n\n${section("alpha")}\n${section("bravo")}\n${section("charlie")}\n${section("delta")}`,
  );
  await indexVault(config);
  expect(ftsHits("stale")).toBe(0);
});
