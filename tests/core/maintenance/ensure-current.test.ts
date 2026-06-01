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

  test("never throws on a malformed _brain.yaml", async () => {
    bootstrapBrain(vault, { configPath });
    atomicWriteFileSync(brainConfigPath(vault), ":\n  not: [valid\n"); // malformed
    const r = await ensureVaultCurrent(vault, { background: false });
    // Brain upgrade is skipped (plan has errors), but the call still succeeds.
    expect(r.skipped).toBe("");
    expect(Array.isArray(r.errors)).toBe(true);
  });
});
