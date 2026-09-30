/**
 * Which stored vectors count as stale when the configuration leaves the
 * embedding dimension unset (PR #220 review).
 *
 * `embedding_dimension` is null unless configured, and the stale count
 * used to return 0 whenever it was null - so on a default configuration
 * a model switch reported no stale vectors at all. The baseline now
 * resolves the dimension the way the indexer does (configured, then the
 * local embedder's default, then the stored value), and with no
 * dimension at all the vectors are compared by model alone.
 */

import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";

import { LOCAL_DEFAULT_DIMENSION } from "../../../src/core/search/embeddings/local-provider.ts";
import { LOCAL_EMBEDDING_MODEL } from "../../../src/core/search/embeddings/signature.ts";
import { staleBaseline } from "../../../src/core/search/store/counts.ts";
import { staleEmbeddings } from "../../../src/core/search/store/vectors.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";

function db(rows: ReadonlyArray<[string, number]>, storedDim: string | null = null): Database {
  const d = new Database(":memory:");
  d.run("CREATE TABLE embeddings (chunk_id INTEGER PRIMARY KEY, model TEXT, dimension INTEGER)");
  d.run("CREATE TABLE index_state (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT)");
  rows.forEach(([model, dim], i) =>
    d.run("INSERT INTO embeddings VALUES (?, ?, ?)", [i + 1, model, dim]),
  );
  if (storedDim !== null) {
    d.run("INSERT INTO index_state VALUES ('embedding_dimension', ?, '')", [storedDim]);
  }
  return d;
}

test("a model switch with no dimension anywhere is still counted as stale", () => {
  const d = db([
    ["old-model", 8],
    ["old-model", 8],
    ["new-model", 8],
  ]);
  expect(staleEmbeddings(d, "new-model", null)).toBe(2);
});

test("with no model there is no baseline and nothing is counted", () => {
  expect(staleEmbeddings(db([["old-model", 8]]), null, null)).toBe(0);
});

test("the baseline dimension falls back to the stored dimension", () => {
  const d = db([], "1536");
  expect(staleBaseline(d, { provider: "openai-compat", model: "m", dimension: null })).toEqual({
    model: "m",
    dimension: 1536,
  });
  expect(staleBaseline(d, { provider: "openai-compat", model: "m", dimension: 8 })).toEqual({
    model: "m",
    dimension: 8,
  });
});

test("the local embedder is named by its built-in model and default dimension", () => {
  expect(staleBaseline(db([]), { provider: "local", model: null, dimension: null })).toEqual({
    model: LOCAL_EMBEDDING_MODEL,
    dimension: LOCAL_DEFAULT_DIMENSION,
  });
});

test("no configured and no stored dimension leaves the dimension unresolved", () => {
  expect(staleBaseline(db([]), { provider: "openai-compat", model: "m", dimension: null })).toEqual(
    { model: "m", dimension: null },
  );
});

test("Store.counts reports vectors from another model as stale with no configured dimension", async () => {
  if (!sqliteVecLoadable()) return;
  const v = createTempVault("stale-baseline-store");
  try {
    writeMd(v.vault, "a.md", "# A\n\nA note embedded under the first model.");
    await indexVault(
      makeConfig({
        vault: v.vault,
        dbPath: v.dbPath,
        semantic: { enabled: true, provider: "local", dimension: 256 },
      }),
      { embeddings: true },
    );
    // The configuration now names another model and leaves the dimension
    // unset - the default setup, where the stale count used to read 0.
    const switched = makeConfig({
      vault: v.vault,
      dbPath: v.dbPath,
      semantic: {
        enabled: true,
        provider: "openai-compat",
        model: "vendor-x/embed-v2",
        dimension: null,
      },
    });
    const store = await Store.open(switched, { mode: "read" });
    try {
      const counts = store.counts();
      expect(counts.embeddings).toBeGreaterThan(0);
      expect(counts.staleEmbeddings).toBe(counts.embeddings);
    } finally {
      await store.close();
    }
  } finally {
    v.cleanup();
  }
});

test("Store.counts names the local embedder by its built-in model", async () => {
  if (!sqliteVecLoadable()) return;
  const v = createTempVault("stale-baseline-local");
  try {
    writeMd(v.vault, "a.md", "# A\n\nA note embedded at 256 dimensions.");
    const local = (dimension: number) =>
      makeConfig({
        vault: v.vault,
        dbPath: v.dbPath,
        semantic: { enabled: true, provider: "local", dimension },
      });
    await indexVault(local(256), { embeddings: true });
    // The local configuration carries no model string: without the
    // baseline naming it, a dimension switch counted nothing as stale.
    const store = await Store.open(local(128), { mode: "read" });
    try {
      const counts = store.counts();
      expect(counts.embeddings).toBeGreaterThan(0);
      expect(counts.staleEmbeddings).toBe(counts.embeddings);
    } finally {
      await store.close();
    }
  } finally {
    v.cleanup();
  }
});
