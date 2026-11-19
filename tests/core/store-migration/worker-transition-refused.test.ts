/**
 * The automatic worker never runs the manual transition import. A worker
 * of vault B passes its checks on the legacy layout; a migration of vault
 * A then switches this device before the worker's migration starts. The
 * migrator sees the switch, and for the manual command it would import B
 * as a vault configured after the switch: B's settings at the operator's
 * authority, its legacy items, its binding. That is the operator's to
 * run (the automatic transition import, `auto-transition.ts`, imports
 * records only, on its own trigger). For the automatic call the migrator
 * refuses the transition, and the worker answers that nothing is needed.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";

import { forgetMachineStateCache } from "../../../src/core/state/machine-state.ts";
import {
  AUTO_MIGRATION_OUTCOME,
  runAutoStoreMigration,
} from "../../../src/core/store-migration/auto-worker.ts";
import { isDeviceSwitched } from "../../../src/core/store-migration/migration-records.ts";
import { MigrationSwitchedError, migrateStore } from "../../../src/core/store-migration/outcome.ts";
import { vaultBindingStatus } from "../../../src/core/vault-adapter/vault-binding.ts";
import { makeLegacyVault, UNMAPPED_LEGACY_ENTRIES } from "./fixtures/legacy-vault.ts";
import type { LegacyVaultFixture } from "./fixtures/legacy-vault.ts";
import {
  dropUnparseable,
  makeMigrationBench,
  type MigrationBench,
} from "./fixtures/migration-env.ts";

setDefaultTimeout(60_000);

const AUTO_ENV = "OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION";
const FAST = { settleMs: 0 } as const;

let bench: MigrationBench;
let b: LegacyVaultFixture;
let savedAuto: string | undefined;

beforeEach(() => {
  savedAuto = process.env[AUTO_ENV];
  process.env[AUTO_ENV] = "true";
  bench = makeMigrationBench("osb-transition-a-");
  dropUnparseable(bench.vault);
  b = makeLegacyVault("osb-transition-b-");
  for (const rel of UNMAPPED_LEGACY_ENTRIES)
    rmSync(join(b.vault, ...rel.split("/")), { force: true });
  dropUnparseable(b.vault);
  forgetMachineStateCache();
});

afterEach(() => {
  b.cleanup();
  bench.cleanup();
  if (savedAuto === undefined) delete process.env[AUTO_ENV];
  else process.env[AUTO_ENV] = savedAuto;
});

describe("the automatic worker stays out of the manual transition import", () => {
  test("the migrator refuses the transition for an automatic call", () => {
    expect(migrateStore(bench.vault, FAST).ok).toBe(true);
    const before = bench.records().length;
    expect(() => migrateStore(b.vault, { ...FAST, automatic: true })).toThrow(
      MigrationSwitchedError,
    );
    expect(bench.records().length).toBe(before);
    expect(vaultBindingStatus(b.vault).state).not.toBe("match");
  });

  test("a worker whose device another vault's migration switched imports nothing of its vault", () => {
    let switchedAt = -1;
    const run = runAutoStoreMigration(b.vault, {
      ...FAST,
      hooks: {
        atStep: (step) => {
          if (step !== "store-ready" || switchedAt !== -1) return;
          // Vault A's migration runs to its end between this worker's
          // checks and its own migration.
          expect(migrateStore(bench.vault, FAST).ok).toBe(true);
          expect(isDeviceSwitched(bench.store(), "dev-a")).toBe(true);
          switchedAt = bench.records().length;
        },
      },
    });
    expect(switchedAt).toBeGreaterThan(0);
    expect(run.outcome).toBe(AUTO_MIGRATION_OUTCOME.notNeeded);
    expect(bench.records().length).toBe(switchedAt);
    expect(vaultBindingStatus(b.vault).state).not.toBe("match");
  });
});
