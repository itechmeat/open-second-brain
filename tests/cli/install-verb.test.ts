/**
 * `o2b install` CLI verb — subprocess-level tests.
 *
 * The adapter modules each have direct unit tests; here we verify
 * the verb wiring: detect-only printout, plan-only mode, --apply,
 * --check, --json, exit codes.
 */

import { describe, expect, test, beforeEach, afterEach, setDefaultTimeout } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { runCli as baseRunCli, type RunCliOptions, type RunResult } from "../helpers/run-cli.ts";
import { INSTALL_EXIT, exitCodeForVerify } from "../../src/cli/install/install.ts";
import type { VerifyResult } from "../../src/core/install/types.ts";

// The install/uninstall adapters resolve the target home directory from the
// environment at module-load time, so they need a fresh child process per call
// to honor this test's per-case temp HOME (the in-process fast path shares one
// already-loaded module graph). Force the subprocess path for every call here.
function runCli(args: ReadonlyArray<string>, opts: RunCliOptions = {}): Promise<RunResult> {
  return baseRunCli(args, { ...opts, subprocess: true });
}

// Every case here therefore pays a cold process start, which does not fit
// bun's 5 s default on a machine doing other work.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

let vault: string;
let home: string;
let configPath: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-install-verb-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-install-verb-h-"));
  configPath = join(home, "config.yaml");
  writeFileSync(configPath, `vault: "${vault}"\nagent_name: "claude-vps"\ntimezone: "UTC"\n`);
});
afterEach(() => {
  for (const p of [vault, home]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {}
  }
});

function envBase(extra: Record<string, string> = {}) {
  return {
    HOME: home,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    VAULT_DIR: vault,
    VAULT_AGENT_NAME: "claude-vps",
    VAULT_TIMEZONE: "UTC",
    ...extra,
  };
}

describe("o2b install — detect mode", () => {
  test("no args prints the table with no file writes", async () => {
    const r = await runCli(["install"], { env: envBase() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("detected runtimes");
    // No file should have been written
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  });

  test("--json emits machine-readable payload", async () => {
    const r = await runCli(["install", "--json"], { env: envBase() });
    expect(r.returncode).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(parsed.schema_version).toBe(1);
    expect(Array.isArray(parsed.targets)).toBe(true);
    expect(parsed.targets.length).toBeGreaterThan(0);
  });
});

describe("o2b install --target X (plan-only)", () => {
  test("prints plan without touching the file system", async () => {
    const r = await runCli(["install", "--target", "cursor"], { env: envBase() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("plan");
    expect(r.stdout).toContain("json-merge");
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  });

  test("--target unknown exits 2", async () => {
    const r = await runCli(["install", "--target", "nope"], { env: envBase() });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("unknown --target");
  });
});

describe("o2b install --target X --apply", () => {
  test("writes the cursor config file", async () => {
    const r = await runCli(["install", "--target", "cursor", "--apply"], { env: envBase() });
    expect(r.returncode).toBe(0);
    const cfgPath = join(home, ".cursor", "mcp.json");
    expect(existsSync(cfgPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    expect(parsed.mcpServers["open-second-brain"]).toBeDefined();
    expect(parsed.mcpServers["open-second-brain-writer"]).toBeDefined();
  });

  test("user hand-edit + re-apply without --force exits 4", async () => {
    await runCli(["install", "--target", "cursor", "--apply"], { env: envBase() });
    const cfgPath = join(home, ".cursor", "mcp.json");
    const before = JSON.parse(readFileSync(cfgPath, "utf8"));
    before.mcpServers["open-second-brain"] = { command: "TAMPERED", args: [] };
    writeFileSync(cfgPath, JSON.stringify(before, null, 2) + "\n");
    // bump mtime well into the future
    const future = new Date(Date.now() + 3600 * 1000);
    utimesSync(cfgPath, future, future);

    const r = await runCli(["install", "--target", "cursor", "--apply"], { env: envBase() });
    expect(r.returncode).toBe(4);
    expect(r.stderr).toContain("hand-edited");
  });
});

describe("o2b install --target generic", () => {
  test("--out <path> writes the JSON payload to that path", async () => {
    const outPath = join(home, "snippet.json");
    const r = await runCli(["install", "--target", "generic", "--apply", "--out", outPath], {
      env: envBase(),
    });
    expect(r.returncode).toBe(0);
    expect(existsSync(outPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(outPath, "utf8"));
    expect(parsed.mcpServers["open-second-brain"]).toBeDefined();
  });

  test("--format yaml emits YAML to stdout", async () => {
    const r = await runCli(
      ["install", "--target", "generic", "--apply", "--out", "-", "--format", "yaml"],
      { env: envBase() },
    );
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("mcpServers:");
  });
});

describe("o2b install --check", () => {
  test("with no installs, exits 0 with 'not-installed' rows", async () => {
    const r = await runCli(["install", "--check"], { env: envBase() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("not-installed");
  });

  test("after install --apply, reports ok and exits 0", async () => {
    await runCli(["install", "--target", "cursor", "--apply"], { env: envBase() });
    const r = await runCli(["install", "--check", "--target", "cursor"], { env: envBase() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("ok");
    // The `ok` is a configuration comparison, and says so: nothing here
    // spoke MCP to Cursor.
    expect(r.stdout).toContain("no MCP handshake attempted");
  });

  test("--check without configured vault exits 2 with vault-not-configured", async () => {
    // Pass an empty/unwritable config + no VAULT_DIR — every adapter would
    // otherwise silently report not-installed against a bogus path.
    const r = await runCli(["install", "--check"], { env: { VAULT_DIR: "" } });
    expect(r.returncode).toBe(2);
    expect(r.stderr).toContain("vault not configured");
  });

  test("after partial-key drift, exits 3", async () => {
    await runCli(["install", "--target", "cursor", "--apply"], { env: envBase() });
    const cfgPath = join(home, ".cursor", "mcp.json");
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    delete parsed.mcpServers["open-second-brain-writer"];
    writeFileSync(cfgPath, JSON.stringify(parsed, null, 2) + "\n");
    const r = await runCli(["install", "--check", "--target", "cursor"], { env: envBase() });
    expect(r.returncode).toBe(3);
    expect(r.stdout).toContain("drift");
  });

  test("after canonical payload drift, exits 3", async () => {
    await runCli(["install", "--target", "cursor", "--apply"], { env: envBase() });
    const cfgPath = join(home, ".cursor", "mcp.json");
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8"));
    parsed.mcpServers["open-second-brain"].command = "TAMPERED";
    writeFileSync(cfgPath, JSON.stringify(parsed, null, 2) + "\n");
    const r = await runCli(["install", "--check", "--target", "cursor"], { env: envBase() });
    expect(r.returncode).toBe(3);
    expect(r.stdout).toContain("canonical payload");
  });
});

function row(status: VerifyResult["status"], target = "unit"): VerifyResult {
  return { target, status, details: [`${target}: ${status}`], fix_hint: null };
}

describe("o2b install --check exit codes distinguish the verify states", () => {
  test("a runtime proved unreachable does not exit 0", () => {
    const code = exitCodeForVerify([row("mcp-unreachable")]);
    expect(code).toBe(INSTALL_EXIT.mcpUnreachable);
    expect(code).not.toBe(INSTALL_EXIT.ok);
  });

  test("unreachable and not-installed are different codes", () => {
    expect(exitCodeForVerify([row("not-installed")])).toBe(INSTALL_EXIT.ok);
    expect(exitCodeForVerify([row("mcp-unreachable")])).not.toBe(
      exitCodeForVerify([row("not-installed")]),
    );
  });

  test("ok alone is success, and drift keeps its historical code", () => {
    expect(exitCodeForVerify([row("ok")])).toBe(INSTALL_EXIT.ok);
    expect(exitCodeForVerify([row("drift")])).toBe(INSTALL_EXIT.drift);
    expect(INSTALL_EXIT.drift).toBe(3);
  });

  test("drift outranks unreachable: the config must be right before liveness means anything", () => {
    expect(exitCodeForVerify([row("mcp-unreachable", "a"), row("drift", "b")])).toBe(
      INSTALL_EXIT.drift,
    );
  });

  test("every exit code is distinct", () => {
    const codes = Object.values(INSTALL_EXIT);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("o2b uninstall --target X", () => {
  test("dry-run prints what would be removed but does nothing", async () => {
    await runCli(["install", "--target", "cursor", "--apply"], { env: envBase() });
    const r = await runCli(["uninstall", "--target", "cursor"], { env: envBase() });
    expect(r.returncode).toBe(0);
    expect(r.stdout).toContain("dry-run");
    // file still has OSB keys
    const parsed = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
    expect(parsed.mcpServers["open-second-brain"]).toBeDefined();
  });

  test("--apply removes OSB keys", async () => {
    await runCli(["install", "--target", "cursor", "--apply"], { env: envBase() });
    const r = await runCli(["uninstall", "--target", "cursor", "--apply"], { env: envBase() });
    expect(r.returncode).toBe(0);
    const parsed = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
    expect(parsed.mcpServers["open-second-brain"]).toBeUndefined();
    expect(parsed.mcpServers["open-second-brain-writer"]).toBeUndefined();
  });

  test("--target unknown exits 2", async () => {
    const r = await runCli(["uninstall", "--target", "nope", "--apply"], { env: envBase() });
    expect(r.returncode).toBe(2);
  });
});
