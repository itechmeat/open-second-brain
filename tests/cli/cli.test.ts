import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { BRAIN_INDEX_REL, BRAIN_ROOT_REL } from "../../src/core/brain/paths.ts";
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
    const r = await runCli(["status"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("config_exists: false");
    expect(r.stdout).toContain(config);
  });
});

describe("init", () => {
  test("prints initialized vault message", async () => {
    const r = await runCli(["init", "--vault", tmp, "--name", "Test"]);
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("initialized vault:");
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
      [
        "init",
        "--vault",
        vault,
        "--name",
        "Test",
        "--agent-name",
        "hermes-vps-agent",
        "--timezone",
        "Europe/Belgrade",
      ],
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
});

describe("doctor", () => {
  test("errors when no vault anywhere", async () => {
    const cfg = join(tmp, "config.yaml");
    const r = await runCli(["doctor"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: cfg },
    });
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

  test("prints a copy-pasteable fix and an aggregate summary for a failure", async () => {
    const r = await runCli(["doctor", "--vault", "/nonexistent/path"]);
    expect(r.returncode).toBe(1);
    expect(r.stdout).toContain("fix: mkdir -p");
    expect(r.stdout).toMatch(/doctor: \d+ checks, [1-9]\d* failed/);
  });

  test("--json emits a scriptable report with fix and summary", async () => {
    const r = await runCli(["doctor", "--vault", "/nonexistent/path", "--json"]);
    expect(r.returncode).toBe(1);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(false);
    expect(parsed.summary.failed).toBeGreaterThan(0);
    const failing = parsed.checks.find((c: { ok: boolean }) => !c.ok);
    expect(typeof failing.fix).toBe("string");
    expect(failing.fix.length).toBeGreaterThan(0);
  });

  test("--json on a healthy vault reports ok with zero failures", async () => {
    const r = await runCli(["doctor", "--vault", tmp, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: "", XDG_CONFIG_HOME: "", VAULT_DIR: "" },
    });
    expect(r.returncode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.ok).toBe(true);
    expect(parsed.summary.failed).toBe(0);
    // A passing check omits the remediation fix.
    expect(parsed.checks.every((c: { fix?: string }) => c.fix === undefined)).toBe(true);
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

  // Semantic search forced off so the readiness probes are deterministic
  // (llm_key + embedding_provider skip; adapter wiring passes) regardless
  // of any embedding env in the developer's shell.
  const READINESS_ENV = {
    OPEN_SECOND_BRAIN_CONFIG: "",
    XDG_CONFIG_HOME: "",
    VAULT_DIR: "",
    OPEN_SECOND_BRAIN_SEARCH_SEMANTIC: "false",
  };

  test("without --readiness the output has no readiness section (byte-identical opt-out)", async () => {
    const plain = await runCli(["doctor", "--vault", tmp], { env: READINESS_ENV });
    expect(plain.returncode).toBe(0);
    expect(plain.stdout).not.toContain("readiness:");

    const withFlag = await runCli(["doctor", "--vault", tmp, "--readiness"], {
      env: READINESS_ENV,
    });
    // The readiness run appends its section; the base output is unchanged,
    // so the plain output is an exact prefix of the readiness output.
    expect(withFlag.stdout.startsWith(plain.stdout)).toBe(true);
  });

  test("--readiness runs the three probes with explicit outcomes", async () => {
    const r = await runCli(["doctor", "--vault", tmp, "--readiness"], { env: READINESS_ENV });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("readiness:");
    expect(r.stdout).toContain("llm_key:");
    expect(r.stdout).toContain("embedding_provider:");
    expect(r.stdout).toContain("runtime_adapter_wiring:");
    // No silent pass: skipped surfaces explicitly, and wiring passes.
    expect(r.stdout).toContain("[SKIP] llm_key:");
    expect(r.stdout).toContain("[PASS] runtime_adapter_wiring:");
  });

  test("--readiness --json omits the readiness key without the flag and adds it with it", async () => {
    const plain = await runCli(["doctor", "--vault", tmp, "--json"], { env: READINESS_ENV });
    expect(JSON.parse(plain.stdout).readiness).toBeUndefined();

    const withFlag = await runCli(["doctor", "--vault", tmp, "--json", "--readiness"], {
      env: READINESS_ENV,
    });
    const parsed = JSON.parse(withFlag.stdout);
    expect(Array.isArray(parsed.readiness)).toBe(true);
    expect(parsed.readiness.length).toBe(3);
    expect(parsed.readiness.every((p: { status: string }) => typeof p.status === "string")).toBe(
      true,
    );
  });

  test("--readiness exits 1 with a fail reason when a probe fails", async () => {
    // A key-requiring embedding provider (openai-compat) with no key makes the
    // llm_key probe fail deterministically - the phase-4 QA scenario.
    const cfg = join(tmp, "readiness-fail-config.yaml");
    writeFileSync(
      cfg,
      [
        `vault: ${tmp}`,
        'search_semantic_enabled: "true"',
        'embedding_provider: "openai-compat"',
        'embedding_base_url: "https://example.invalid/v1"',
        'embedding_model: "test-model"',
      ].join("\n") + "\n",
      "utf8",
    );
    const r = await runCli(["doctor", "--vault", tmp, "--readiness"], {
      env: {
        OPEN_SECOND_BRAIN_CONFIG: cfg,
        XDG_CONFIG_HOME: "",
        VAULT_DIR: "",
        // Fall through to the config file (empty = unset), and make sure no
        // developer-shell embedding key leaks in to rescue the probe.
        OPEN_SECOND_BRAIN_SEARCH_SEMANTIC: "",
        OPEN_SECOND_BRAIN_EMBEDDING_KEY: "",
        OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER: "",
      },
    });
    expect(r.returncode).toBe(1);
    expect(r.stdout).toContain("[FAIL] llm_key:");
    // The failure carries a reason, never a silent fail.
    expect(r.stdout).toMatch(/\[FAIL\] llm_key:.+/);
  });
});

describe("onboarding", () => {
  test("init prints the guided onboarding checklist after the search block", async () => {
    const vault = join(tmp, "ob-vault");
    const config = join(tmp, "ob-config.yaml");
    const r = await runCli(["init", "--vault", vault], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config, XDG_CONFIG_HOME: "", VAULT_DIR: "" },
    });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("initialized vault");
    expect(r.stdout).toContain("Next steps:");
    expect(r.stdout).toContain("o2b search index");
  });

  test("o2b onboarding re-runs the checklist and supports --json", async () => {
    const vault = join(tmp, "ob-vault2");
    const config = join(tmp, "ob-config2.yaml");
    const env = { OPEN_SECOND_BRAIN_CONFIG: config, XDG_CONFIG_HOME: "", VAULT_DIR: "" };
    await runCli(["init", "--vault", vault], { env });

    const text = await runCli(["onboarding", "--vault", vault, "--config", config], { env });
    expect(text.returncode).toBe(0);
    expect(text.stdout).toContain("Next steps:");

    const json = await runCli(["onboarding", "--vault", vault, "--config", config, "--json"], {
      env,
    });
    const parsed = JSON.parse(json.stdout);
    expect(Array.isArray(parsed.steps)).toBe(true);
    expect(parsed.steps.find((s: { id: string }) => s.id === "vault_configured").done).toBe(true);
  });
});

describe("index", () => {
  test("errors when no vault anywhere", async () => {
    const cfg = join(tmp, "config.yaml");
    const r = await runCli(["index"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: cfg },
    });
    expect(r.returncode).not.toBe(0);
    expect(r.stderr.toLowerCase()).toContain("no vault configured");
  });

  test("generates wikilink index under Brain/", async () => {
    const vault = tmp;
    mkdirSync(join(vault, BRAIN_ROOT_REL), { recursive: true });
    writeFileSync(join(vault, "Concept.md"), "---\ntitle: Concept\n---\n\nBody.");
    writeFileSync(join(vault, "Other.md"), "No frontmatter.");
    const r = await runCli(["index", "--vault", vault]);
    expect(r.returncode).toBe(0);
    const indexPath = join(vault, BRAIN_INDEX_REL);
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

describe("secrets", () => {
  test("list reports references without resolved values", async () => {
    const config = join(tmp, "config.yaml");
    writeFileSync(config, 'github_token: "$secret:GITHUB_TOKEN"\nplain: visible\n');

    const r = await runCli(["secrets", "list", "--config", config, "--json"], {
      env: {
        OPEN_SECOND_BRAIN_CONFIG: config,
        GITHUB_TOKEN: "ghp_secret_value",
      },
    });

    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain("ghp_secret_value");
    const data = JSON.parse(r.stdout);
    expect(data.secrets).toEqual([
      {
        config_key: "github_token",
        name: "GITHUB_TOKEN",
        available: true,
      },
    ]);
  });

  test("status never prints the resolved value", async () => {
    const config = join(tmp, "config.yaml");

    const r = await runCli(["secrets", "status", "GITHUB_TOKEN", "--config", config, "--json"], {
      env: {
        OPEN_SECOND_BRAIN_CONFIG: config,
        GITHUB_TOKEN: "ghp_secret_value",
      },
    });

    expect(r.returncode).toBe(0);
    expect(r.stdout).not.toContain("ghp_secret_value");
    expect(JSON.parse(r.stdout)).toEqual({
      name: "GITHUB_TOKEN",
      available: true,
    });
  });

  test("status exits non-zero for missing secrets", async () => {
    const config = join(tmp, "config.yaml");

    const r = await runCli(["secrets", "status", "MISSING_SECRET", "--config", config, "--json"], {
      env: { OPEN_SECOND_BRAIN_CONFIG: config },
    });

    expect(r.returncode).toBe(1);
    expect(JSON.parse(r.stdout)).toEqual({
      name: "MISSING_SECRET",
      available: false,
    });
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
