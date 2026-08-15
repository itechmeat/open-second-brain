/**
 * `o2b install` resolves the vault the way the rest of the CLI does.
 *
 * The verb used to carry its own chain - `--vault` then the config `vault`
 * key then `VAULT_DIR` - which disagreed with {@link resolveVault} on two
 * points that change the answer rather than the spelling: `VAULT_DIR` came
 * LAST instead of first, and neither the project pointer nor the active
 * profile was consulted at all. A machine with both a config `vault` and a
 * `VAULT_DIR` got two different vaults from `o2b install` and from every
 * other verb, so the path the installer wrote into an agent's MCP entry
 * could name a directory nothing else was using.
 *
 * The precedence is pinned here rather than described, and it is pinned by
 * COMPARISON: every row asserts the install resolver returns exactly what
 * `resolveVault` returns for the same state, so a future edit to either
 * chain fails this file instead of silently re-opening the divergence.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveInstallVault } from "../../src/cli/install/install.ts";
import { resolveVault } from "../../src/core/config.ts";
import { runCli } from "../helpers/run-cli.ts";

let configVault: string;
let envVault: string;
let explicitVault: string;
let home: string;
let configPath: string;
let savedVaultDir: string | undefined;

/**
 * What the canonical resolver answers, in the shape the install verb
 * consumes it.
 *
 * `resolveVault` returns `string | null` and every caller decides what an
 * unresolved vault means; `resolveInstallVault` answers `""` because
 * `InstallEnv.vault` is typed `string` and both of its readers - `runCheck`
 * and `loadPayload` - refuse an empty vault BY NAME rather than joining a
 * path onto it. Collapsing the null here is what makes the comparison
 * total, so a divergence between the two chains fails on the PATH rather
 * than on the type.
 */
function canonical(): string {
  return resolveVault(configPath) ?? "";
}

beforeEach(() => {
  configVault = mkdtempSync(join(tmpdir(), "osb-ivr-cfg-"));
  envVault = mkdtempSync(join(tmpdir(), "osb-ivr-env-"));
  explicitVault = mkdtempSync(join(tmpdir(), "osb-ivr-arg-"));
  home = mkdtempSync(join(tmpdir(), "osb-ivr-home-"));
  configPath = join(home, "config.yaml");
  writeFileSync(configPath, `vault: "${configVault}"\nagent_name: "unit"\ntimezone: "UTC"\n`);
  savedVaultDir = process.env["VAULT_DIR"];
});

afterEach(() => {
  if (savedVaultDir === undefined) delete process.env["VAULT_DIR"];
  else process.env["VAULT_DIR"] = savedVaultDir;
  for (const p of [configVault, envVault, explicitVault, home]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

describe("o2b install shares the canonical vault chain", () => {
  test("VAULT_DIR wins over the config key, exactly as resolveVault does", () => {
    process.env["VAULT_DIR"] = envVault;
    expect(resolveInstallVault(null, configPath)).toBe(envVault);
    expect(resolveInstallVault(null, configPath)).toBe(canonical());
  });

  test("the config key answers when VAULT_DIR is unset", () => {
    delete process.env["VAULT_DIR"];
    expect(resolveInstallVault(null, configPath)).toBe(configVault);
    expect(resolveInstallVault(null, configPath)).toBe(canonical());
  });

  test("--vault outranks both - it is the operator naming the target directly", () => {
    process.env["VAULT_DIR"] = envVault;
    expect(resolveInstallVault(explicitVault, configPath)).toBe(explicitVault);
  });

  test("an unresolvable vault is the empty string, which every caller refuses by name", () => {
    delete process.env["VAULT_DIR"];
    const bare = join(home, "no-vault-key.yaml");
    writeFileSync(bare, `agent_name: "unit"\n`);
    expect(resolveInstallVault(null, bare)).toBe("");
  });

  test("a tilde in VAULT_DIR is expanded, so the payload never carries a literal ~", () => {
    process.env["VAULT_DIR"] = "~/some-vault";
    const resolved = resolveInstallVault(null, configPath);
    expect(resolved.startsWith("~")).toBe(false);
    expect(resolved).toBe(canonical());
  });
});

describe("the payload the installer writes names the resolved vault", () => {
  test("VAULT_DIR set alongside a different config vault writes VAULT_DIR's path", async () => {
    const r = await runCli(
      ["install", "--target", "generic", "--apply", "--out", "-", "--config", configPath],
      { env: { VAULT_DIR: envVault, OPEN_SECOND_BRAIN_CONFIG: configPath } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain(envVault);
    expect(r.stdout).not.toContain(configVault);
  });
});
