/**
 * The post-upgrade maintenance and the read path must agree about an
 * index on an older schema: an in-place upgrade exists, so nothing is
 * rebuilt in the background, and the read that meets the old index
 * upgrades it in place - the same repair, whether the read came from the
 * command line or from the MCP server.
 *
 * Pinned here: a background start starts no rebuild for an index an
 * in-place upgrade repairs, and the read path upgrades that index in
 * place afterwards.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { ensureVaultCurrent } from "../../../src/core/maintenance/ensure-current.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import {
  DEFAULT_FTS_TOKENIZE,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  readSchemaVersion,
} from "../../../src/core/search/schema.ts";
import { openReadOrSelfHeal } from "../../../src/core/search/pipeline/store-open.ts";
import { healIndex } from "../../../src/core/search/self-heal.ts";
import { CHUNKER_VERSION } from "../../../src/core/search/chunker.ts";
import { readSelfHealReindexRows } from "../../../src/core/maintenance/self-heal-reindex.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { CLI_CHILD_LIMIT_MS, CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// A test here starts the detached self-heal worker and waits for it;
// see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let vault: string;
let configHome: string;
let configPath: string;
let prevConfigEnv: string | undefined;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-ensure-oldschema-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-ensure-oldschema-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  prevConfigEnv = process.env["OPEN_SECOND_BRAIN_CONFIG"];
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
});

afterEach(() => {
  if (prevConfigEnv === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
  else process.env["OPEN_SECOND_BRAIN_CONFIG"] = prevConfigEnv;
  rmSync(vault, { recursive: true, force: true });
  rmSync(configHome, { recursive: true, force: true });
});

function dbPath(): string {
  return resolveSearchConfig({ vault, configPath }).dbPath;
}

function indexSchema(): number {
  const db = new Database(dbPath(), { readonly: true });
  try {
    return readSchemaVersion(db);
  } finally {
    db.close();
  }
}

/**
 * Build an index file the way a binary one schema version back left it,
 * with one chunk and its entity row in it. `chunkerVersion` is the chunker
 * stamp that file carries: "3" is the older entity rule (a refresh in
 * place repairs it), the current one is current.
 */
function buildIndexAtVersion(version: number, chunker?: string): void {
  const path = dbPath();
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  try {
    db.exec("BEGIN");
    for (const m of MIGRATIONS) {
      if (m.version > version) continue;
      m.up(db, { ftsTokenize: DEFAULT_FTS_TOKENIZE, trigram: true });
    }
    db.run(
      "INSERT INTO index_state(key, value, updated_at) VALUES ('schema_version', ?, '') " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [String(version)],
    );
    db.run(
      "INSERT INTO index_state(key, value, updated_at) VALUES ('chunker_version', ?, '') " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      [chunker ?? String(CHUNKER_VERSION)],
    );
    db.run(
      "INSERT INTO documents(id, path, basename, title, content_hash, mtime, size, created_at, updated_at, indexed_at) " +
        "VALUES (1, 'notes/heron.md', 'heron', NULL, 'h', 0, 0, '', '', '')",
    );
    db.run(
      "INSERT INTO chunks(id, document_id, chunk_index, content, fts_content, content_hash, start_line, end_line, token_count, created_at, updated_at) " +
        "VALUES (1, 1, 0, 'grey herons wade', 'grey herons wade', 'c', 1, 1, 3, '', '')",
    );
    db.run("INSERT INTO chunk_entities(chunk_id, entity) VALUES (1, 'heron')");
    // Stored embeddings: an index that holds them is refreshed in place
    // rather than rebuilt, so the repair keeps its vectors.
    db.run(
      "INSERT INTO embeddings(chunk_id, model, dimension, embedding_hash, created_at, updated_at) " +
        "VALUES (1, 'probe', 4, 'h', '', '')",
    );
    db.exec("COMMIT");
  } finally {
    db.close(true);
  }
}

/** The chunker stamp the index carries. */
function chunkerVersion(): string | null {
  const db = new Database(dbPath(), { readonly: true });
  try {
    return (
      db
        .query<{ value: string }, []>("SELECT value FROM index_state WHERE key = 'chunker_version'")
        .get()?.value ?? null
    );
  } finally {
    db.close();
  }
}

test("a background start starts no rebuild for an index an in-place upgrade repairs", async () => {
  await bootstrapBrain(vault);
  buildIndexAtVersion(LATEST_SCHEMA_VERSION - 1);

  const result = await ensureVaultCurrent(vault, { background: true, configPath });

  // No child was started: an in-place upgrade exists, and the read that
  // meets the old index performs it.
  expect(result.reindexSpawn).toBe(null);
  expect(result.reindexTriggered).toBe(false);
  expect(indexSchema()).toBe(LATEST_SCHEMA_VERSION - 1);
});

test("a background start keeps the repair an older schema still owes beyond the upgrade", async () => {
  await bootstrapBrain(vault);
  // An older schema AND entity rows of the older rule: the upgrade is not
  // the whole repair, so the background heal still owns one.
  buildIndexAtVersion(LATEST_SCHEMA_VERSION - 1, "3");

  const result = await ensureVaultCurrent(vault, { background: true, configPath });

  // The child starts: it upgrades the schema, re-plans and refreshes the
  // entity rows. A schema-only old index starts nothing (the read that
  // meets it upgrades it in place) - this one owes more than that.
  expect(result.reindexSpawn).toBe("spawned");

  // The child's own outcome row is the completion event. The deadline ends
  // before the file's own budget, so a worker that never finishes fails the
  // test with the state it left instead of hanging past its timeout.
  const deadline = Date.now() + CLI_CHILD_LIMIT_MS;
  while (Date.now() < deadline && !readSelfHealReindexRows(vault).some((r) => r.outcome !== null)) {
    // eslint-disable-next-line no-await-in-loop
    await Bun.sleep(100);
  }
  // Current on both counts: the schema and the chunker rule.
  expect(indexSchema()).toBe(LATEST_SCHEMA_VERSION);
  expect(chunkerVersion()).toBe(String(CHUNKER_VERSION));
});

test("an older schema with entity rows of the older rule ends current on both counts", async () => {
  await bootstrapBrain(vault);
  buildIndexAtVersion(LATEST_SCHEMA_VERSION - 1, "3");

  const healed = await healIndex(resolveSearchConfig({ vault, configPath }));

  expect(healed.kind).toBe("migrated");
  expect(indexSchema()).toBe(LATEST_SCHEMA_VERSION);
  expect(chunkerVersion()).toBe(String(CHUNKER_VERSION));
});

test("the read that meets the old index upgrades it in place", async () => {
  await bootstrapBrain(vault);
  buildIndexAtVersion(LATEST_SCHEMA_VERSION - 1);

  const store = await openReadOrSelfHeal(resolveSearchConfig({ vault, configPath }), {
    serveBuilding: true,
  });
  await store.close();

  expect(indexSchema()).toBe(LATEST_SCHEMA_VERSION);
  // The upgrade happened in place: the same file, no staging index left.
  expect(existsSync(dbPath() + ".new")).toBe(false);
});
