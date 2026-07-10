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
import { createPluginRepo, createSandboxVault } from "../helpers/fixtures.ts";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-doctor-test-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
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

describe("doctor aggregator", () => {
  test("returns at least the vault check", () => {
    const results = doctor({ vault: tmp });
    expect(results.length).toBeGreaterThan(0);
  });

  test("omits code_graph when no code project is reachable from cwd or vault", () => {
    const vaultDir = join(tmp, "vault");
    mkdirSync(vaultDir);
    const results = doctor({ vault: vaultDir, cwd: vaultDir });
    expect(results.some((r) => r.name === "code_graph")).toBe(false);
  });

  test("omits code_graph when partner.codegraph.disabled is true", () => {
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
    expect(results.some((r) => r.name === "code_graph")).toBe(false);
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
