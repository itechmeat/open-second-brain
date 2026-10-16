/**
 * The read path's self-heal keeps compatible stored embeddings (#256).
 *
 * An index left on an older schema by a previous release is upgraded in
 * place: its vectors, the recorded model and the recorded prefixes all
 * survive, so the first search after an upgrade is still hybrid and no
 * paid re-embedding is needed. Only the states a migration cannot repair
 * - a newer schema, missing tables - are rebuilt, and that rebuild says
 * which vectors it dropped and how to get them back.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

import { countStoredEmbeddings, indexVault } from "../../../src/core/search/indexer.ts";
import { LATEST_SCHEMA_VERSION } from "../../../src/core/search/schema.ts";
import { search } from "../../../src/core/search/search.ts";
import { rebuildIndexForSelfHeal } from "../../../src/core/search/self-heal.ts";
import { Store } from "../../../src/core/search/store.ts";
import type { ResolvedSearchConfig } from "../../../src/core/search/types.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";
import { startFakeHttp } from "../../helpers/fake-http.ts";
import { rewindToPreV14Schema, stampSchemaVersion } from "../../helpers/schema-rewind.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";

const VEC = sqliteVecLoadable();

let v: ReturnType<typeof createTempVault>;
let server: Awaited<ReturnType<typeof startFakeHttp>>;
let semantic: ResolvedSearchConfig;
let keywordOnly: ResolvedSearchConfig;

beforeEach(async () => {
  v = createTempVault("selfheal-emb");
  server = await startFakeHttp();
  writeMd(v.vault, "Notes/fox.md", "# Fox\n\nThe quick brown fox jumps over the lazy dog.");
  semantic = makeConfig({
    vault: v.vault,
    dbPath: v.dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: server.url,
      model: "fake-model",
      apiKey: FAKE_PROVIDER_KEY,
      dimension: 4,
      queryPrefix: "query: ",
      passagePrefix: "passage: ",
      maxRetries: 1,
    },
  });
  keywordOnly = makeConfig({ vault: v.vault, dbPath: v.dbPath });
});

afterEach(async () => {
  await server.close();
  v.cleanup();
});

/** The stored-embedding facts a heal must not disturb. */
async function embeddingIdentity(): Promise<{
  schema: string | null;
  vectors: number;
  query: string | null;
  passage: string | null;
}> {
  const s = await Store.open(semantic, { mode: "read" });
  try {
    return {
      schema: s.getState("schema_version"),
      vectors: s.countEmbeddings(),
      query: s.getState("embedding_prefix_query"),
      passage: s.getState("embedding_prefix_passage"),
    };
  } finally {
    await s.close();
  }
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const original = console.error;
  console.error = (msg: string) => lines.push(String(msg));
  try {
    return { result: await fn(), lines };
  } finally {
    console.error = original;
  }
}

test.skipIf(!VEC)(
  "an older-schema semantic index is upgraded in place and the first search is still hybrid",
  async () => {
    await indexVault(semantic, { embeddings: true });
    const before = await embeddingIdentity();
    expect(before.vectors).toBeGreaterThan(0);
    rewindToPreV14Schema(v.dbPath);

    const outcome = await search(semantic, { query: "fox", semantic: true, recordAccess: false });

    expect(outcome.results.some((r) => r.searchType === "hybrid")).toBe(true);
    expect(await embeddingIdentity()).toEqual({ ...before, schema: String(LATEST_SCHEMA_VERSION) });
    // Upgraded, not rebuilt: a rebuild leaves the replaced index behind.
    expect(existsSync(`${v.dbPath}.bak`)).toBe(false);
  },
);

test.skipIf(!VEC)(
  // Issued together from one process; whether the two heals overlap is up
  // to the scheduler, so the name claims only what the assertions show.
  "two searches issued together over an older-schema index both answer and keep the vectors",
  async () => {
    await indexVault(semantic, { embeddings: true });
    const before = await embeddingIdentity();
    rewindToPreV14Schema(v.dbPath);

    const outcomes = await Promise.all([
      search(semantic, { query: "fox", semantic: true, recordAccess: false }),
      search(keywordOnly, { query: "fox", recordAccess: false }),
    ]);

    for (const outcome of outcomes) expect(outcome.results.length).toBeGreaterThan(0);
    expect(await embeddingIdentity()).toEqual({ ...before, schema: String(LATEST_SCHEMA_VERSION) });
    expect(existsSync(`${v.dbPath}.bak`)).toBe(false);
  },
);

test.skipIf(!VEC)(
  "a keyword-only search that repairs an older-schema index leaves the embedding identity alone",
  async () => {
    await indexVault(semantic, { embeddings: true });
    const before = await embeddingIdentity();
    rewindToPreV14Schema(v.dbPath);

    const repaired = await search(keywordOnly, { query: "fox", recordAccess: false });
    expect(repaired.results.length).toBeGreaterThan(0);
    expect(await embeddingIdentity()).toEqual({ ...before, schema: String(LATEST_SCHEMA_VERSION) });

    // The semantic writer that comes next finds its vectors compatible.
    await indexVault(semantic, { embeddings: true });
    expect((await embeddingIdentity()).vectors).toBe(before.vectors);
    const outcome = await search(semantic, { query: "fox", semantic: true, recordAccess: false });
    expect(outcome.results.some((r) => r.searchType === "hybrid")).toBe(true);
  },
);

test.skipIf(!VEC)(
  "a newer-schema index is still rebuilt, and the rebuild names the vectors it dropped",
  async () => {
    await indexVault(semantic, { embeddings: true });
    const { vectors } = await embeddingIdentity();
    stampSchemaVersion(v.dbPath, LATEST_SCHEMA_VERSION + 1);

    const { result: outcome, lines } = await captureStderr(() =>
      search(keywordOnly, { query: "fox", recordAccess: false }),
    );

    expect(outcome.results.length).toBeGreaterThan(0);
    expect(existsSync(`${v.dbPath}.bak`)).toBe(true);
    const notice = lines.find((l) => l.includes("not carried over"));
    expect(notice).toContain(`${vectors} stored embedding(s)`);
    expect(notice).toContain("o2b search index --embeddings");
  },
);

test.skipIf(!VEC)(
  "a self-heal rebuild that finds the index already current builds nothing",
  async () => {
    // The second of two healers decided to rebuild before the first one
    // finished; by the time it holds the writer lock the index is current.
    await indexVault(semantic, { embeddings: true });
    const before = await embeddingIdentity();

    expect(await rebuildIndexForSelfHeal(keywordOnly)).toBeNull();

    expect(await embeddingIdentity()).toEqual(before);
    expect(existsSync(`${v.dbPath}.bak`)).toBe(false);
  },
);

test.skipIf(!VEC)(
  "a second keyword-only rebuild keeps the .bak that still holds the vectors",
  async () => {
    await indexVault(semantic, { embeddings: true });
    const { vectors } = await embeddingIdentity();
    expect(vectors).toBeGreaterThan(0);

    stampSchemaVersion(v.dbPath, LATEST_SCHEMA_VERSION + 1);
    await captureStderr(() => search(keywordOnly, { query: "fox", recordAccess: false }));
    expect(countStoredEmbeddings(`${v.dbPath}.bak`)).toBe(vectors);

    // A second rebuild over the vector-less live index must not replace
    // the only copy of the vectors the first rebuild's notice points at.
    stampSchemaVersion(v.dbPath, LATEST_SCHEMA_VERSION + 1);
    const { result } = await captureStderr(() =>
      search(keywordOnly, { query: "fox", recordAccess: false }),
    );
    expect(result.results.length).toBeGreaterThan(0);
    expect(countStoredEmbeddings(`${v.dbPath}.bak`)).toBe(vectors);
    expect(existsSync(`${v.dbPath}.old`)).toBe(false);
  },
);

test("an index stamped current but missing a table is still rebuilt", async () => {
  await indexVault(keywordOnly);
  const db = new Database(v.dbPath);
  db.exec("DROP TABLE document_attributes");
  db.close();

  const outcome = await search(keywordOnly, { query: "fox", recordAccess: false });

  expect(outcome.results.length).toBeGreaterThan(0);
  expect(existsSync(`${v.dbPath}.bak`)).toBe(true);
});
