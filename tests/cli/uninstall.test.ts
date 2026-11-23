import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HERMES_COMMANDS,
  PLUGIN_NAME,
  SAFE_CONFIG_DIR_NAMES,
  planUninstall,
  renderPlan,
} from "../../src/cli/uninstall.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { runCli } from "../helpers/run-cli.ts";
import { manifestPath } from "../../src/core/install/manifest.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};
const sandboxKeys = [
  "HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_STATE_HOME",
  "OPEN_SECOND_BRAIN_CONFIG",
  "OPEN_SECOND_BRAIN_STORE_ROOT",
  "HERMES_HOME",
];

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-uninstall-test-"));
  for (const key of sandboxKeys) {
    savedEnv[key] = process.env[key];
    process.env[key] = join(tmp, key.toLowerCase().replaceAll("_", "-"));
  }
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = join(tmp, "machine-config.yaml");
  process.env["OPEN_SECOND_BRAIN_STORE_ROOT"] = join(tmp, "store");
  process.env["HERMES_HOME"] = join(tmp, "hermes");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const key of sandboxKeys) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
});

describe("HERMES_COMMANDS", () => {
  test("matches the documented form", () => {
    expect(HERMES_COMMANDS).toEqual([
      `hermes mcp remove ${PLUGIN_NAME}`,
      `hermes plugins remove ${PLUGIN_NAME}`,
      "hermes gateway restart",
    ]);
  });

  test("does not use quoted args blob", () => {
    for (const cmd of HERMES_COMMANDS) {
      expect(cmd.includes("'")).toBe(false);
      expect(cmd.includes('"')).toBe(false);
      expect(cmd.includes("--args ")).toBe(false);
    }
  });
});

describe("planUninstall", () => {
  test("dry-run does not remove the config directory", () => {
    const configDir = join(tmp, "open-second-brain");
    mkdirSync(configDir);
    const config = join(configDir, "config.yaml");
    writeFileSync(config, "vault_path: /vault/example\n");
    const other = join(configDir, "snapshot.json");
    writeFileSync(other, "{}");

    const plan = planUninstall({ configPath: config, applyLocal: false });
    expect(plan.applyLocal).toBe(false);
    expect(existsSync(config)).toBe(true);
    expect(existsSync(other)).toBe(true);
    expect(existsSync(configDir)).toBe(true);
    expect(plan.removedPaths).toEqual([]);
    expect(plan.skippedPaths).toEqual([]);
    expect(plan.configDir).toBe(configDir);
    expect(plan.configDirExists).toBe(true);
    expect(plan.vaultPath).toBe("/vault/example");
  });

  test("dry-run records missing config", () => {
    const config = join(tmp, "open-second-brain", "missing.yaml");
    const plan = planUninstall({ configPath: config, applyLocal: false });
    expect(plan.configExists).toBe(false);
    expect(plan.configDirExists).toBe(false);
    expect(plan.removedPaths).toEqual([]);
  });

  test("apply-local removes the named config directory", () => {
    const configDir = join(tmp, "open-second-brain");
    mkdirSync(configDir);
    writeFileSync(join(configDir, "config.yaml"), "instance: x\n");
    mkdirSync(join(configDir, "snapshots"));
    writeFileSync(join(configDir, "snapshots", "old.json"), "{}");

    const plan = planUninstall({ configPath: join(configDir, "config.yaml"), applyLocal: true });
    expect(plan.applyLocal).toBe(true);
    expect(existsSync(configDir)).toBe(false);
    expect(plan.removedPaths).toEqual([configDir]);
    expect(plan.skippedPaths).toEqual([]);
    expect(plan.errors).toEqual([]);
  });

  test("apply-local refuses unknown directory name", () => {
    const configDir = join(tmp, "etc");
    mkdirSync(configDir);
    const payload = join(configDir, "important.yaml");
    writeFileSync(payload, "vault_path: /vault\n");
    const plan = planUninstall({ configPath: payload, applyLocal: true });
    expect(existsSync(configDir)).toBe(true);
    expect(existsSync(payload)).toBe(true);
    expect(plan.removedPaths).toEqual([]);
    expect(plan.skippedPaths.length).toBe(1);
    const [skippedPath, reason] = plan.skippedPaths[0]!;
    expect(skippedPath).toBe(configDir);
    expect(reason).toContain("not a recognized");
  });

  test("apply-local refuses paths inside .hermes", () => {
    const hermesRoot = join(tmp, ".hermes");
    const configDir = join(hermesRoot, "open-second-brain");
    mkdirSync(configDir, { recursive: true });
    const payload = join(configDir, "config.yaml");
    writeFileSync(payload, "vault_path: /vault\n");
    const plan = planUninstall({ configPath: payload, applyLocal: true });
    expect(existsSync(configDir)).toBe(true);
    expect(plan.skippedPaths.length).toBe(1);
    const [_, reason] = plan.skippedPaths[0]!;
    expect(reason).toContain("Hermes");
  });

  test("apply-local refuses git repository", () => {
    const configDir = join(tmp, "open-second-brain");
    mkdirSync(configDir);
    mkdirSync(join(configDir, ".git"));
    const payload = join(configDir, "config.yaml");
    writeFileSync(payload, "instance: x\n");
    const plan = planUninstall({ configPath: payload, applyLocal: true });
    expect(existsSync(configDir)).toBe(true);
    expect(plan.removedPaths).toEqual([]);
    expect(plan.skippedPaths.length).toBe(1);
    expect(plan.skippedPaths[0]![1]).toContain("git");
  });

  test("apply-local skips when config dir missing", () => {
    const payload = join(tmp, "open-second-brain", "config.yaml");
    const plan = planUninstall({ configPath: payload, applyLocal: true });
    expect(plan.removedPaths).toEqual([]);
    expect(plan.skippedPaths.length).toBe(1);
    expect(plan.skippedPaths[0]![1]).toContain("does not exist");
  });
});

describe("safety invariants", () => {
  test("apply-local never touches vault", () => {
    const vault = join(tmp, "vault");
    mkdirSync(join(vault, "Notes"), { recursive: true });
    mkdirSync(join(vault, "Journal"), { recursive: true });
    writeFileSync(join(vault, "Notes", "page.md"), "# Page\n");
    writeFileSync(join(vault, "Journal", "2026-05-06.md"), "# Journal\n");

    const configDir = join(tmp, "open-second-brain");
    mkdirSync(configDir);
    const config = join(configDir, "config.yaml");
    writeFileSync(config, `vault_path: ${vault}\n`);

    planUninstall({ configPath: config, applyLocal: true });

    expect(existsSync(vault)).toBe(true);
    expect(existsSync(join(vault, "Notes", "page.md"))).toBe(true);
    expect(existsSync(join(vault, "Journal", "2026-05-06.md"))).toBe(true);
  });

  test("apply-local never touches the Hermes config file", async () => {
    const hermesDir = join(tmp, ".hermes");
    mkdirSync(hermesDir);
    const hermesConfig = join(hermesDir, "config.yaml");
    const hermesPayload =
      "mcp_servers:\n" +
      "  open-second-brain:\n" +
      "    command: o2b\n" +
      '    args: ["mcp", "--vault", "/vault"]\n';
    writeFileSync(hermesConfig, hermesPayload);

    const configDir = join(tmp, "open-second-brain");
    mkdirSync(configDir);
    const config = join(configDir, "config.yaml");
    writeFileSync(config, "vault_path: /vault\n");

    planUninstall({ configPath: config, applyLocal: true });
    expect(existsSync(hermesConfig)).toBe(true);
    await expect(Bun.file(hermesConfig).text()).resolves.toBe(hermesPayload);
  });
});

describe("renderPlan", () => {
  function basicPlan(applyLocal: boolean): string {
    const configDir = join(tmp, "open-second-brain");
    mkdirSync(configDir);
    const config = join(configDir, "config.yaml");
    writeFileSync(config, "vault_path: /vault/here\n");
    return renderPlan(planUninstall({ configPath: config, applyLocal }));
  }

  test("does not include Hermes steps when no Hermes integration is installed", () => {
    const text = basicPlan(false);
    expect(text).not.toContain("Hermes integration");
    for (const cmd of HERMES_COMMANDS) expect(text).not.toContain(cmd);
  });

  test("includes Hermes steps for a Hermes manifest entry", () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    mkdirSync(join(vault, ".open-second-brain"), { recursive: true });
    const configDir = join(tmp, "open-second-brain");
    mkdirSync(configDir);
    const configPath = join(configDir, "config.yaml");
    writeFileSync(configPath, `vault_path: ${vault}\n`);
    writeFileSync(
      manifestPath(vault),
      JSON.stringify({
        schema_version: 1,
        installs: {
          hermes: { target: "hermes", applied_at: "today", operation: "mcp", config_path: null },
        },
      }),
    );
    const text = renderPlan(planUninstall({ configPath }));
    for (const cmd of HERMES_COMMANDS) expect(text).toContain(cmd);
  });

  test("includes Hermes steps when its plugin directory exists", () => {
    const plugin = join(process.env["HERMES_HOME"]!, "plugins", "open-second-brain");
    mkdirSync(plugin, { recursive: true });
    const text = basicPlan(false);
    for (const cmd of HERMES_COMMANDS) expect(text).toContain(cmd);
  });

  test("names legacy discipline jobs without changing the jobs file", () => {
    const jobsFile = join(tmp, ".hermes", "cron", "jobs.json");
    mkdirSync(join(tmp, ".hermes", "cron"), { recursive: true });
    const contents =
      JSON.stringify(
        {
          jobs: [
            { id: "osb-discipline-report-a1", name: "old daily job" },
            { id: "osb-weekly-brain-digest-a1", name: "old weekly job" },
            { id: "unrelated", name: "other job" },
          ],
        },
        null,
        2,
      ) + "\n";
    writeFileSync(jobsFile, contents);
    const configDir = join(tmp, "open-second-brain");
    mkdirSync(configDir, { recursive: true });
    const config = join(configDir, "config.yaml");
    writeFileSync(config, "vault_path: /vault/here\n");
    const previous = process.env["OSB_HERMES_JOBS"];
    process.env["OSB_HERMES_JOBS"] = jobsFile;
    try {
      const text = renderPlan(planUninstall({ configPath: config, applyLocal: false }));
      expect(text).toContain(jobsFile);
      expect(text).toContain("osb-discipline-report-a1");
      expect(text).toContain("osb-weekly-brain-digest-a1");
      expect(text).toContain("hermes cron remove");
      expect(readFileSync(jobsFile, "utf8")).toBe(contents);
    } finally {
      if (previous === undefined) delete process.env["OSB_HERMES_JOBS"];
      else process.env["OSB_HERMES_JOBS"] = previous;
    }
  });

  test("states vault is preserved", () => {
    const text = basicPlan(false);
    expect(text).toMatch(/Vault \(NEVER removed by this tool\)/);
    expect(text).toContain("Your Markdown notes stay exactly as they are");
  });

  test("states Hermes config is not edited", () => {
    mkdirSync(join(process.env["HERMES_HOME"]!, "plugins", "open-second-brain"), {
      recursive: true,
    });
    const text = basicPlan(false);
    expect(text).toContain("~/.hermes/config.yaml");
    expect(text).toContain("never edits");
  });

  test("dry-run mark", () => {
    expect(basicPlan(false)).toContain("dry-run");
  });

  test("apply-local mark", () => {
    expect(basicPlan(true)).toContain("apply-local");
  });
});

describe("CLI uninstall", () => {
  test("dry-run does not modify filesystem", async () => {
    const configDir = join(tmp, "open-second-brain");
    mkdirSync(configDir);
    const config = join(configDir, "config.yaml");
    writeFileSync(config, "vault_path: /vault\n");

    const r = await runCli(["uninstall", "--config", config]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("Uninstall plan");
    expect(r.stdout).toContain("dry-run");
    expect(r.stdout).not.toContain("hermes mcp remove open-second-brain");
    expect(r.stdout).not.toContain("hermes plugins remove open-second-brain");
    expect(r.stdout).not.toContain("hermes gateway restart");
    expect(r.stdout).toContain("NEVER removed by this tool");
    expect(existsSync(config)).toBe(true);
    expect(existsSync(configDir)).toBe(true);
  });

  test("apply-local removes only local config dir", async () => {
    const vault = join(tmp, "vault");
    mkdirSync(join(vault, "Daily"), { recursive: true });
    writeFileSync(join(vault, "Daily", "2026.05.06.md"), "vault content");

    const configDir = join(tmp, "open-second-brain");
    mkdirSync(configDir);
    const config = join(configDir, "config.yaml");
    writeFileSync(config, `vault_path: ${vault}\n`);

    const r = await runCli(["uninstall", "--config", config, "--apply-local"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("apply-local");
    expect(existsSync(configDir)).toBe(false);
    expect(existsSync(vault)).toBe(true);
    expect(existsSync(join(vault, "Daily", "2026.05.06.md"))).toBe(true);
  });

  test("apply-local refuses unknown config dir name", async () => {
    const configDir = join(tmp, "etc");
    mkdirSync(configDir);
    writeFileSync(join(configDir, "very-important.yaml"), "keep-me\n");
    const config = join(configDir, "config.yaml");
    writeFileSync(config, "vault_path: /vault\n");
    const r = await runCli(["uninstall", "--config", config, "--apply-local"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("skipped");
    expect(existsSync(configDir)).toBe(true);
    expect(existsSync(join(configDir, "very-important.yaml"))).toBe(true);
  });

  test("uses OPEN_SECOND_BRAIN_CONFIG env", async () => {
    const configDir = join(tmp, "open-second-brain");
    mkdirSync(configDir);
    const config = join(configDir, "config.yaml");
    writeFileSync(config, "vault_path: /env/vault\n");
    const r = await runCli(["uninstall"], { env: { OPEN_SECOND_BRAIN_CONFIG: config } });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain(config);
    expect(r.stdout).toContain("/env/vault");
  });

  test("--help documents safety invariants", async () => {
    const r = await runCli(["uninstall", "--help"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("never touches");
    expect(r.stdout.toLowerCase()).toContain("vault");
  });
});

describe("uninstall --target vault resolution", () => {
  test("the vault resolves through the canonical chain: VAULT_DIR beats the config key", async () => {
    // The install verb resolves through resolveInstallVault, whose chain
    // puts VAULT_DIR first - install.ts documents the old order (config
    // key, then VAULT_DIR) as the split-brain bug it fixed. The uninstall
    // verb still carried that old order, so an install that resolved
    // VAULT_DIR was uninstalled from the CONFIGURED vault: the manifest
    // was not found there and the real install state stayed behind. The
    // uninstall now resolves through the same chain, and this pins it
    // end to end - install lands in the VAULT_DIR vault, then an
    // uninstall with no --vault finds and plans the removal there.
    const configured = join(tmp, "vault-configured");
    const envVault = join(tmp, "vault-env");
    const home = join(tmp, "home");
    // Legacy vaults: the install manifest lives in the vault. A vault with
    // no `Brain/` is store-only and keeps it device-local instead.
    mkdirSync(join(configured, "Brain"), { recursive: true });
    mkdirSync(join(envVault, "Brain"), { recursive: true });
    mkdirSync(home, { recursive: true });
    const config = join(tmp, "config.yaml");
    writeFileSync(config, `vault: "${configured}"\n`);
    const env = {
      HOME: home,
      OPEN_SECOND_BRAIN_CONFIG: config,
      VAULT_AGENT_NAME: "uninstall-test",
      VAULT_TIMEZONE: "UTC",
    };
    const seeded = await runCli(
      ["install", "--target", "cursor", "--vault", envVault, "--apply", "--yes", "--json"],
      { env, subprocess: true },
    );
    expect(seeded.returncode).toBe(0);
    expect(existsSync(join(envVault, ".open-second-brain", "install.lock.json"))).toBe(true);

    const r = await runCli(["uninstall", "--target", "cursor", "--json"], {
      env: { ...env, VAULT_DIR: envVault },
      subprocess: true,
    });
    expect(r.returncode).toBe(0);
    // The verb's --json output is the CLI's ok-envelope with the payload
    // nested in its `stdout` string.
    const envelope = JSON.parse(r.stdout) as { ok: boolean; code: number; stdout: string };
    expect(envelope.ok).toBe(true);
    const payload = JSON.parse(envelope.stdout) as { target: string };
    expect(payload.target).toBe("cursor");
  });
});

describe("safe names", () => {
  test("only canonical Open Second Brain names", () => {
    expect([...SAFE_CONFIG_DIR_NAMES].toSorted()).toEqual([
      "open-second-brain",
      "open_second_brain",
    ]);
  });
});
