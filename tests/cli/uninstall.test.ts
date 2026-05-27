import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HERMES_COMMANDS,
  PLUGIN_NAME,
  SAFE_CONFIG_DIR_NAMES,
  planUninstall,
  renderPlan,
} from "../../src/cli/uninstall.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-uninstall-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
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

  test("includes Hermes commands", () => {
    const text = basicPlan(false);
    for (const cmd of HERMES_COMMANDS) expect(text).toContain(cmd);
  });

  test("states vault is preserved", () => {
    const text = basicPlan(false);
    expect(text).toMatch(/Vault \(NEVER removed by this tool\)/);
    expect(text).toContain("Your Markdown notes stay exactly as they are");
  });

  test("states Hermes config is not edited", () => {
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
    expect(r.stdout).toContain("hermes mcp remove open-second-brain");
    expect(r.stdout).toContain("hermes plugins remove open-second-brain");
    expect(r.stdout).toContain("hermes gateway restart");
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

describe("safe names", () => {
  test("only canonical Open Second Brain names", () => {
    expect([...SAFE_CONFIG_DIR_NAMES].toSorted()).toEqual([
      "open-second-brain",
      "open_second_brain",
    ]);
  });
});
