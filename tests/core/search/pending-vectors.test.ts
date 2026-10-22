/**
 * The MEASURED pending-vector count on `search check`
 * (nothing-writes-silently, unit A).
 *
 * The claims pinned here:
 *
 *   1. `countChunksWithoutEmbeddings` answers the same anti-join
 *      `findChunksWithoutEmbeddings` walks, as a count, without
 *      materialising a single chunk body.
 *   2. An absent index reports the census as UNRECORDED and names the
 *      path - never as a pending count of zero, which would read as a
 *      fully-embedded vault.
 *   3. A file at the index path that is not a readable index reports
 *      unrecorded too, with the reason the open gave.
 *   4. A fully-embedded vault emits NO reindex recommendation. This is
 *      the fix: the branch it replaces had no term for whether vectors
 *      already existed, so a healthy vault was told to "compute the
 *      first vectors".
 *   5. An index whose chunks carry no vector at all still gets that
 *      first-vectors recommendation.
 *   6. A partially embedded index names the measured count and points
 *      at `o2b search vector-backfill`, whose dry run is the surface
 *      that prices the work. The report itself does no cost arithmetic.
 *   7. The unrecorded census recommends building the index and says the
 *      count is unrecorded rather than zero.
 *   8. Both `o2b search check` shapes render the field in every state.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { indexCheck, indexVault, runEmbeddingPhase } from "../../../src/core/search/indexer.ts";
import { Store } from "../../../src/core/search/store.ts";
import { chunkHoldExclusion } from "../../../src/core/search/embedding-spend.ts";
import {
  countChunksWithoutEmbeddings,
  findChunksWithoutEmbeddings,
} from "../../../src/core/search/store/chunks.ts";
import { peekPendingVectorsSync } from "../../../src/core/search/store/counts.ts";
import type { ResolvedEmbeddingConfig } from "../../../src/core/search/types.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { runCli } from "../../helpers/run-cli.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";
import { FAKE_PROVIDER_KEY } from "../../helpers/fake-credentials.ts";

const VEC_LOADABLE = sqliteVecLoadable();

let vault: string;
let dbPath: string;
let cleanup: () => void;
let server: FakeHttp;

beforeEach(async () => {
  const v = createTempVault("pending-vectors");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  server = await startFakeHttp();
});

afterEach(async () => {
  cleanup();
  await server.close();
});

function cfg(semantic: Partial<ResolvedEmbeddingConfig> = {}) {
  return makeConfig({
    vault,
    dbPath,
    semantic: {
      enabled: true,
      provider: "openai-compat",
      baseUrl: server.url,
      model: "fake-model",
      apiKey: FAKE_PROVIDER_KEY,
      dimension: 4,
      timeoutMs: 5_000,
      concurrency: 2,
      batchSize: 8,
      costGateUsd: 0,
      maxRetries: 3,
      ...semantic,
    },
  });
}

/**
 * A temporary directory whose config file records a decline, for the
 * `search check` consent arm.
 */
function fixtureDeclinedConfig(): {
  readonly configPath: string;
  readonly cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "osb-pending-declined-"));
  const configPath = join(dir, "config.yaml");
  writeFileSync(configPath, "search_semantic_enabled: false\n");
  return { configPath, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/**
 * The consent env twins are saved and CLEARED around a test that resolves
 * the consent from the process environment: env values take precedence
 * over the config file, so a developer or CI runner exporting either of
 * them would flip the case no matter what the fixture writes to disk.
 */
function saveAndClearConsentEnv(): () => void {
  const names = ["OPEN_SECOND_BRAIN_SEARCH_SEMANTIC", "OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER"];
  const saved = names.map((name) => [name, process.env[name]] as const);
  for (const name of names) delete process.env[name];
  return () => {
    for (const [name, value] of saved) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}

test("the count agrees with the row walk it replaces", async () => {
  writeMd(vault, "a.md", "# A\n\nFirst note.");
  writeMd(vault, "b.md", "# B\n\nSecond note.");
  await indexVault(makeConfig({ vault, dbPath }));

  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = findChunksWithoutEmbeddings(db);
    expect(rows.length).toBeGreaterThan(0);
    expect(countChunksWithoutEmbeddings(db)).toBe(rows.length);
  } finally {
    db.close();
  }
});

test("a path-scoped census returns only chunks under the prefixes, row walk and count agreeing", async () => {
  writeMd(vault, "Brain/preferences/pref-a.md", "# Pref A\n\nA belief.");
  writeMd(vault, "Brain/retired/pref-b.md", "# Pref B\n\nA retired belief.");
  writeMd(vault, "notes/c.md", "# C\n\nA plain note.");
  await indexVault(makeConfig({ vault, dbPath }));

  const db = new Database(dbPath, { readonly: true });
  try {
    const pathOf = db.query<{ path: string }, [number]>(
      "SELECT d.path AS path FROM chunks c JOIN documents d ON d.id = c.document_id WHERE c.id = ?",
    );
    const all = findChunksWithoutEmbeddings(db);
    for (const pathPrefixes of [["Brain/preferences/"], ["Brain/preferences/", "Brain/retired/"]]) {
      const scoped = findChunksWithoutEmbeddings(db, { pathPrefixes });
      expect(scoped.length).toBeGreaterThan(0);
      expect(scoped.length).toBeLessThan(all.length);
      for (const row of scoped) {
        const path = pathOf.get(row.chunkId)?.path ?? "";
        expect(pathPrefixes.some((prefix) => path.startsWith(prefix))).toBe(true);
      }
      expect(countChunksWithoutEmbeddings(db, { pathPrefixes })).toBe(scoped.length);
    }
    expect(findChunksWithoutEmbeddings(db, { pathPrefixes: [] })).toEqual(all);
    expect(countChunksWithoutEmbeddings(db, { pathPrefixes: [] })).toBe(all.length);
  } finally {
    db.close();
  }
});

test("an absent index is unrecorded and names the path, never a pending count of zero", () => {
  const peek = peekPendingVectorsSync(dbPath);
  expect(peek.kind).toBe("absent");
});

test("a file that is not a readable index is unrecorded with the reason the open gave", () => {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, "not a database");
  const peek = peekPendingVectorsSync(dbPath);
  expect(peek.kind).toBe("unreadable");
});

test.skipIf(!VEC_LOADABLE)("a fully embedded vault emits no reindex recommendation", async () => {
  writeMd(vault, "a.md", "# A\n\nA note with vectors.");
  // `fake-model` is in no price table; declaring its price keeps the
  // unpriced-model hint out of a report that must say nothing at all.
  const priced = cfg({ priceOverride: { model: "fake-model", usdPerMtok: 0 } });
  await indexVault(priced, { embeddings: true });

  const report = await indexCheck(priced);
  expect(report.pendingVectors.verdict).toBe("measured");
  if (report.pendingVectors.verdict === "measured") {
    expect(report.pendingVectors.pending).toBe(0);
    expect(report.pendingVectors.chunks).toBeGreaterThan(0);
  }
  expect(report.recommendations).toEqual([]);
});

test("an index whose chunks carry no vector at all is told to compute the first vectors", async () => {
  if (!sqliteVecLoadable()) return;
  writeMd(vault, "a.md", "# A\n\nA note with no vectors.");
  await indexVault(cfg());

  const report = await indexCheck(cfg());
  expect(report.pendingVectors.verdict).toBe("measured");
  if (report.pendingVectors.verdict === "measured") {
    expect(report.pendingVectors.pending).toBe(report.pendingVectors.chunks);
  }
  expect(report.recommendations.some((r) => r.includes("compute the first vectors"))).toBe(true);
});

test("a partially embedded index names the count and the verb that prices the work", async () => {
  if (!sqliteVecLoadable()) return;
  writeMd(vault, "a.md", "# A\n\nA note with vectors.");
  await indexVault(cfg(), { embeddings: true });
  writeMd(vault, "b.md", "# B\n\nA note indexed without them.");
  await indexVault(cfg());

  const report = await indexCheck(cfg());
  expect(report.pendingVectors.verdict).toBe("measured");
  if (report.pendingVectors.verdict !== "measured") return;
  const { pending, chunks } = report.pendingVectors;
  expect(pending).toBeGreaterThan(0);
  expect(pending).toBeLessThan(chunks);

  const line = report.recommendations.find((r) => r.includes("o2b search vector-backfill"));
  expect(line).toBeDefined();
  expect(line!).toContain(String(pending));
  expect(line!).toContain(String(chunks));
  // The report prices nothing itself: the dry run is where a dollar
  // figure comes from, and a second estimator here could disagree with it.
  expect(line!).not.toContain("$");
  expect(report.recommendations.some((r) => r.includes("compute the first vectors"))).toBe(false);
});

test("an index whose vector-less chunks are all held reports none pending and no backfill", async () => {
  if (!sqliteVecLoadable()) return;
  // A narrow operator-declared window arms the hold for every chunk of
  // ordinary prose: the phase records the holds and embeds nothing, so
  // the index owes no vector for any of them.
  const PROSE =
    "The survey team recorded every measurement in the ledger before the storm reached the harbour wall. ";
  const heldWindow = cfg({ inputWindowTokens: 8 });
  {
    const store = await Store.open(heldWindow, { mode: "write" });
    try {
      const docId = store.upsertDocument({
        path: "Brain/held.md",
        title: "held",
        contentHash: "h-held",
        mtime: 1,
        size: PROSE.length,
      });
      store.replaceChunks(docId, [
        {
          chunkIndex: 0,
          content: PROSE,
          contentHash: "h-held-0",
          startLine: 1,
          endLine: 1,
          tokenCount: 9,
        },
      ]);
    } finally {
      await store.close();
    }
  }
  {
    const store = await Store.open(heldWindow, { mode: "write" });
    try {
      await runEmbeddingPhase(store, heldWindow, {
        embeddingsComputed: 0,
        embeddingsRetries: 0,
      });
    } finally {
      await store.close();
    }
  }

  // The key-free diagnostic read still sees the missing vector: the chunk
  // genuinely has none, which the hold does not erase.
  const hold = chunkHoldExclusion(heldWindow);
  expect(hold).not.toBeNull();
  {
    const db = new Database(dbPath, { readonly: true });
    try {
      expect(countChunksWithoutEmbeddings(db)).toBe(1);
      expect(countChunksWithoutEmbeddings(db, undefined, hold ?? undefined)).toBe(0);
    } finally {
      db.close();
    }
  }
  const peeked = peekPendingVectorsSync(dbPath, hold ?? undefined);
  expect(peeked.kind).toBe("read");
  if (peeked.kind === "read") {
    expect(peeked.value.pending).toBe(0);
    expect(peeked.value.chunks).toBeGreaterThan(0);
  }

  // Declaring the model's price keeps the price hint out of a report
  // whose only job here is the backfill recommendation.
  const priced = cfg({
    inputWindowTokens: 8,
    priceOverride: { model: "fake-model", usdPerMtok: 0 },
  });
  const report = await indexCheck(priced);
  expect(report.pendingVectors.verdict).toBe("measured");
  if (report.pendingVectors.verdict === "measured") {
    expect(report.pendingVectors.pending).toBe(0);
    expect(report.pendingVectors.chunks).toBeGreaterThan(0);
  }
  // The recommendation never clears when it is driven by the raw count:
  // vector-backfill excludes the held chunks, finds nothing to do, and
  // the same state would be re-reported on every check.
  expect(report.recommendations.some((r) => r.includes("vector-backfill"))).toBe(false);
  expect(report.recommendations.some((r) => r.includes("compute the first vectors"))).toBe(false);
});

test("a declined vault reports the probe as skipped with the decline, never as unconfigured", async () => {
  if (!sqliteVecLoadable()) return;
  const f = fixtureDeclinedConfig();
  const restoreConsentEnv = saveAndClearConsentEnv();
  try {
    const config = Object.freeze({
      ...makeConfig({
        vault,
        dbPath,
        semantic: { enabled: false },
      }),
      configPath: f.configPath,
    });
    const report = await indexCheck(config);
    // A decline is a decision recorded in the machine configuration, and
    // the probe names it: skipped, with the consent's own sentence, on
    // the same state an absent configuration used to read as
    // not-configured.
    expect(report.providerProbe).toBe("skipped");
    expect(report.providerReason ?? "").toContain("provider consent declined");
    expect(report.providerReason ?? "").toContain("search_semantic_enabled=true");
  } finally {
    restoreConsentEnv();
    f.cleanup();
  }
});

test("an index that could not be read recommends building it and says so", async () => {
  if (!sqliteVecLoadable()) return;
  writeMd(vault, "a.md", "# A\n\nA note.");

  const report = await indexCheck(cfg());
  expect(report.pendingVectors.verdict).toBe("unrecorded");
  if (report.pendingVectors.verdict === "unrecorded") {
    expect(report.pendingVectors.reason.length).toBeGreaterThan(0);
  }
  expect(report.recommendations.some((r) => r.includes("unrecorded"))).toBe(true);
});

test("both `o2b search check` shapes render the census in every state", async () => {
  writeMd(vault, "a.md", "# A\n\nA note.");
  await indexVault(makeConfig({ vault, dbPath }));

  const json = await runCli(["search", "check", "--json", "--vault", vault, "--db", dbPath]);
  expect(json.returncode).toBe(0);
  const parsed = JSON.parse(json.stdout) as Record<string, unknown>;
  const census = parsed["pending_vectors"] as Record<string, unknown>;
  expect(census["verdict"]).toBe("measured");
  expect(census["pending"]).toBe(census["chunks"]);

  const human = await runCli(["search", "check", "--vault", vault, "--db", dbPath]);
  expect(human.stdout).toContain("pending_vectors:");
});
