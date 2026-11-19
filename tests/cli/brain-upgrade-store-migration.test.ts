/**
 * `o2b brain upgrade --dry-run` names a pending store migration and what
 * the next start will do about it (change auto-store-migration, design
 * D4), in the text and in the `store_migration` field of `--json`; with
 * the opt-out it says the migration is offered and never run.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { runCli } from "../helpers/run-cli.ts";
import {
  makeLegacyVault,
  type LegacyVaultFixture,
} from "../core/store-migration/fixtures/legacy-vault.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

// Tests here spawn processes; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

interface StoreMigrationField {
  state: string;
  automatic: boolean;
  next_start: string;
}

let fx: LegacyVaultFixture;
let env: Record<string, string>;

beforeEach(() => {
  fx = makeLegacyVault("osb-cli-upgrade-migrate-");
  const configPath = join(fx.parent, "config.yaml");
  writeFileSync(configPath, `vault: ${fx.vault}\n`);
  env = {
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    HOME: join(fx.parent, "home"),
    XDG_CONFIG_HOME: join(fx.parent, "config"),
    XDG_STATE_HOME: join(fx.parent, "state"),
    XDG_DATA_HOME: join(fx.parent, "data"),
    LOCALAPPDATA: join(fx.parent, "state"),
    [STORE_ROOT_ENV]: join(fx.parent, "store"),
    O2B_DEVICE_ID: "dev-a",
    OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION: "true",
  };
});
afterEach(() => fx.cleanup());

const upgrade = (...args: string[]) =>
  runCli(["brain", "upgrade", "--vault", fx.vault, "--dry-run", ...args], { env });

describe("o2b brain upgrade --dry-run and a pending store migration", () => {
  test("--json names it and what the next start does", async () => {
    const res = await upgrade("--json");
    expect(res.returncode).toBe(0);
    const field = (JSON.parse(res.stdout) as { store_migration: StoreMigrationField })
      .store_migration;
    expect(field.state).toBe("pending");
    expect(field.automatic).toBe(true);
    expect(field.next_start).toContain("runs the migration");
  });

  test("the text plan names it", async () => {
    const res = await upgrade();
    expect(res.returncode).toBe(0);
    expect(res.stdout + res.stderr).toContain(
      "store migration: pending; the next start runs the migration in the background",
    );
  });

  test("with the opt-out it is offered and never run", async () => {
    env["OPEN_SECOND_BRAIN_AUTO_STORE_MIGRATION"] = "false";
    const res = await upgrade("--json");
    const field = (JSON.parse(res.stdout) as { store_migration: StoreMigrationField })
      .store_migration;
    expect(field.state).toBe("pending");
    expect(field.automatic).toBe(false);
    expect(field.next_start).toContain("auto_store_migration: false");
  });
});
