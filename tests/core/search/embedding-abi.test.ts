/**
 * Embedding ABI stamp and read-path mismatch detection
 * (context-integrity-gates, Unit E / Task 10).
 *
 * `index_state` already stamps the embedding model and dimension, but
 * the comparison ran ONLY on a write-mode open. Every MCP query is a
 * read-mode open, so `semanticTopK` executed `WHERE v.embedding MATCH ?`
 * against a `chunk_vec` of unknown declared width with nothing checking
 * it. These tests pin the stamp (now including the sqlite-vec version),
 * the read-path comparison, and its gate.
 *
 * Vector assertions are skipped where the sqlite-vec extension cannot be
 * loaded, following the repository-wide `sqliteVecLoadable()` pattern.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { indexCheck, indexStatus, indexVault } from "../../../src/core/search/indexer.ts";
import {
  EMBEDDING_ABI_FIX_COMMAND,
  EMBEDDING_DIMENSION_STATE_KEY,
  EMBEDDING_VEC_VERSION_STATE_KEY,
  Store,
} from "../../../src/core/search/store.ts";
import { SearchError, type ResolvedEmbeddingConfig } from "../../../src/core/search/types.ts";
import { startFakeHttp, type FakeHttp } from "../../helpers/fake-http.ts";
import { runCli } from "../../helpers/run-cli.ts";
import { createTempVault, makeConfig, writeMd } from "../../helpers/search-fixtures.ts";
import { sqliteVecLoadable } from "../../helpers/sqlite-vec.ts";

let vault: string;
let dbPath: string;
let cleanup: () => void;
let server: FakeHttp;

beforeEach(async () => {
  const v = createTempVault("embedding-abi");
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

/** Write a `_brain.yaml` selecting the `integrity.embedding_abi` mode. */
function writeGate(mode: string): void {
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(
    join(vault, "Brain", "_brain.yaml"),
    ["schema_version: 1", "integrity:", `  embedding_abi: ${mode}`, ""].join("\n"),
  );
}

/**
 * Mutate recorded ABI state behind the stamp's back. The write open
 * re-stamps first, so the edit lands after `ensureEmbeddingModel` and
 * survives the close - which is exactly the shape of a store written by
 * a different build.
 */
async function tamper(edit: (store: Store) => void): Promise<void> {
  const store = await Store.open(cfg(), { mode: "write" });
  edit(store);
  await store.close();
}

test("a write open stamps the runtime sqlite-vec version beside the model and dimension", async () => {
  if (!sqliteVecLoadable()) return;
  const store = await Store.open(cfg(), { mode: "write" });
  const recorded = store.getState(EMBEDDING_VEC_VERSION_STATE_KEY);
  expect(recorded).toBe(store.vecVersion());
  expect(typeof recorded).toBe("string");
  expect((recorded as string).length).toBeGreaterThan(0);
  await store.close();
});

test("the vec_version stamp is dropped when a model change clears the vectors it described", async () => {
  if (!sqliteVecLoadable()) return;
  const first = await Store.open(cfg(), { mode: "write" });
  expect(first.getState(EMBEDDING_VEC_VERSION_STATE_KEY)).not.toBe(null);
  await first.close();

  // A model change clears the embeddings. The recorded vec_version
  // described those vectors, so it must not survive them; with the
  // extension unavailable on this open there is no runtime value to
  // re-stamp, which makes the delete observable.
  const second = await Store.open(cfg({ model: "other-model" }), {
    mode: "write",
    loadVec: false,
  });
  expect(second.getState(EMBEDDING_VEC_VERSION_STATE_KEY)).toBe(null);
  await second.close();
});

test("a read-mode open detects a recorded-vs-configured dimension mismatch", async () => {
  if (!sqliteVecLoadable()) return;
  await tamper((s) => s.setState(EMBEDDING_DIMENSION_STATE_KEY, "8"));

  const store = await Store.open(cfg(), { mode: "read" });
  const drift = store.embeddingAbiMismatches();
  expect(drift.map((m) => m.field)).toContain(EMBEDDING_DIMENSION_STATE_KEY);
  const dim = drift.find((m) => m.field === EMBEDDING_DIMENSION_STATE_KEY)!;
  expect(dim.expected).toBe("8");
  expect(dim.actual).toBe("4");
  await store.close();
});

test("a matching store reports no drift on a read-mode open", async () => {
  if (!sqliteVecLoadable()) return;
  const written = await Store.open(cfg(), { mode: "write" });
  await written.close();

  const store = await Store.open(cfg(), { mode: "read" });
  expect(store.embeddingAbiMismatches()).toEqual([]);
  await store.close();
});

test("under `fail` a read-mode open refuses a drifted store and names the fix", async () => {
  if (!sqliteVecLoadable()) return;
  writeGate("fail");
  await tamper((s) => s.setState(EMBEDDING_DIMENSION_STATE_KEY, "8"));

  let raised: unknown = null;
  try {
    const store = await Store.open(cfg(), { mode: "read" });
    await store.close();
  } catch (e) {
    raised = e;
  }
  expect(raised).toBeInstanceOf(SearchError);
  const err = raised as SearchError;
  expect(err.code).toBe("EMBEDDING_DIMENSION_MISMATCH");
  expect(err.message).toContain(EMBEDDING_DIMENSION_STATE_KEY);
  expect(err.message).toContain(EMBEDDING_ABI_FIX_COMMAND);
});

test("under `warn` a drifted store still opens for reading", async () => {
  if (!sqliteVecLoadable()) return;
  writeGate("warn");
  await tamper((s) => s.setState(EMBEDDING_DIMENSION_STATE_KEY, "8"));

  const store = await Store.open(cfg(), { mode: "read" });
  expect(store.embeddingAbiMismatches().length).toBeGreaterThan(0);
  await store.close();
});

test("under `off` a read-mode open compares nothing at all", async () => {
  if (!sqliteVecLoadable()) return;
  writeGate("off");
  await tamper((s) => s.setState(EMBEDDING_DIMENSION_STATE_KEY, "8"));

  const store = await Store.open(cfg(), { mode: "read" });
  expect(store.embeddingAbiMismatches()).toEqual([]);
  await store.close();
});

test("a legacy store with no recorded vec_version warns rather than erroring, even under `fail`", async () => {
  if (!sqliteVecLoadable()) return;
  writeGate("fail");
  await tamper((s) => s.deleteState(EMBEDDING_VEC_VERSION_STATE_KEY));

  // `null` means UNRECORDED, not "different". An old store cannot be
  // told apart from a wrong one by a value it never wrote, so it is
  // reported and never refused.
  const store = await Store.open(cfg(), { mode: "read" });
  const drift = store.embeddingAbiMismatches();
  const vec = drift.find((m) => m.field === EMBEDDING_VEC_VERSION_STATE_KEY);
  expect(vec).toBeDefined();
  expect(vec!.expected).toBe(null);
  expect(typeof vec!.actual).toBe("string");
  await store.close();
});

test("indexStatus surfaces the drift as a reindex-required warning", async () => {
  if (!sqliteVecLoadable()) return;
  writeMd(vault, "a.md", "# A\n\nA note with vectors.");
  await indexVault(cfg(), { embeddings: true });
  await tamper((s) => s.setState(EMBEDDING_DIMENSION_STATE_KEY, "8"));

  const status = await indexStatus(cfg());
  const warning = status.warnings.find((w) => w.includes(EMBEDDING_DIMENSION_STATE_KEY));
  expect(warning).toBeDefined();
  expect(warning!).toContain(EMBEDDING_ABI_FIX_COMMAND);
  // The same finding, machine-readable, so a consumer need not match on
  // message text. Both sides are emitted under one condition.
  expect(status.embeddingAbi.map((m) => m.field)).toContain(EMBEDDING_DIMENSION_STATE_KEY);
});

test("indexStatus on a matching store adds no ABI warning", async () => {
  if (!sqliteVecLoadable()) return;
  writeMd(vault, "a.md", "# A\n\nA note with vectors.");
  await indexVault(cfg(), { embeddings: true });

  const status = await indexStatus(cfg());
  expect(status.warnings.some((w) => w.includes(EMBEDDING_VEC_VERSION_STATE_KEY))).toBe(false);
  expect(status.warnings.some((w) => w.includes(EMBEDDING_DIMENSION_STATE_KEY))).toBe(false);
});

test("`search check` reports the stored-vs-runtime mismatch with a copy-pasteable fix", async () => {
  if (!sqliteVecLoadable()) return;
  writeMd(vault, "a.md", "# A\n\nA note with vectors.");
  await indexVault(cfg(), { embeddings: true });
  await tamper((s) => s.setState(EMBEDDING_DIMENSION_STATE_KEY, "8"));

  const report = await indexCheck(cfg());
  expect(report.embeddingAbi.map((m) => m.field)).toContain(EMBEDDING_DIMENSION_STATE_KEY);
  // Keyed on the drifted field, not on the command alone: an unrelated
  // "no vectors yet" hint already names the same command.
  expect(
    report.recommendations.some(
      (r) => r.includes(EMBEDDING_DIMENSION_STATE_KEY) && r.includes(EMBEDDING_ABI_FIX_COMMAND),
    ),
  ).toBe(true);
});

test("under `off` the diagnostic still reports what the serving path stopped enforcing", async () => {
  if (!sqliteVecLoadable()) return;
  writeGate("off");
  writeMd(vault, "a.md", "# A\n\nA note with vectors.");
  await indexVault(cfg(), { embeddings: true });
  await tamper((s) => s.setState(EMBEDDING_DIMENSION_STATE_KEY, "8"));

  // The split is deliberate and must survive any later "unify these two"
  // refactor: `indexStatus` reports what the GATED read open enforced,
  // so `off` silences it; `indexCheck` is a diagnostic the operator
  // explicitly ran and refuses nothing, so it compares ungated.
  const status = await indexStatus(cfg());
  expect(status.embeddingAbi).toEqual([]);
  expect(status.warnings.some((w) => w.includes(EMBEDDING_ABI_FIX_COMMAND))).toBe(false);

  const report = await indexCheck(cfg());
  expect(report.embeddingAbi.map((m) => m.field)).toContain(EMBEDDING_DIMENSION_STATE_KEY);
});

test("`search check` on a matching store reports no ABI drift", async () => {
  if (!sqliteVecLoadable()) return;
  writeMd(vault, "a.md", "# A\n\nA note with vectors.");
  await indexVault(cfg(), { embeddings: true });

  const report = await indexCheck(cfg());
  expect(report.embeddingAbi).toEqual([]);
  expect(report.recommendations.some((r) => r.includes(EMBEDDING_DIMENSION_STATE_KEY))).toBe(false);
});

test("`search check` on a vault with no index reports no ABI drift", async () => {
  const report = await indexCheck(cfg());
  expect(report.embeddingAbi).toEqual([]);
});

test("`o2b search check --json` omits the ABI key entirely when nothing drifted", async () => {
  const out = await runCli(["search", "check", "--json", "--vault", vault, "--db", dbPath]);
  expect(out.returncode).toBe(0);
  const parsed = JSON.parse(out.stdout) as Record<string, unknown>;
  expect("embedding_abi" in parsed).toBe(false);
});
