/**
 * A writer refused by a live migration in its first seconds (the settle
 * wait after the gate closes, the checks the run makes again under it)
 * is told how far the run is, as status is: the run records its progress
 * from the moment it holds the gate. The MCP refusal carries the same
 * progress, and no command for a live run: `--resume` continues a stopped
 * run only.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  migrationGateRefusal,
  type MigrationInProgressError,
} from "../../../src/core/migration-gate.ts";
import { MIGRATION_STEP, runMigration } from "../../../src/core/store-migration/migrate.ts";
import {
  migrationInProgressRefusal,
  type MigrationInProgressData,
} from "../../../src/mcp/frozen-refusal.ts";
import { makeFleet, type Fleet } from "./fixtures/fleet.ts";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

describe("a write refused right after the gate closed", () => {
  test("names the run's step, and the MCP refusal carries it with no command to run", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    let refused: MigrationInProgressError | null = null;

    const result = runMigration(a.vault, {
      settleMs: 0,
      hooks: {
        atStep: (step) => {
          if (step === MIGRATION_STEP.gateTaken) refused = migrationGateRefusal(a.vault);
        },
      },
    });

    expect(result.ok).toBe(true);
    expect(refused).not.toBeNull();
    const err = refused as unknown as MigrationInProgressError;
    expect(err.progress).toContain("the gate is closed");
    const data = migrationInProgressRefusal("brain_note", err).data as MigrationInProgressData;
    expect(data.progress).toBe(err.progress);
    expect(data.next_command).toBeNull();
    expect(data.retry).toBe("later");
  });
});
