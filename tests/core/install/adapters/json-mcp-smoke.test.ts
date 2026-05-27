/**
 * Smoke tests for opencode / kiro / gemini-cli adapters.
 *
 * They share the same JSON-merge body as cursor (deeply tested in
 * `cursor.test.ts`). Here we only assert that each adapter
 * resolves the expected per-target config path and that a
 * clean install+uninstall cycle works end-to-end.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { opencodeAdapter } from "../../../../src/core/install/adapters/opencode.ts";
import { kiroAdapter } from "../../../../src/core/install/adapters/kiro.ts";
import { geminiCliAdapter } from "../../../../src/core/install/adapters/gemini-cli.ts";
import { buildPayload } from "../../../../src/core/install/payload.ts";
import { readManifest } from "../../../../src/core/install/manifest.ts";

let vault: string;
let home: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-jsonmcp-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-jsonmcp-h-"));
});
afterEach(() => {
  try {
    rmSync(vault, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

function env(extraEnv: Record<string, string> = {}) {
  return {
    vault,
    home,
    cwd: home,
    // verify() rebuilds the canonical payload from these env vars; they
    // must match the values passed to buildPayload() below or every
    // smoke check would report drift.
    env: { VAULT_AGENT_NAME: "a", VAULT_TIMEZONE: "UTC", ...extraEnv },
    now: new Date("2026-05-20T12:00:00.000Z"),
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

describe("opencode adapter — config path resolution", () => {
  test("default path is ~/.config/opencode/mcp.json", () => {
    const r = opencodeAdapter.detect(env());
    expect(r.configPath).toBe(join(home, ".config", "opencode", "mcp.json"));
  });

  test("XDG_CONFIG_HOME override is honoured", () => {
    const xdg = mkdtempSync(join(tmpdir(), "osb-xdg-"));
    const r = opencodeAdapter.detect(env({ XDG_CONFIG_HOME: xdg }));
    expect(r.configPath).toBe(join(xdg, "opencode", "mcp.json"));
    try {
      rmSync(xdg, { recursive: true, force: true });
    } catch {}
  });

  test("install + uninstall round-trip", () => {
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const path = opencodeAdapter.detect(env()).configPath!;
    expect(existsSync(path)).toBe(true);
    expect(readManifest(vault).installs.opencode).toBeDefined();

    opencodeAdapter.uninstall(env(), applyOpts());
    expect(readManifest(vault).installs.opencode).toBeUndefined();
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect(parsed.mcpServers["open-second-brain"]).toBeUndefined();
  });
});

describe("kiro adapter — config path resolution", () => {
  test("default path is ~/.kiro/settings.json", () => {
    const r = kiroAdapter.detect(env());
    expect(r.configPath).toBe(join(home, ".kiro", "settings.json"));
  });

  test("install + verify ok", () => {
    kiroAdapter.apply(kiroAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    expect(kiroAdapter.verify(env()).status).toBe("ok");
  });
});

describe("gemini-cli adapter — config path resolution", () => {
  test("default path is ~/.gemini/settings.json", () => {
    const r = geminiCliAdapter.detect(env());
    expect(r.configPath).toBe(join(home, ".gemini", "settings.json"));
  });

  test("install + verify ok", () => {
    geminiCliAdapter.apply(geminiCliAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    expect(geminiCliAdapter.verify(env()).status).toBe("ok");
  });
});
