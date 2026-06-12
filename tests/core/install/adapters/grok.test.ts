/**
 * grok adapter tests.
 *
 * The grok integration registers MCP into `~/.grok/config.toml`
 * `[mcp_servers.*]` (grok's primary source) with an absolute `bun run
 * <repo>/src/cli/main.ts mcp …` command, and lifecycle hooks into
 * `~/.grok/hooks/open-second-brain.json`. Verified against live grok 0.2.45
 * that this is the form grok actually spawns in a session (a bundled plugin
 * with a bare `o2b` command does not load). `GROK_HOME` overrides the base dir.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { grokAdapter } from "../../../../src/core/install/adapters/grok.ts";
import { grokMcpServers, grokHooksJson } from "../../../../src/core/install/grok-asset.ts";
import { hasMcpServers } from "../../../../src/core/install/grok-config.ts";
import { buildPayload } from "../../../../src/core/install/payload.ts";
import { readManifest } from "../../../../src/core/install/manifest.ts";

let vault: string;
let home: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-grok-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-grok-h-"));
});
afterEach(() => {
  for (const d of [vault, home]) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {}
  }
});

function env(extraEnv: Record<string, string> = {}) {
  return {
    vault,
    home,
    cwd: home,
    env: { VAULT_AGENT_NAME: "a", VAULT_TIMEZONE: "UTC", ...extraEnv },
    now: new Date("2026-06-12T12:00:00.000Z"),
  };
}

function applyOpts() {
  const sink = new Writable({
    write(_c, _e, cb) {
      cb();
    },
  });
  return {
    dryRun: false,
    force: false,
    stdout: sink as unknown as NodeJS.WriteStream,
    stderr: sink as unknown as NodeJS.WriteStream,
  };
}

function payload() {
  return buildPayload({ vault, agent_name: "a", timezone: "UTC" });
}

function grokDir(base = join(home, ".grok")) {
  return base;
}
function configPath(base = join(home, ".grok")) {
  return join(base, "config.toml");
}
function hooksPath(base = join(home, ".grok")) {
  return join(base, "hooks", "open-second-brain.json");
}

function apply(e = env()) {
  return grokAdapter.apply(grokAdapter.plan(payload(), e), payload(), e, applyOpts());
}

describe("grok adapter - config path", () => {
  test("default config is ~/.grok/config.toml", () => {
    expect(grokAdapter.detect(env()).configPath).toBe(configPath());
  });
  test("GROK_HOME override is honoured", () => {
    const gh = mkdtempSync(join(tmpdir(), "osb-grokhome-"));
    expect(grokAdapter.detect(env({ GROK_HOME: gh })).configPath).toBe(configPath(gh));
    try {
      rmSync(gh, { recursive: true, force: true });
    } catch {}
  });
});

describe("grok adapter - apply", () => {
  test("writes both MCP servers into config.toml with an absolute bun command", () => {
    apply();
    const toml = readFileSync(configPath(), "utf8");
    expect(hasMcpServers(toml, grokMcpServers(payload()))).toBe(true);
    expect(toml).toContain("[mcp_servers.open-second-brain]");
    expect(toml).toContain("[mcp_servers.open-second-brain-writer]");
    // absolute command (the running bun), the repo entry point, and the vault.
    expect(toml).toContain(process.execPath);
    expect(toml).toContain("src/cli/main.ts");
    expect(toml).toContain(vault);
    expect(toml).not.toContain('command = "o2b"'); // not the bare PATH form
  });

  test("writes the lifecycle hooks file verbatim", () => {
    apply();
    expect(readFileSync(hooksPath(), "utf8")).toBe(grokHooksJson());
  });

  test("manifest records the mcp keys and the hooks path", () => {
    apply();
    const entry = readManifest(vault).installs["grok"];
    expect(entry?.owned_keys).toEqual(["open-second-brain", "open-second-brain-writer"]);
    expect(entry?.owned_paths).toContain(hooksPath());
  });

  test("preserves pre-existing config.toml content", () => {
    mkdirSync(grokDir(), { recursive: true });
    writeFileSync(configPath(), '[cli]\ninstaller = "internal"\n');
    apply();
    const toml = readFileSync(configPath(), "utf8");
    expect(toml).toContain("[cli]");
    expect(toml).toContain('installer = "internal"');
    expect(toml).toContain("[mcp_servers.open-second-brain]");
  });

  test("idempotent re-apply executes no steps", () => {
    apply();
    expect(apply().steps_executed).toBe(0);
  });

  test("dry-run writes nothing", () => {
    grokAdapter.apply(grokAdapter.plan(payload(), env()), payload(), env(), {
      ...applyOpts(),
      dryRun: true,
    });
    expect(existsSync(configPath())).toBe(false);
    expect(existsSync(hooksPath())).toBe(false);
  });

  test("re-apply refreshes a tampered hooks file", () => {
    apply();
    writeFileSync(hooksPath(), "{}\n");
    apply();
    expect(readFileSync(hooksPath(), "utf8")).toBe(grokHooksJson());
  });
});

describe("grok adapter - lifecycle", () => {
  test("detect/verify report installed+ok after apply", () => {
    apply();
    expect(grokAdapter.detect(env()).status).toBe("installed");
    expect(grokAdapter.verify(env()).status).toBe("ok");
  });

  test("clean home is not-installed", () => {
    expect(grokAdapter.detect(env()).status).toBe("not-installed");
    expect(grokAdapter.verify(env()).status).toBe("not-installed");
  });

  test("verify reports drift when the MCP servers are edited", () => {
    apply();
    const toml = readFileSync(configPath(), "utf8").replace(vault, "/somewhere/else");
    writeFileSync(configPath(), toml);
    expect(grokAdapter.verify(env()).status).toBe("drift");
  });

  test("verify reports drift when the hooks file is missing", () => {
    apply();
    rmSync(hooksPath());
    expect(grokAdapter.verify(env()).status).toBe("drift");
  });

  test("uninstall removes our MCP tables and hooks, keeps foreign config, clears manifest", () => {
    mkdirSync(grokDir(), { recursive: true });
    writeFileSync(
      configPath(),
      '[cli]\ninstaller = "internal"\n\n[mcp_servers.other]\nurl = "x"\n',
    );
    apply();
    const r = grokAdapter.uninstall(env(), applyOpts());
    const toml = readFileSync(configPath(), "utf8");
    expect(toml).toContain("[mcp_servers.other]"); // foreign server kept
    expect(toml).toContain("[cli]");
    expect(toml).not.toContain("[mcp_servers.open-second-brain]");
    expect(existsSync(hooksPath())).toBe(false);
    expect(r.removed_keys).toContain("open-second-brain");
    expect(r.removed_paths).toContain(hooksPath());
    expect(readManifest(vault).installs["grok"]).toBeUndefined();
  });
});

describe("grok adapter - plan", () => {
  test("plan lists the config.toml managed-block and the hooks file-copy", () => {
    const plan = grokAdapter.plan(payload(), env());
    const kinds = plan.steps.map((s) => s.kind);
    expect(kinds).toContain("managed-block");
    expect(kinds).toContain("file-copy");
    expect(plan.steps.map((s) => s.path)).toContain(configPath());
    expect(plan.steps.map((s) => s.path)).toContain(hooksPath());
  });
});
