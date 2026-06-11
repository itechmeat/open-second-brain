/**
 * grok adapter tests.
 *
 * The grok integration is a static plugin tree copied into
 * `${GROK_HOME:-~/.grok}/plugins/open-second-brain/`. Verified against live
 * grok 0.2.45: a user-scope plugin dropped there is auto-enabled and
 * auto-trusted (its MCP servers and hooks load) with no config.toml entry, so
 * the adapter only copies the committed tree and tracks it in the manifest. No
 * config file is written, so there is nothing to merge and the canonical MCP
 * payload is not used (the plugin ships its own vault-agnostic `.mcp.json`).
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { grokAdapter } from "../../../../src/core/install/adapters/grok.ts";
import { readGrokPluginFiles } from "../../../../src/core/install/grok-plugin-asset.ts";
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
    now: new Date("2026-06-11T12:00:00.000Z"),
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

function pluginDir(base = join(home, ".grok")) {
  return join(base, "plugins", "open-second-brain");
}

function apply(e = env()) {
  return grokAdapter.apply(grokAdapter.plan(payload(), e), payload(), e, applyOpts());
}

describe("grok adapter - config path", () => {
  test("default plugin dir is ~/.grok/plugins/open-second-brain", () => {
    expect(grokAdapter.detect(env()).configPath).toBe(pluginDir());
  });

  test("GROK_HOME override is honoured", () => {
    const gh = mkdtempSync(join(tmpdir(), "osb-grokhome-"));
    expect(grokAdapter.detect(env({ GROK_HOME: gh })).configPath).toBe(pluginDir(gh));
    try {
      rmSync(gh, { recursive: true, force: true });
    } catch {}
  });
});

describe("grok adapter - apply", () => {
  test("clean home: writes the full plugin tree verbatim", () => {
    apply();
    for (const f of readGrokPluginFiles()) {
      expect(readFileSync(join(pluginDir(), f.relPath), "utf8")).toBe(f.content);
    }
    expect(readManifest(vault).installs["grok"]).toBeDefined();
  });

  test("manifest records every plugin file as an owned path", () => {
    apply();
    const owned = readManifest(vault).installs["grok"]?.owned_paths ?? [];
    for (const f of readGrokPluginFiles()) {
      expect(owned).toContain(join(pluginDir(), f.relPath));
    }
  });

  test("idempotent re-apply executes no steps", () => {
    apply();
    const second = apply();
    expect(second.steps_executed).toBe(0);
  });

  test("dry-run writes nothing", () => {
    grokAdapter.apply(grokAdapter.plan(payload(), env()), payload(), env(), {
      ...applyOpts(),
      dryRun: true,
    });
    expect(existsSync(pluginDir())).toBe(false);
  });

  test("re-apply refreshes an outdated file", () => {
    apply();
    writeFileSync(join(pluginDir(), "plugin.json"), '{ "stale": true }\n');
    apply();
    const expected = readGrokPluginFiles().find((f) => f.relPath === "plugin.json")!.content;
    expect(readFileSync(join(pluginDir(), "plugin.json"), "utf8")).toBe(expected);
  });
});

describe("grok adapter - lifecycle", () => {
  test("detect installed and verify ok after apply", () => {
    apply();
    expect(grokAdapter.detect(env()).status).toBe("installed");
    expect(grokAdapter.verify(env()).status).toBe("ok");
  });

  test("detect not-installed on a clean home", () => {
    expect(grokAdapter.detect(env()).status).toBe("not-installed");
    expect(grokAdapter.verify(env()).status).toBe("not-installed");
  });

  test("verify reports drift when an installed file is edited", () => {
    apply();
    writeFileSync(join(pluginDir(), "hooks", "hooks.json"), "{}\n");
    expect(grokAdapter.verify(env()).status).toBe("drift");
  });

  test("verify reports drift when a file is missing", () => {
    apply();
    rmSync(join(pluginDir(), ".mcp.json"));
    expect(grokAdapter.verify(env()).status).toBe("drift");
  });

  test("verify reports drift when a plugin file is a directory", () => {
    apply();
    rmSync(join(pluginDir(), ".mcp.json"));
    mkdirSync(join(pluginDir(), ".mcp.json"), { recursive: true });
    expect(grokAdapter.verify(env()).status).toBe("drift");
  });

  test("uninstall removes the plugin files, leaves no empty shell, clears the manifest", () => {
    apply();
    const r = grokAdapter.uninstall(env(), applyOpts());
    for (const f of readGrokPluginFiles()) {
      expect(existsSync(join(pluginDir(), f.relPath))).toBe(false);
      expect(r.removed_paths).toContain(join(pluginDir(), f.relPath));
    }
    // No empty directory shell is left behind (hooks/ then the plugin root).
    expect(existsSync(join(pluginDir(), "hooks"))).toBe(false);
    expect(existsSync(pluginDir())).toBe(false);
    expect(readManifest(vault).installs["grok"]).toBeUndefined();
  });
});

describe("grok adapter - plan", () => {
  test("plan lists a file-copy step for every plugin file", () => {
    const plan = grokAdapter.plan(payload(), env());
    expect(plan.steps.every((s) => s.kind === "file-copy")).toBe(true);
    const paths = plan.steps.map((s) => s.path);
    for (const f of readGrokPluginFiles()) {
      expect(paths).toContain(join(pluginDir(), f.relPath));
    }
  });
});
