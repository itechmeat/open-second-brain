/**
 * Test helper: a vault a test asks for explicitly (design D14 item 16,
 * task 2.10).
 *
 * The test preload (`tests/setup.ts`) runs the suite with no default
 * vault, as a machine with no vault runs. A test that needs a vault makes
 * one here: a vault directory with
 * the legacy `Brain/` tree, and a machine config naming it, pointed at
 * through `OPEN_SECOND_BRAIN_CONFIG` for the life of the test. The vault,
 * the config and the variable are taken back by `cleanup`.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The device id the preload runs the suite under. */
export const TEST_DEVICE_ID = "test-device";

export interface TestVault {
  readonly vault: string;
  readonly configPath: string;
  cleanup(): void;
}

export interface TestVaultOptions {
  /** Create the legacy `Brain/` tree (default true). */
  readonly brain?: boolean;
}

/** A vault for this test, configured as the machine's vault until `cleanup`. */
export function makeTestVault(
  prefix = "osb-test-vault-",
  options: TestVaultOptions = {},
): TestVault {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const vault = join(root, "vault");
  mkdirSync(options.brain === false ? vault : join(vault, "Brain"), { recursive: true });
  const configPath = join(root, "config.yaml");
  writeFileSync(configPath, `vault: ${vault}\n`);
  const saved = process.env["OPEN_SECOND_BRAIN_CONFIG"];
  // `VAULT_DIR` wins over the config (`resolveVault`): set by an earlier
  // step of the test, it would hide this vault.
  const savedVaultDir = process.env["VAULT_DIR"];
  delete process.env["VAULT_DIR"];
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  return {
    vault,
    configPath,
    cleanup: () => {
      if (saved === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
      else process.env["OPEN_SECOND_BRAIN_CONFIG"] = saved;
      if (savedVaultDir === undefined) delete process.env["VAULT_DIR"];
      else process.env["VAULT_DIR"] = savedVaultDir;
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}
