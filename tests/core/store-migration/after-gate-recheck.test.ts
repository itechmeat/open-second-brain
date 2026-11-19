/**
 * What a run decided before it held the migration gate is read again once
 * it holds it. Another run can change it in between: switch the device,
 * finish a rollback, unswitch the device. A run that finds a fact changed
 * under the gate stops before its first write and leaves the gate as it
 * found it; the step hooks put the other run exactly in that window.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { readVaultIdentity } from "../../../src/core/brain/vault-identity.ts";
import { readMigrationGate } from "../../../src/core/migration-gate.ts";
import { forgetMachineStateCache } from "../../../src/core/state/machine-state.ts";
import { migrationDir } from "../../../src/core/store-migration/journal.ts";
import {
  MigrationRefusedError,
  MigrationSwitchedError,
  runMigration,
} from "../../../src/core/store-migration/migrate.ts";
import { isDeviceSwitched } from "../../../src/core/store-migration/migration-records.ts";
import { rollback } from "../../../src/core/store-migration/outcome.ts";
import { removeLegacyTree } from "../../../src/core/store-migration/removal.ts";
import { RollbackRefusedError } from "../../../src/core/store-migration/rollback.ts";
import { makeLegacyVault, UNMAPPED_LEGACY_ENTRIES } from "./fixtures/legacy-vault.ts";
import type { LegacyVaultFixture } from "./fixtures/legacy-vault.ts";
import {
  dropUnparseable,
  makeMigrationBench,
  type MigrationBench,
} from "./fixtures/migration-env.ts";
import { runStateOf } from "./fixtures/run-state.ts";

setDefaultTimeout(60_000);

const FAST = { settleMs: 0 } as const;

let bench: MigrationBench;
let b: LegacyVaultFixture;

beforeEach(() => {
  bench = makeMigrationBench("osb-recheck-a-");
  dropUnparseable(bench.vault);
  b = makeLegacyVault("osb-recheck-b-");
  for (const rel of UNMAPPED_LEGACY_ENTRIES)
    rmSync(join(b.vault, ...rel.split("/")), { force: true });
  dropUnparseable(b.vault);
  forgetMachineStateCache();
});

afterEach(() => {
  b.cleanup();
  bench.cleanup();
});

describe("a device switched by another run between the check and the gate", () => {
  for (const automatic of [true, false]) {
    test(`${automatic ? "an automatic" : "a manual"} run of another vault stops before its first write`, () => {
      const markerBefore = readVaultIdentity(b.vault);
      let switchedAt = -1;
      let doneRun = "";
      const run = (): unknown =>
        runMigration(b.vault, {
          ...FAST,
          automatic,
          hooks: {
            beforeGate: () => {
              // Vault A's migration runs to its end after this run's checks.
              expect(runMigration(bench.vault, FAST).ok).toBe(true);
              expect(isDeviceSwitched(bench.store(), "dev-a")).toBe(true);
              switchedAt = bench.records().length;
              doneRun = runStateOf(migrationDir(bench.store()))!.run_id;
            },
          },
        });
      expect(run).toThrow(automatic ? MigrationSwitchedError : MigrationRefusedError);
      expect(switchedAt).toBeGreaterThan(0);
      // Nothing of vault B: no record, no marker, the run state is A's done.
      expect(bench.records().length).toBe(switchedAt);
      expect(readVaultIdentity(b.vault)).toEqual(markerBefore);
      const state = runStateOf(migrationDir(bench.store()));
      expect(state?.phase).toBe("done");
      expect(state?.run_id).toBe(doneRun);
      expect(readMigrationGate()).toBeNull();
    });
  }
});

describe("a rollback finished by another run between the check and the gate", () => {
  test("the second rollback is refused and restores nothing over later legacy writes", () => {
    expect(runMigration(bench.vault, FAST).ok).toBe(true);
    const later = join(bench.vault, "Brain", "log", "2026-11-19.dev-a.jsonl");
    let before = "";
    expect(() =>
      rollback(bench.vault, {
        hooks: {
          beforeGate: () => {
            rollback(bench.vault);
            // Back on the legacy layout, the machine writes the legacy tree.
            before = existsSync(later) ? readFileSync(later, "utf8") : "";
            appendFileSync(later, "{}\n");
          },
        },
      }),
    ).toThrow(RollbackRefusedError);
    expect(readFileSync(later, "utf8")).toBe(`${before}{}\n`);
    expect(readMigrationGate()).toBeNull();
  });
});

describe("a device unswitched by a rollback between the removal's check and its gate", () => {
  test("the removal moves nothing", () => {
    expect(runMigration(bench.vault, FAST).ok).toBe(true);
    const result = removeLegacyTree(bench.vault, bench.store(), {
      agent: "t",
      // Past the cohort devices still on the legacy layout in the fixture.
      force: true,
      beforeGate: () => {
        rollback(bench.vault);
      },
    });
    expect(result).toMatchObject({ removed: false, reason: "not-switched" });
    expect(existsSync(join(bench.vault, "Brain"))).toBe(true);
    expect(readMigrationGate()).toBeNull();
  });
});
