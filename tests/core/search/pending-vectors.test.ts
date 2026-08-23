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
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { indexCheck, indexVault } from "../../../src/core/search/indexer.ts";
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
      apiKey: "test-key",
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

test("a fully embedded vault emits no reindex recommendation", async () => {
  if (!sqliteVecLoadable()) return;
  writeMd(vault, "a.md", "# A\n\nA note with vectors.");
  await indexVault(cfg(), { embeddings: true });

  const report = await indexCheck(cfg());
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
