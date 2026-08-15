import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  checkClaudeManifest,
  checkCodexManifest,
  checkConfigWriteable,
  checkHermesManifest,
  checkJsonManifest,
  checkOpenclawInstallability,
  checkOpenclawManifest,
  checkVaultWriteable,
  doctor,
} from "../../src/core/doctor.ts";
import { checkHermesResolverParity } from "../../src/core/doctor-hermes-parity.ts";
import { createPluginRepo, createSandboxVault } from "../helpers/fixtures.ts";

/** Env keys the resolver-parity tests must own outright. */
const OWNED_ENV = ["VAULT_DIR", "OPEN_SECOND_BRAIN_CONFIG", "XDG_CONFIG_HOME", "PATH"] as const;

let tmp: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-doctor-test-"));
  for (const key of OWNED_ENV) savedEnv[key] = process.env[key];
  delete process.env["VAULT_DIR"];
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("checkVaultWriteable", () => {
  test("ok on a writable directory", () => {
    const r = checkVaultWriteable(tmp);
    expect(r.ok).toBe(true);
    expect(r.message.toLowerCase()).toContain("writable");
  });

  test("fail when missing", () => {
    const r = checkVaultWriteable(join(tmp, "does_not_exist"));
    expect(r.ok).toBe(false);
    expect(r.message.toLowerCase()).toContain("missing");
  });

  test("a passing check carries no remediation fix", () => {
    expect(checkVaultWriteable(tmp).fix).toBeUndefined();
  });

  test("a failing check carries a copy-pasteable remediation fix", () => {
    const r = checkVaultWriteable(join(tmp, "does_not_exist"));
    expect(typeof r.fix).toBe("string");
    expect((r.fix ?? "").length).toBeGreaterThan(0);
  });
});

describe("checkConfigWriteable", () => {
  test("ok when file exists", () => {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, "vault_path: /tmp\n");
    expect(checkConfigWriteable(cfg).ok).toBe(true);
  });

  test("ok when file missing but parent can be created", () => {
    const cfg = join(tmp, "subdir", "config.yaml");
    expect(checkConfigWriteable(cfg).ok).toBe(true);
  });
});

describe("checkJsonManifest", () => {
  test("valid", () => {
    const m = join(tmp, "plugin.json");
    writeFileSync(m, '{"name": "test", "version": "1.0.0"}');
    expect(checkJsonManifest(m, "Test").ok).toBe(true);
  });

  test("invalid JSON", () => {
    const m = join(tmp, "plugin.json");
    writeFileSync(m, "{invalid json");
    expect(checkJsonManifest(m, "Test").ok).toBe(false);
  });

  test("missing", () => {
    expect(checkJsonManifest(join(tmp, "x.json"), "Test").ok).toBe(false);
  });
});

describe("manifest schema checks accept fixture repo", () => {
  test("doctor passes on a valid plugin-repo fixture", () => {
    const vault = createSandboxVault(tmp);
    const repo = createPluginRepo(tmp, true);
    const results = doctor({
      vault,
      repoRoot: repo,
      cwd: tmp,
      partner: { codegraph: { disabled: true } },
    });
    for (const r of results) {
      expect(r.ok).toBe(true);
    }
  });

  test("invalid manifests produce schema violations", () => {
    const repo = createPluginRepo(tmp, false);
    const claude = checkClaudeManifest(join(repo, ".claude-plugin", "plugin.json"));
    const codex = checkCodexManifest(join(repo, ".codex-plugin", "plugin.json"));
    const hermes = checkHermesManifest(join(repo, "plugins", "hermes", "plugin.yaml"));
    const openclaw = checkOpenclawManifest(join(repo, "openclaw.plugin.json"));
    expect(claude.ok).toBe(false);
    expect(codex.ok).toBe(false);
    expect(hermes.ok).toBe(false);
    expect(openclaw.ok).toBe(false);
  });
});

describe("checkOpenclawInstallability", () => {
  test("reports missing extension entry", () => {
    const repo = createPluginRepo(tmp, true);
    // Replace package.json with one that points at a missing entry.
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "test", openclaw: { extensions: ["./does-not-exist.js"] } }),
    );
    const results = checkOpenclawInstallability(repo);
    const failing = results.filter((r) => !r.ok);
    expect(failing.length).toBeGreaterThan(0);
    expect(failing.some((r) => r.message.includes("missing extension entry"))).toBe(true);
  });

  test("rejects when extensions array is missing", () => {
    const repo = createPluginRepo(tmp, true);
    writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "test" }));
    const results = checkOpenclawInstallability(repo);
    expect(results.some((r) => !r.ok && r.name === "openclaw_package_json_extensions")).toBe(true);
  });
});

describe("checkHermesResolverParity", () => {
  /**
   * A stand-in for `plugins/hermes/config.py`. The check under test is the
   * COMPARISON, so each case pins what the plugin side answers rather than
   * re-running the real resolver - whose agreement with the core is pinned,
   * fixture row by fixture row, in `tests/python/test_resolver_parity.py`.
   */
  function stubPluginResolver(body: string): string {
    const root = join(tmp, "checkout");
    mkdirSync(join(root, "plugins", "hermes"), { recursive: true });
    writeFileSync(join(root, "plugins", "hermes", "config.py"), body);
    return root;
  }

  function writeConfig(vault: string): string {
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, `vault: "${vault}"\n`);
    return cfg;
  }

  test("does not apply when the plugin is not part of the installation", () => {
    const root = join(tmp, "no-plugin");
    mkdirSync(root, { recursive: true });
    expect(checkHermesResolverParity({ repoRoot: root, config: writeConfig("/v"), cwd: tmp })).toBe(
      null,
    );
  });

  test("passes when both resolvers name the same vault", () => {
    const root = stubPluginResolver('def resolve_vault():\n    return "/agreed/vault"\n');
    const r = checkHermesResolverParity({
      repoRoot: root,
      config: writeConfig("/agreed/vault"),
      cwd: tmp,
    });
    expect(r?.ok).toBe(true);
    expect(r?.message).toContain("/agreed/vault");
  });

  test("passes when both resolvers agree no vault is configured", () => {
    const root = stubPluginResolver("def resolve_vault():\n    return None\n");
    const cfg = join(tmp, "config.yaml");
    writeFileSync(cfg, "agent_name: solo\n");
    const r = checkHermesResolverParity({ repoRoot: root, config: cfg, cwd: tmp });
    expect(r?.ok).toBe(true);
    expect(r?.message.toLowerCase()).toContain("no vault");
  });

  test("fails, naming both answers, when the resolvers disagree", () => {
    const root = stubPluginResolver("def resolve_vault():\n    return None\n");
    const r = checkHermesResolverParity({
      repoRoot: root,
      config: writeConfig("/core/vault"),
      cwd: tmp,
    });
    expect(r?.ok).toBe(false);
    expect(r?.message).toContain("disagree");
    expect(r?.message).toContain("/core/vault");
    expect(typeof r?.fix).toBe("string");
  });

  test("an unmeasurable plugin side is reported as such, never as clean", () => {
    const root = stubPluginResolver(
      'def resolve_vault():\n    raise RuntimeError("resolver is broken")\n',
    );
    const r = checkHermesResolverParity({
      repoRoot: root,
      config: writeConfig("/core/vault"),
      cwd: tmp,
    });
    expect(r?.ok).toBe(false);
    expect(r?.message).toContain("could not be measured");
    expect(r?.message).toContain("resolver is broken");
  });

  test("an absent Python interpreter is a could-not-measure, never a pass", () => {
    const root = stubPluginResolver('def resolve_vault():\n    return "/agreed/vault"\n');
    // An empty PATH falls back to the platform default, so point it at a
    // directory that exists and holds nothing.
    process.env["PATH"] = join(tmp, "empty-bin");
    mkdirSync(process.env["PATH"], { recursive: true });
    const r = checkHermesResolverParity({
      repoRoot: root,
      config: writeConfig("/agreed/vault"),
      cwd: tmp,
    });
    expect(r?.ok).toBe(false);
    expect(r?.message).toContain("no Python interpreter available");
  });

  test("a core side that refuses the config is reported with its reason", () => {
    const root = stubPluginResolver("def resolve_vault():\n    return None\n");
    const cfg = join(tmp, "config.yaml");
    mkdirSync(cfg);
    const r = checkHermesResolverParity({ repoRoot: root, config: cfg, cwd: tmp });
    expect(r?.ok).toBe(false);
    expect(r?.message).toContain("could not determine");
    expect(r?.message).toContain("not a regular file");
  });
});

describe("doctor aggregator", () => {
  test("returns at least the vault check", () => {
    // `cwd` is pinned to the temp vault rather than left to default.
    // Without it the aggregator walks up from the process's working
    // directory, finds THIS repository, decides it is a code project and
    // consults the codegraph partner - several seconds on any machine
    // that has the binary, and nothing this test asserts on. The partner
    // has its own tests; this one is about the aggregator returning.
    const results = doctor({ vault: tmp, cwd: tmp });
    expect(results.length).toBeGreaterThan(0);
  });

  test("omits code_graph when no code project is reachable from cwd or vault", () => {
    const vaultDir = join(tmp, "vault");
    mkdirSync(vaultDir);
    const results = doctor({ vault: vaultDir, cwd: vaultDir });
    expect(results.some((r) => r.name === "code_graph")).toBe(false);
  });

  test("reports code_graph as deliberately not consulted when the check is disabled", () => {
    // This test asserted OMISSION until the switch gained a producer.
    // Omission was the wrong report: an operator who turned the check
    // off, one whose machine has no codegraph, and one standing outside
    // a code project all read the same empty result, so a setting that
    // had just taken effect was indistinguishable from one that had done
    // nothing. The line says the partner was not consulted and that
    // nothing is therefore claimed about any index - which is the only
    // honest thing to say about a check that did not run.
    const repo = join(tmp, "myrepo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "package.json"), "{}\n");
    const vaultDir = join(tmp, "vault");
    mkdirSync(vaultDir);
    const results = doctor({
      vault: vaultDir,
      cwd: repo,
      partner: { codegraph: { disabled: true } },
    });
    const codeGraph = results.find((r) => r.name === "code_graph");
    expect(codeGraph).toBeDefined();
    // Not a failure: a deliberate operator choice must not fail a doctor.
    expect(codeGraph?.ok).toBe(true);
    expect(codeGraph?.message).toContain("was not consulted");
  });

  test("includes code_graph for a code project only when codegraph is installed", () => {
    const repo = join(tmp, "myrepo");
    mkdirSync(join(repo, ".git"), { recursive: true });
    writeFileSync(join(repo, "package.json"), "{}\n");
    const vaultDir = join(tmp, "vault");
    mkdirSync(vaultDir);
    const results = doctor({ vault: vaultDir, cwd: repo });
    // codegraph is an optional partner: the check appears for a code project
    // only when the CLI is actually installed (it is skipped otherwise), so
    // this stays hermetic whether or not the runner has codegraph.
    const codegraphInstalled =
      (Bun as unknown as { which: (c: string) => string | null }).which("codegraph") !== null;
    expect(results.some((r) => r.name === "code_graph")).toBe(codegraphInstalled);
  });
});
