/**
 * The doctor and the store status block on the automatic store migration
 * (change auto-store-migration, design D6): the migration finding words
 * its message from `autoMigrationReport` (the next start runs it, it is
 * running, it waits, or the machine opted out), a recorded failure is a
 * warning naming the reason and the manual command, and the status
 * block's `migration` carries the report.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import {
  MIGRATION_AVAILABLE_CODE,
  STORE_MIGRATION_FAILED_CODE,
} from "../../../src/core/brain/doctor/migration-check.ts";
import { resetVaultIdentityPins } from "../../../src/core/brain/vault-identity.ts";
import { DEVICE_ID_ENV } from "../../../src/core/config.ts";
import { STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import { buildStoreStatusBlock } from "../../../src/core/store/store-status.ts";
import {
  claimAutoMigrationLock,
  recordAutoMigrationFailure,
  releaseAutoMigrationLock,
} from "../../../src/core/store-migration/auto-state.ts";

const AUTO_ENV = "OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION";
const ENV_KEYS = [
  STORE_ROOT_ENV,
  DEVICE_ID_ENV,
  AUTO_ENV,
  "HOME",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "LOCALAPPDATA",
] as const;
/** The doctor's clock; the worker claim below reads the wall clock once. */
const NOW = new Date(Date.UTC(2026, 10, 18, 12, 0, 0));

let parent: string;
let vault: string;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  parent = mkdtempSync(join(tmpdir(), "osb-doctor-auto-migration-"));
  vault = join(parent, "vault");
  for (const d of ["preferences", "inbox", "log"]) {
    mkdirSync(join(vault, "Brain", d), { recursive: true });
  }
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  writeFileSync(join(vault, "Brain", "inbox", "2026-11-06-a.md"), "---\nid: sig-a\n---\n");
  process.env["HOME"] = join(parent, "home");
  process.env["XDG_STATE_HOME"] = join(parent, "state");
  process.env["XDG_DATA_HOME"] = join(parent, "data");
  process.env["LOCALAPPDATA"] = join(parent, "state");
  process.env[STORE_ROOT_ENV] = join(parent, "store");
  process.env[DEVICE_ID_ENV] = "dev-a";
  process.env[AUTO_ENV] = "true";
  resetVaultIdentityPins();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetVaultIdentityPins();
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function codes(now: Date = NOW) {
  const result = runDoctor(vault, { now });
  return { result, all: [...result.warnings, ...(result.uncertain ?? [])] };
}

describe("the doctor's migration finding", () => {
  test("pending with the automatic migration on: the next start runs it", () => {
    const found = codes().all.filter((i) => i.code === MIGRATION_AVAILABLE_CODE);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("the next start runs the migration in the background");
    expect(found[0]!.message).toContain("auto_store_migration: false");
  });

  test("pending with the opt-out: nothing moves until it is run by hand", () => {
    process.env[AUTO_ENV] = "false";
    const found = codes().all.find((i) => i.code === MIGRATION_AVAILABLE_CODE);
    expect(found?.message).toContain("nothing moves until you run the migration itself");
  });

  test("an unrecognised value is off and the doctor names it", () => {
    process.env[AUTO_ENV] = "maybe";
    const found = codes().all.find((i) => i.code === MIGRATION_AVAILABLE_CODE);
    expect(found?.message).toContain("nothing moves until you run the migration itself");
    expect(found?.message).toContain(
      'unrecognised value OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION="maybe"',
    );
  });

  test("a running worker is named, with its process", () => {
    const claimedAt = new Date();
    const token = claimAutoMigrationLock(vault, claimedAt);
    try {
      const found = codes(claimedAt).all.find((i) => i.code === MIGRATION_AVAILABLE_CODE);
      expect(found?.message).toContain(`process ${process.pid}`);
    } finally {
      releaseAutoMigrationLock(vault, token!);
    }
  });

  test("a recorded failure is a warning with the reason and the manual command", () => {
    recordAutoMigrationFailure(vault, "the disk is full", {
      manualCommand: "o2b brain migrate-store",
      now: NOW,
    });
    const { result } = codes();
    const warning = result.warnings.find((w) => w.code === STORE_MIGRATION_FAILED_CODE);
    expect(warning?.message).toContain("the disk is full");
    expect(warning?.message).toContain("o2b brain migrate-store");
  });
});

describe("the store status block", () => {
  test("carries the automatic migration's report", () => {
    const block = buildStoreStatusBlock({ vault, configPath: null });
    const migration = block["migration"] as { automatic: { state: string; next_start: string } };
    expect(migration.automatic.state).toBe("pending");
    expect(migration.automatic.next_start).toContain("runs the migration");
  });

  test("names an unrecognised opt-out value", () => {
    process.env[AUTO_ENV] = "nope";
    const block = buildStoreStatusBlock({ vault, configPath: null });
    const migration = block["migration"] as {
      automatic: { state: string; automatic: boolean; setting_problem?: string };
    };
    expect(migration.automatic.automatic).toBe(false);
    expect(migration.automatic.setting_problem).toContain('"nope"');
  });
});
