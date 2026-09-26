/**
 * Hands-off post-upgrade maintenance: ensureVaultCurrent must, on an
 * already-initialised vault, migrate stale Brain managed files and rebuild a
 * stale/missing search index - idempotently, never throwing, and (in the
 * foreground mode used here) deterministically.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureVaultCurrent } from "../../../src/core/maintenance/ensure-current.ts";
import { bootstrapBrain } from "../../../src/core/brain/init.ts";
import { planUpgrade } from "../../../src/core/brain/upgrade.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { atomicWriteFileSync } from "../../../src/core/fs-atomic.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import { CHUNKER_VERSION } from "../../../src/core/search/chunker.ts";
import { indexVault } from "../../../src/core/search/indexer.ts";
import { LATEST_SCHEMA_VERSION, readSchemaVersion } from "../../../src/core/search/schema.ts";

let vault: string;
let configHome: string;
let configPath: string;
let prevConfigEnv: string | undefined;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "o2b-ensure-vault-"));
  configHome = mkdtempSync(join(tmpdir(), "o2b-ensure-cfg-"));
  configPath = join(configHome, "config.yaml");
  atomicWriteFileSync(configPath, `vault: ${vault}\n`);
  // ensureVaultCurrent resolves the config via defaultConfigPath().
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

describe("ensureVaultCurrent", () => {
  test("skips an uninitialised vault (no _brain.yaml)", async () => {
    const r = await ensureVaultCurrent(vault, { background: false });
    expect(r.skipped).toBe("not-initialized");
    expect(r.errors).toEqual([]);
  });

  test("migrates a stale _brain.yaml and rebuilds the (missing) index", async () => {
    bootstrapBrain(vault, { configPath });
    // Force a pending brain upgrade: a minimal _brain.yaml missing sections.
    atomicWriteFileSync(brainConfigPath(vault), "schema_version: 1\n");
    expect(planUpgrade(vault).pending).toBeGreaterThan(0);

    const r = await ensureVaultCurrent(vault, { background: false });

    expect(r.errors).toEqual([]);
    expect(r.brainUpgraded.length).toBeGreaterThan(0);
    expect(planUpgrade(vault).pending).toBe(0); // upgrade applied
    expect(r.reindexTriggered).toBe(true);
    expect(existsSync(dbPath())).toBe(true);
    expect(indexSchema()).toBe(LATEST_SCHEMA_VERSION);
  });

  test("is a no-op on a second run (idempotent)", async () => {
    bootstrapBrain(vault, { configPath });
    await ensureVaultCurrent(vault, { background: false }); // builds index, brain current
    const r = await ensureVaultCurrent(vault, { background: false });
    expect(r.brainUpgraded).toEqual([]);
    expect(r.reindexTriggered).toBe(false);
    expect(r.errors).toEqual([]);
  });

  test("rebuilds a stale-schema index", async () => {
    bootstrapBrain(vault, { configPath });
    await ensureVaultCurrent(vault, { background: false }); // build a current index
    const db = new Database(dbPath());
    db.run("UPDATE index_state SET value = '1' WHERE key = 'schema_version'");
    db.close();

    const r = await ensureVaultCurrent(vault, { background: false });
    expect(r.reindexTriggered).toBe(true);
    expect(indexSchema()).toBe(LATEST_SCHEMA_VERSION);
  });

  test("honors an explicit configPath for the search index", async () => {
    bootstrapBrain(vault, { configPath });
    // A second config pointing the index at a custom path.
    const altConfig = join(configHome, "alt.yaml");
    const altDb = join(configHome, "alt-index.sqlite");
    atomicWriteFileSync(altConfig, `vault: ${vault}\nsearch_db_path: ${altDb}\n`);

    const r = await ensureVaultCurrent(vault, { background: false, configPath: altConfig });
    expect(r.reindexTriggered).toBe(true);
    // The index was built at the caller's configured path, not the default one.
    expect(existsSync(altDb)).toBe(true);
    expect(existsSync(dbPath())).toBe(false);
  });

  test("never throws on a malformed _brain.yaml", async () => {
    bootstrapBrain(vault, { configPath });
    atomicWriteFileSync(brainConfigPath(vault), ":\n  not: [valid\n"); // malformed
    const r = await ensureVaultCurrent(vault, { background: false });
    // Brain upgrade is skipped (plan has errors), but the call still succeeds.
    expect(r.skipped).toBe("");
    expect(Array.isArray(r.errors)).toBe(true);
  });
});

describe("ensureVaultCurrent: chunks cut by older chunking rules (#186)", () => {
  const HAN = "向量索引把每一篇笔记切成若干片段并分别计算嵌入以便语义检索".repeat(300);

  function chunkerStamp(): string | null {
    const db = new Database(dbPath(), { readonly: true });
    try {
      const row = db
        .query<{ value: string }, []>("SELECT value FROM index_state WHERE key = 'chunker_version'")
        .get();
      return row?.value ?? null;
    } finally {
      db.close();
    }
  }

  function chunkRows(): Array<{ content: string; token_count: number }> {
    const db = new Database(dbPath(), { readonly: true });
    try {
      return db
        .query<{ content: string; token_count: number }, []>(
          "SELECT c.content, c.token_count FROM chunks c JOIN documents d ON d.id = c.document_id " +
            "WHERE d.path = 'zh.md' ORDER BY c.chunk_index",
        )
        .all();
    } finally {
      db.close();
    }
  }

  /**
   * Turn a current index into one built before the stamp existed, holding
   * the single oversize chunk the old chunker cut for the Han note.
   */
  function makePreFixIndex(): void {
    const db = new Database(dbPath());
    try {
      db.run("DELETE FROM index_state WHERE key = 'chunker_version'");
      const doc = db
        .query<{ id: number }, []>("SELECT id FROM documents WHERE path = 'zh.md'")
        .get()!;
      db.run("DELETE FROM chunks WHERE document_id = ? AND chunk_index > 0", [doc.id]);
      db.run(
        "UPDATE chunks SET content = ?, token_count = 1 WHERE document_id = ? AND chunk_index = 0",
        [HAN, doc.id],
      );
    } finally {
      db.close();
    }
  }

  test("an index from before the chunker stamp is rebuilt exactly once", async () => {
    bootstrapBrain(vault, { configPath });
    atomicWriteFileSync(join(vault, "zh.md"), HAN + "\n");
    await ensureVaultCurrent(vault, { background: false }); // a current index
    expect(chunkerStamp()).toBe(String(CHUNKER_VERSION));

    makePreFixIndex();
    expect(chunkRows().length).toBe(1);

    // An incremental run skips the unchanged note and cannot heal it...
    await indexVault(resolveSearchConfig({ vault, configPath }));
    expect(chunkRows().length).toBe(1);
    expect(chunkerStamp()).toBeNull();

    // ...the self-heal rebuild does, once.
    const first = await ensureVaultCurrent(vault, { background: false });
    expect(first.errors).toEqual([]);
    expect(first.reindexTriggered).toBe(true);
    expect(chunkerStamp()).toBe(String(CHUNKER_VERSION));
    const rows = chunkRows();
    expect(rows.length).toBeGreaterThan(1);
    for (const r of rows) expect(r.token_count).toBeLessThanOrEqual(800);

    const second = await ensureVaultCurrent(vault, { background: false });
    expect(second.reindexTriggered).toBe(false);
  });

  test("an index first built by an incremental run is current, not stale", async () => {
    bootstrapBrain(vault, { configPath });
    atomicWriteFileSync(join(vault, "zh.md"), HAN + "\n");
    await indexVault(resolveSearchConfig({ vault, configPath }));
    expect(chunkerStamp()).toBe(String(CHUNKER_VERSION));
    const r = await ensureVaultCurrent(vault, { background: false });
    expect(r.reindexTriggered).toBe(false);
  });
});
