import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { createPluginRepo, createSandboxVault } from "../helpers/fixtures.ts";
import { runCli } from "../helpers/run-cli.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-cli-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("help", () => {
  test("top-level help includes the Brain note verb", async () => {
    const r = await runCli(["--help"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("brain note");
  });
});

describe("status", () => {
  test("reports missing config", async () => {
    const config = join(tmp, "missing.yaml");
    const r = await runCli(["status"], { env: { OPEN_SECOND_BRAIN_CONFIG: config } });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("config_exists: false");
    expect(r.stdout).toContain(config);
  });
});

describe("init", () => {
  test("creates vault structure", async () => {
    const r = await runCli(["init", "--vault", tmp, "--name", "Test"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("initialized vault:");
    expect(existsSync(join(tmp, "AI Wiki", "_OPEN_SECOND_BRAIN.md"))).toBe(true);
    expect(existsSync(join(tmp, "AI Wiki", "identity", "agents.md"))).toBe(true);
  });

  test("with agent-name writes identity entry", async () => {
    const vault = join(tmp, "vault");
    const config = join(tmp, "config.yaml");
    const r = await runCli(
      ["init", "--vault", vault, "--name", "Test", "--agent-name", "openclaw-main"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("agent name registered: openclaw-main");
    const txt = readFileSync(join(vault, "AI Wiki", "identity", "agents.md"), "utf8");
    expect(txt).toContain("- openclaw-main: primary agent on this server");
    expect(txt).not.toContain("(add your agents here");
  });

  test("with agent-name persists to plugin config", async () => {
    const vault = join(tmp, "vault");
    const config = join(tmp, "config.yaml");
    const r = await runCli(
      ["init", "--vault", vault, "--name", "Test", "--agent-name", "hermes-vps-agent"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("agent name persisted to:");
    const text = readFileSync(config, "utf8");
    expect(text).toContain("agent_name");
    expect(text).toContain("hermes-vps-agent");
  });

  test("persists vault path resolved (absolute) into config", async () => {
    const vault = join(tmp, "vault");
    const config = join(tmp, "config.yaml");
    const r = await runCli(["init", "--vault", vault, "--name", "Test"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("vault path persisted to:");
    const text = readFileSync(config, "utf8");
    expect(text).toContain("vault");
    expect(text).toContain(resolve(vault));
  });

  test("with timezone persists to plugin config", async () => {
    const vault = join(tmp, "vault");
    const config = join(tmp, "config.yaml");
    const r = await runCli(
      ["init", "--vault", vault, "--name", "Test", "--agent-name", "hermes-vps-agent", "--timezone", "Europe/Belgrade"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("timezone registered: Europe/Belgrade");
    const text = readFileSync(config, "utf8");
    expect(text).toContain("Europe/Belgrade");
  });

  test("rejects invalid timezone", async () => {
    const vault = join(tmp, "vault");
    const config = join(tmp, "config.yaml");
    const r = await runCli(
      ["init", "--vault", vault, "--name", "Test", "--timezone", "NotARealTimezone"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).not.toBe(0);
    expect(r.stderr).toContain("not a valid IANA name");
    expect(existsSync(vault) && readdirSync(vault).length > 0).toBe(false);
  });

  test("re-init persists agent name", async () => {
    const vault = join(tmp, "vault");
    const config = join(tmp, "config.yaml");
    await runCli(["init", "--vault", vault, "--name", "Test"]);
    const r = await runCli(
      ["init", "--vault", vault, "--name", "Test", "--agent-name", "hermes-vps-agent"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: config } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("agent name persisted to:");
    expect(readFileSync(config, "utf8")).toContain("hermes-vps-agent");
  });

  test("already initialized does not overwrite", async () => {
    await runCli(["init", "--vault", tmp, "--name", "First"]);
    const index = join(tmp, "AI Wiki", "index.md");
    writeFileSync(index, "custom");
    const r = await runCli(["init", "--vault", tmp, "--name", "Second"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("already initialized");
    expect(readFileSync(index, "utf8")).toBe("custom");
  });

  test("--force overwrites", async () => {
    await runCli(["init", "--vault", tmp, "--name", "First"]);
    const index = join(tmp, "AI Wiki", "index.md");
    writeFileSync(index, "old");
    const r = await runCli(["init", "--vault", tmp, "--name", "Second", "--force"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("initialized vault:");
    expect(readFileSync(index, "utf8")).not.toBe("old");
  });
});

describe("append-event", () => {
  test("errors when no vault anywhere", async () => {
    const cfg = join(tmp, "config.yaml");
    const r = await runCli(["append-event", "msg", "--as", "tester"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: cfg },
    });
    expect(r.returncode).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("no vault configured");
  });

  test("prints absolute path on success", async () => {
    const vault = join(tmp, "vault");
    mkdirSync(vault);
    const cfg = join(tmp, "config.yaml");
    const r = await runCli(
      ["append-event", "absolute-path-test", "--vault", vault, "--as", "tester"],
      { env: { OPEN_SECOND_BRAIN_CONFIG: cfg } },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("appended: ");
    const printed = r.stdout.split("appended: ")[1]!.trim().split("\n")[0]!;
    expect(printed.startsWith("/")).toBe(true);
    expect(printed.startsWith(resolve(vault))).toBe(true);
  });

  test("writes daily note", async () => {
    const r = await runCli([
      "append-event",
      "created CLI",
      "--vault",
      tmp,
      "--as",
      "test-agent",
      "--date",
      "2026.05.06",
      "--time",
      "10:15",
    ]);
    expect(r.returncode).toBe(0);
    const daily = join(tmp, "Daily", "2026.05.06.md");
    expect(readFileSync(daily, "utf8")).toContain("- 10:15 — @test-agent — created CLI");
  });
});

describe("doctor", () => {
  test("errors when no vault anywhere", async () => {
    const cfg = join(tmp, "config.yaml");
    const r = await runCli(["doctor"], { env: { OPEN_SECOND_BRAIN_CONFIG: cfg } });
    expect(r.returncode).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("no vault configured");
  });

  test("checks valid vault", async () => {
    const r = await runCli(["doctor", "--vault", tmp], {
      env: { OPEN_SECOND_BRAIN_CONFIG: "", XDG_CONFIG_HOME: "", VAULT_DIR: "" },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("[OK]");
    expect(r.stdout.toLowerCase()).toContain("vault");
  });

  test("reports missing vault", async () => {
    const r = await runCli(["doctor", "--vault", "/nonexistent/path"]);
    expect(r.returncode).toBe(1);
    expect(r.stdout).toContain("[FAIL]");
  });

  test("with --repo checks manifests", async () => {
    const vault = createSandboxVault(tmp);
    const repo = createPluginRepo(tmp, true);
    const r = await runCli(["doctor", "--vault", vault, "--repo", repo]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("claude_manifest");
    expect(r.stdout).toContain("codex_manifest");
    expect(r.stdout).toContain("hermes_manifest");
  });

  test("with --repo rejects invalid manifest schema", async () => {
    const vault = createSandboxVault(tmp);
    const repo = createPluginRepo(tmp, false);
    const r = await runCli(["doctor", "--vault", vault, "--repo", repo]);
    expect(r.returncode).toBe(1);
    expect(r.stdout).toContain("[FAIL] claude_manifest");
    expect(r.stdout).toContain("[FAIL] codex_manifest");
  });
});

describe("index", () => {
  test("errors when no vault anywhere", async () => {
    const cfg = join(tmp, "config.yaml");
    const r = await runCli(["index"], { env: { OPEN_SECOND_BRAIN_CONFIG: cfg } });
    expect(r.returncode).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("no vault configured");
  });

  test("generates wikilink index", async () => {
    const vault = tmp;
    mkdirSync(join(vault, "AI Wiki"), { recursive: true });
    writeFileSync(join(vault, "Concept.md"), "---\ntitle: Concept\n---\n\nBody.");
    writeFileSync(join(vault, "Other.md"), "No frontmatter.");
    const r = await runCli(["index", "--vault", vault]);
    expect(r.returncode).toBe(0);
    const indexPath = join(vault, "AI Wiki", "index.md");
    expect(existsSync(indexPath)).toBe(true);
    const content = readFileSync(indexPath, "utf8");
    expect(content).toContain("[[Concept]]");
    expect(content).toContain("[[Other]]");
  });
});

describe("export-config", () => {
  test("writes redacted JSON snapshot", async () => {
    const config = join(tmp, "config.yaml");
    writeFileSync(config, "api_key: abc\nvault_path: /tmp/vault\n");
    const out = join(tmp, "snapshot.json");
    const r = await runCli(["export-config", "--config", config, "--output", out]);
    expect(r.returncode).toBe(0);
    const data = JSON.parse(readFileSync(out, "utf8"));
    expect(data.config.api_key).toBe("[REDACTED]");
    expect(data.config.vault_path).toBe("/tmp/vault");
  });
});

describe("vault-log compat command (append-event under another name)", () => {
  test("produces same daily note as append-event", async () => {
    const r = await runCli([
      "append-event",
      "compat entry",
      "--as",
      "compat-agent",
      "--vault",
      tmp,
      "--date",
      "2026.05.06",
      "--time",
      "10:30",
    ]);
    expect(r.returncode).toBe(0);
    const daily = join(tmp, "Daily", "2026.05.06.md");
    expect(readFileSync(daily, "utf8")).toContain("- 10:30 — @compat-agent — compat entry");
  });
});

describe("mcp subcommand", () => {
  test("errors when no vault anywhere", async () => {
    const cfg = join(tmp, "config.yaml");
    const r = await runCli(["mcp"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: cfg, VAULT_DIR: "" },
    });
    expect(r.returncode).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("no vault configured");
    expect(r.stderr).toContain("o2b init");
  });
});
