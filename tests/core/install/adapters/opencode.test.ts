/**
 * opencode adapter tests.
 *
 * The adapter writes the config opencode actually reads:
 * `${XDG_CONFIG_HOME:-~/.config}/opencode/opencode.json`, `mcp` key,
 * entries shaped `{type: "local", command: [bin, ...args],
 * environment?, enabled: true}` (verified against opencode.ai/docs
 * 2026-06-10). Earlier Open Second Brain releases wrote
 * `~/.config/opencode/mcp.json` with an `mcpServers` key - a file
 * opencode never reads; apply migrates our keys out of it.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Writable } from "node:stream";

import { opencodeAdapter } from "../../../../src/core/install/adapters/opencode.ts";
import { buildPayload } from "../../../../src/core/install/payload.ts";
import { readManifest } from "../../../../src/core/install/manifest.ts";

let vault: string;
let home: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-opencode-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-opencode-h-"));
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
    env: { VAULT_AGENT_NAME: "a", VAULT_TIMEZONE: "UTC", ...extraEnv },
    now: new Date("2026-06-10T12:00:00.000Z"),
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

function configPath() {
  return join(home, ".config", "opencode", "opencode.json");
}

function legacyPath() {
  return join(home, ".config", "opencode", "mcp.json");
}

function writeJson(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

describe("opencode adapter - config path", () => {
  test("default path is ~/.config/opencode/opencode.json", () => {
    const r = opencodeAdapter.detect(env());
    expect(r.configPath).toBe(configPath());
  });

  test("XDG_CONFIG_HOME override is honoured", () => {
    const xdg = mkdtempSync(join(tmpdir(), "osb-xdg-"));
    const r = opencodeAdapter.detect(env({ XDG_CONFIG_HOME: xdg }));
    expect(r.configPath).toBe(join(xdg, "opencode", "opencode.json"));
    try {
      rmSync(xdg, { recursive: true, force: true });
    } catch {}
  });
});

describe("opencode adapter - apply", () => {
  test("clean home: writes opencode.json with both keys in the opencode entry schema", () => {
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    const full = parsed.mcp["open-second-brain"];
    expect(full).toEqual({
      type: "local",
      command: ["o2b", "mcp", "--vault", vault],
      environment: { VAULT_AGENT_NAME: "a", VAULT_TIMEZONE: "UTC" },
      enabled: true,
    });
    const writer = parsed.mcp["open-second-brain-writer"];
    expect(writer.command).toEqual(["o2b", "mcp", "--writer-only", "--vault", vault]);
    expect(writer.type).toBe("local");
    expect(readManifest(vault).installs["opencode"]).toBeDefined();
  });

  test("preserves user-authored opencode.json content", () => {
    writeJson(configPath(), {
      $schema: "https://opencode.ai/config.json",
      theme: "dark",
      mcp: { other: { type: "remote", url: "https://x" } },
    });
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    expect(parsed["$schema"]).toBe("https://opencode.ai/config.json");
    expect(parsed.theme).toBe("dark");
    expect(parsed.mcp.other).toEqual({ type: "remote", url: "https://x" });
    expect(parsed.mcp["open-second-brain"].type).toBe("local");
  });

  test("idempotent re-apply executes no steps", () => {
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const before = readFileSync(configPath(), "utf8");
    const second = opencodeAdapter.apply(
      opencodeAdapter.plan(payload(), env()),
      payload(),
      env(),
      applyOpts(),
    );
    expect(second.steps_executed).toBe(0);
    expect(readFileSync(configPath(), "utf8")).toBe(before);
  });
});

describe("opencode adapter - lifecycle", () => {
  test("detect installed and verify ok after apply", () => {
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    expect(opencodeAdapter.detect(env()).status).toBe("installed");
    expect(opencodeAdapter.verify(env()).status).toBe("ok");
  });

  test("verify reports drift when an entry field is edited", () => {
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    parsed.mcp["open-second-brain"].enabled = false;
    writeFileSync(configPath(), JSON.stringify(parsed, null, 2) + "\n");
    expect(opencodeAdapter.verify(env()).status).toBe("drift");
  });

  test("uninstall removes our keys, keeps user keys, clears manifest", () => {
    writeJson(configPath(), { mcp: { other: { type: "remote", url: "https://x" } } });
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    opencodeAdapter.uninstall(env(), applyOpts());
    const parsed = JSON.parse(readFileSync(configPath(), "utf8"));
    expect(parsed.mcp["open-second-brain"]).toBeUndefined();
    expect(parsed.mcp["open-second-brain-writer"]).toBeUndefined();
    expect(parsed.mcp.other).toEqual({ type: "remote", url: "https://x" });
    expect(readManifest(vault).installs["opencode"]).toBeUndefined();
  });
});

describe("opencode adapter - legacy mcp.json migration", () => {
  function legacyEntry(writerOnly = false) {
    return {
      command: "o2b",
      args: writerOnly ? ["mcp", "--writer-only", "--vault", vault] : ["mcp", "--vault", vault],
      env: { VAULT_AGENT_NAME: "a", VAULT_TIMEZONE: "UTC" },
    };
  }

  test("apply removes our keys from a legacy mcp.json, keeps user keys", () => {
    writeJson(legacyPath(), {
      mcpServers: {
        "open-second-brain": legacyEntry(),
        "open-second-brain-writer": legacyEntry(true),
        other: { command: "x", args: [] },
      },
    });
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    const legacy = JSON.parse(readFileSync(legacyPath(), "utf8"));
    expect(legacy.mcpServers["open-second-brain"]).toBeUndefined();
    expect(legacy.mcpServers["open-second-brain-writer"]).toBeUndefined();
    expect(legacy.mcpServers.other).toEqual({ command: "x", args: [] });
  });

  test("apply deletes a legacy mcp.json that contained only our keys", () => {
    writeJson(legacyPath(), {
      mcpServers: {
        "open-second-brain": legacyEntry(),
        "open-second-brain-writer": legacyEntry(true),
      },
    });
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    expect(existsSync(legacyPath())).toBe(false);
  });

  test("apply leaves a legacy mcp.json without our keys untouched", () => {
    writeJson(legacyPath(), { mcpServers: { other: { command: "x" } } });
    const before = readFileSync(legacyPath(), "utf8");
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    expect(readFileSync(legacyPath(), "utf8")).toBe(before);
  });

  test("apply ignores a malformed legacy mcp.json", () => {
    mkdirSync(dirname(legacyPath()), { recursive: true });
    writeFileSync(legacyPath(), "{ not json");
    opencodeAdapter.apply(opencodeAdapter.plan(payload(), env()), payload(), env(), applyOpts());
    expect(readFileSync(legacyPath(), "utf8")).toBe("{ not json");
    expect(JSON.parse(readFileSync(configPath(), "utf8")).mcp["open-second-brain"]).toBeDefined();
  });
});
