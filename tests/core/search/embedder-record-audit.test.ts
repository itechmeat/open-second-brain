/**
 * The record-vs-data embedder audit (nothing-writes-silently, unit G).
 *
 * `index_state` records the dimension an index was written under, and
 * until now nothing compared that record against the width the index
 * ACTUALLY stores. A meta row claiming 8 over 4-wide vectors was
 * invisible: the ABI stamp compares the record against this build, and
 * `staleEmbeddings` compares the rows against the CONFIGURED model -
 * neither compares the record against the data it describes.
 *
 * The claims pinned here:
 *
 *   1. A store whose record matches its vectors audits `complete`, with
 *      the stored width and the vec0 declared width both accounted for.
 *   2. A record contradicting the stored width audits `contradicted` in
 *      the wave's shared reconciliation vocabulary, and `missing` NAMES
 *      the observation that disagrees rather than reporting a count.
 *   3. That state is distinct from ABI drift: a tampered record produces
 *      both, and they say different things - one that the record
 *      disagrees with this build, one that it disagrees with the data.
 *   4. An index that records no dimension, or holds no vectors to
 *      compare, is UNRECORDED - the same distinction
 *      `contradictedAbiFields` already draws for a null recorded token.
 *   5. An absent index is unrecorded and names the path.
 *   6. The contradiction reaches `search check` as a warning and a
 *      recommendation naming the rebuild, and the JSON carries the
 *      audit in every state.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { RECONCILIATION_OUTCOME } from "../../../src/core/reconciliation-report.ts";
import { indexCheck, indexVault } from "../../../src/core/search/indexer.ts";
import {
  EMBEDDING_ABI_FIX_COMMAND,
  EMBEDDING_DIMENSION_STATE_KEY,
  Store,
} from "../../../src/core/search/store.ts";
import { readEmbedderRecordCensusSync } from "../../../src/core/search/store/embedder-audit.ts";
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
  const v = createTempVault("embedder-record");
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

/** Mutate recorded state behind the stamp's back, as another build would. */
async function tamper(edit: (store: Store) => void): Promise<void> {
  const store = await Store.open(cfg(), { mode: "write" });
  edit(store);
  await store.close();
}

async function indexWithVectors(): Promise<void> {
  writeMd(vault, "a.md", "# A\n\nA note with vectors.");
  await indexVault(cfg(), { embeddings: true });
}

test("a record that matches the vectors it describes audits complete", async () => {
  if (!sqliteVecLoadable()) return;
  await indexWithVectors();

  const census = readEmbedderRecordCensusSync(dbPath);
  expect(census.verdict).toBe("audited");
  if (census.verdict !== "audited") return;
  expect(census.recordedDimension).toBe(4);
  expect(census.storedDimensions).toEqual([4]);
  expect(census.vecDeclaredWidth).toBe(4);
  expect(census.outcome).toBe(RECONCILIATION_OUTCOME.complete);
  // Both observations - the stored rows and the vec0 declaration - were
  // compared, and the reconciliation accounts for each one.
  expect(census.reconciliation.attempted).toBe(2);
  expect(census.reconciliation.found).toBe(2);
  expect(census.reconciliation.missing).toEqual([]);
});

test("a record contradicting the stored width names the observation that disagrees", async () => {
  if (!sqliteVecLoadable()) return;
  await indexWithVectors();
  await tamper((s) => s.setState(EMBEDDING_DIMENSION_STATE_KEY, "8"));

  const census = readEmbedderRecordCensusSync(dbPath);
  expect(census.verdict).toBe("audited");
  if (census.verdict !== "audited") return;
  expect(census.recordedDimension).toBe(8);
  expect(census.outcome).toBe(RECONCILIATION_OUTCOME.contradicted);
  // A count would say two observations went unaccounted for. The keys
  // say WHICH, which is the whole point of the shared vocabulary.
  expect(census.reconciliation.missing).toContain("embeddings.dimension=4");
  expect(census.reconciliation.found).toBe(0);
});

test("the contradiction is a different statement from ABI drift", async () => {
  if (!sqliteVecLoadable()) return;
  await indexWithVectors();
  await tamper((s) => s.setState(EMBEDDING_DIMENSION_STATE_KEY, "8"));

  const report = await indexCheck(cfg());
  // The record disagrees with this build...
  expect(report.embeddingAbi.map((m) => m.field)).toContain(EMBEDDING_DIMENSION_STATE_KEY);
  // ...and, separately, with the data it claims to describe.
  expect(report.embedderRecord.verdict).toBe("audited");
  if (report.embedderRecord.verdict !== "audited") return;
  expect(report.embedderRecord.outcome).toBe(RECONCILIATION_OUTCOME.contradicted);
  expect(report.warnings.some((w) => w.includes("contradict that record"))).toBe(true);
  expect(
    report.recommendations.some(
      (r) => r.includes("contradict that record") && r.includes(EMBEDDING_ABI_FIX_COMMAND),
    ),
  ).toBe(true);
});

test("an index with nothing stored to compare is unrecorded, never a clean audit", async () => {
  writeMd(vault, "a.md", "# A\n\nA note with no vectors.");
  await indexVault(makeConfig({ vault, dbPath }));

  const census = readEmbedderRecordCensusSync(dbPath);
  expect(census.verdict).toBe("unrecorded");
  if (census.verdict !== "unrecorded") return;
  expect(census.reason.length).toBeGreaterThan(0);
});

test("an absent index is unrecorded and names the path", () => {
  const census = readEmbedderRecordCensusSync(dbPath);
  expect(census.verdict).toBe("unrecorded");
  if (census.verdict !== "unrecorded") return;
  expect(census.reason).toContain(dbPath);
});

test("a file that is not an index is unrecorded, not audited", () => {
  mkdirSync(dirname(dbPath), { recursive: true });
  writeFileSync(dbPath, "not a database");
  expect(readEmbedderRecordCensusSync(dbPath).verdict).toBe("unrecorded");
});

test("`o2b search check --json` carries the audit in every state", async () => {
  writeMd(vault, "a.md", "# A\n\nA note.");
  await indexVault(makeConfig({ vault, dbPath }));

  const out = await runCli(["search", "check", "--json", "--vault", vault, "--db", dbPath]);
  expect(out.returncode).toBe(0);
  const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
  const audit = parsed["embedder_record"] as Record<string, unknown>;
  expect(audit["verdict"]).toBe("unrecorded");
  expect(typeof audit["reason"]).toBe("string");

  const human = await runCli(["search", "check", "--vault", vault, "--db", dbPath]);
  expect(human.stdout).toContain("embedder_record:");
});
