/**
 * `o2b search restamp` (nothing-writes-silently, unit G).
 *
 * The sqlite-vec version an index recorded is a pure ABI token: it
 * describes the extension build the vectors were written under, not the
 * vectors themselves. Two peers on different sqlite-vec builds each see
 * the other's store as drifted, which is exactly why the ABI gate
 * defaults to `warn` rather than refusing - and until now the only way
 * to clear that warning was to re-embed the whole vault at provider
 * prices for a token no vector depends on.
 *
 * The claims pinned here:
 *
 *   1. Dry run is the DEFAULT: it prints the change it would make and
 *      leaves `index_state` byte-identical.
 *   2. `--apply` restamps the vec_version cell and nothing else.
 *   3. A second run has nothing to do and says so, rather than
 *      re-writing a cell that already holds the value.
 *   4. A recorded model or dimension that disagrees with this build is
 *      REFUSED by name, with the deferral stated: that repair needs
 *      re-embedding, which this verb will not do behind an operator's
 *      back.
 *   5. An absent index is refused, naming the path.
 *   6. No path through the verb contacts an embedding provider.
 */

import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";

import { indexVault } from "../../src/core/search/indexer.ts";
import {
  EMBEDDING_DIMENSION_STATE_KEY,
  EMBEDDING_MODEL_STATE_KEY,
  EMBEDDING_VEC_VERSION_STATE_KEY,
} from "../../src/core/search/store.ts";
import { getState, setState } from "../../src/core/search/store/state.ts";
import { createTempVault, makeConfig, writeMd } from "../helpers/search-fixtures.ts";
import { startFakeHttp, type FakeHttp } from "../helpers/fake-http.ts";
import { runCli } from "../helpers/run-cli.ts";
import { sqliteVecLoadable } from "../helpers/sqlite-vec.ts";

const VEC_LOADABLE = sqliteVecLoadable();

/** A version string no sqlite-vec build reports, so the drift is real. */
const STALE_VEC_VERSION = "v0.0.0-from-another-machine";

let vault: string;
let dbPath: string;
let configPath: string;
let cleanup: () => void;
let server: FakeHttp;

beforeEach(async () => {
  const v = createTempVault("search-restamp");
  vault = v.vault;
  dbPath = v.dbPath;
  cleanup = v.cleanup;
  server = await startFakeHttp();
  configPath = join(vault, "cli-config.yaml");
});

afterEach(async () => {
  cleanup();
  await server.close();
});

function semanticConfig() {
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
    },
  });
}

async function writeConfig(): Promise<void> {
  await Bun.write(
    configPath,
    [
      `vault: "${vault}"`,
      "search_semantic_enabled: true",
      "embedding_provider: openai-compat",
      `embedding_base_url: "${server.url}"`,
      "embedding_model: fake-model",
      "embedding_api_key: test-key",
      "embedding_dimension: 4",
      "",
    ].join("\n"),
  );
}

function readState(key: string): string | null {
  const db = new Database(dbPath, { readonly: true });
  try {
    return getState(db, key);
  } finally {
    db.close();
  }
}

function writeStateDirectly(key: string, value: string): void {
  const db = new Database(dbPath);
  try {
    setState(db, key, value);
  } finally {
    db.close();
  }
}

async function indexWithVectors(): Promise<void> {
  writeMd(vault, "a.md", "# A\n\nA note with vectors.");
  await indexVault(semanticConfig(), { embeddings: true });
  await writeConfig();
}

function restamp(...extra: ReadonlyArray<string>) {
  return runCli(
    ["search", "restamp", "--vault", vault, "--db", dbPath, "--config", configPath, ...extra],
    { env: { OPEN_SECOND_BRAIN_CONFIG: configPath } },
  );
}

test.skipIf(!VEC_LOADABLE)("the dry run prints the change and writes nothing", async () => {
  await indexWithVectors();
  const current = readState(EMBEDDING_VEC_VERSION_STATE_KEY);
  expect(typeof current).toBe("string");
  writeStateDirectly(EMBEDDING_VEC_VERSION_STATE_KEY, STALE_VEC_VERSION);

  const callsBefore = server.callCount();
  const run = await restamp();
  expect(run.returncode).toBe(0);
  expect(run.stdout).toContain("dry-run");
  expect(run.stdout).toContain(STALE_VEC_VERSION);
  expect(run.stdout).toContain(current as string);
  expect(run.stdout).toContain("--apply");
  // The cell is exactly as the dry run found it.
  expect(readState(EMBEDDING_VEC_VERSION_STATE_KEY)).toBe(STALE_VEC_VERSION);
  // Nothing here asks a provider anything: the only calls on the record
  // are the ones the fixture's own indexing run made.
  expect(server.callCount()).toBe(callsBefore);
});

test.skipIf(!VEC_LOADABLE)("--apply restamps the vec_version cell and nothing else", async () => {
  await indexWithVectors();
  const current = readState(EMBEDDING_VEC_VERSION_STATE_KEY) as string;
  const model = readState(EMBEDDING_MODEL_STATE_KEY);
  const dimension = readState(EMBEDDING_DIMENSION_STATE_KEY);
  writeStateDirectly(EMBEDDING_VEC_VERSION_STATE_KEY, STALE_VEC_VERSION);

  const callsBefore = server.callCount();
  const run = await restamp("--apply", "--json");
  expect(run.returncode).toBe(0);
  const payload = JSON.parse(run.stdout) as Record<string, unknown>;
  expect(payload["applied"]).toBe(true);
  expect(payload["field"]).toBe(EMBEDDING_VEC_VERSION_STATE_KEY);
  expect(payload["recorded"]).toBe(STALE_VEC_VERSION);
  expect(payload["runtime"]).toBe(current);

  expect(readState(EMBEDDING_VEC_VERSION_STATE_KEY)).toBe(current);
  expect(readState(EMBEDDING_MODEL_STATE_KEY)).toBe(model);
  expect(readState(EMBEDDING_DIMENSION_STATE_KEY)).toBe(dimension);
  expect(server.callCount()).toBe(callsBefore);
});

test.skipIf(!VEC_LOADABLE)("a store already at this version has nothing to do", async () => {
  await indexWithVectors();

  const run = await restamp("--json");
  expect(run.returncode).toBe(0);
  const payload = JSON.parse(run.stdout) as Record<string, unknown>;
  expect(payload["changed"]).toBe(false);
  expect(payload["applied"]).toBe(false);
});

test.skipIf(!VEC_LOADABLE)(
  "a recorded dimension that disagrees is refused by name, with the deferral stated",
  async () => {
    await indexWithVectors();
    writeStateDirectly(EMBEDDING_VEC_VERSION_STATE_KEY, STALE_VEC_VERSION);
    writeStateDirectly(EMBEDDING_DIMENSION_STATE_KEY, "8");

    const callsBefore = server.callCount();
    const run = await restamp("--apply");
    expect(run.returncode).not.toBe(0);
    expect(run.stderr).toContain(EMBEDDING_DIMENSION_STATE_KEY);
    expect(run.stderr).toContain("deferred");
    // The refusal wrote nothing: the stale token is still there.
    expect(readState(EMBEDDING_VEC_VERSION_STATE_KEY)).toBe(STALE_VEC_VERSION);
    expect(server.callCount()).toBe(callsBefore);
  },
);

test.skipIf(!VEC_LOADABLE)("a recorded model that disagrees is refused by name too", async () => {
  await indexWithVectors();
  writeStateDirectly(EMBEDDING_VEC_VERSION_STATE_KEY, STALE_VEC_VERSION);
  writeStateDirectly(EMBEDDING_MODEL_STATE_KEY, "some-other-model");

  const run = await restamp("--apply");
  expect(run.returncode).not.toBe(0);
  expect(run.stderr).toContain(EMBEDDING_MODEL_STATE_KEY);
  expect(readState(EMBEDDING_VEC_VERSION_STATE_KEY)).toBe(STALE_VEC_VERSION);
});

test("an absent index is refused, naming the path", async () => {
  await writeConfig();
  const run = await restamp();
  expect(run.returncode).not.toBe(0);
  expect(run.stderr).toContain(dbPath);
  expect(server.callCount()).toBe(0);
});
