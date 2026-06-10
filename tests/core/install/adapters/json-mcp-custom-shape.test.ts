/**
 * Lifecycle test for the entry-shape injection points on
 * `createJsonMcpAdapter` (`serializeEntry` + `entryEquals`).
 *
 * Uses an inline spec with an opencode-style entry shape
 * (`{type, command: [bin, ...args], environment?, enabled}`) and walks
 * detect → plan → apply → verify → drift → uninstall against temp dirs.
 * The real opencode adapter has its own test file; this one pins the
 * shared body's behavior for ANY custom shape.
 */

import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { createJsonMcpAdapter } from "../../../../src/core/install/adapters/_json-mcp.ts";
import { buildPayload } from "../../../../src/core/install/payload.ts";
import { readManifest } from "../../../../src/core/install/manifest.ts";
import { deepJsonEquals } from "../../../../src/core/install/payload-equals.ts";
import type { InstallEnv, McpServerEntry } from "../../../../src/core/install/types.ts";

let vault: string;
let home: string;

beforeEach(() => {
  vault = mkdtempSync(join(tmpdir(), "osb-shape-v-"));
  home = mkdtempSync(join(tmpdir(), "osb-shape-h-"));
});
afterEach(() => {
  try {
    rmSync(vault, { recursive: true, force: true });
  } catch {}
  try {
    rmSync(home, { recursive: true, force: true });
  } catch {}
});

function customShape(e: McpServerEntry): Record<string, unknown> {
  return {
    type: "local",
    command: [e.command, ...e.args],
    ...(e.env && Object.keys(e.env).length > 0 ? { environment: { ...e.env } } : {}),
    enabled: true,
  };
}

const adapter = createJsonMcpAdapter({
  target: "custom-shape-test",
  label: "custom shape (test only)",
  topLevelKey: "mcp",
  resolveConfigPath: (env: InstallEnv) => join(env.home, ".customrt", "config.json"),
  serializeEntry: customShape,
  entryEquals: (current, expected) => deepJsonEquals(current, customShape(expected)),
});

function env() {
  return {
    vault,
    home,
    cwd: home,
    env: { VAULT_AGENT_NAME: "a", VAULT_TIMEZONE: "UTC" },
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

describe("createJsonMcpAdapter with custom entry shape", () => {
  test("apply writes the custom shape under the custom top-level key", () => {
    adapter.apply(adapter.plan(payload(), env()), payload(), env(), applyOpts());
    const path = join(home, ".customrt", "config.json");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const full = parsed.mcp["open-second-brain"];
    expect(full.type).toBe("local");
    expect(full.command).toEqual(["o2b", "mcp", "--vault", vault]);
    expect(full.environment).toEqual({ VAULT_AGENT_NAME: "a", VAULT_TIMEZONE: "UTC" });
    expect(full.enabled).toBe(true);
    expect(full.args).toBeUndefined();
  });

  test("verify reports ok for a canonical custom-shape install", () => {
    adapter.apply(adapter.plan(payload(), env()), payload(), env(), applyOpts());
    expect(adapter.verify(env()).status).toBe("ok");
    expect(adapter.detect(env()).status).toBe("installed");
  });

  test("re-apply on a canonical install is a no-op (idempotent)", () => {
    adapter.apply(adapter.plan(payload(), env()), payload(), env(), applyOpts());
    const path = join(home, ".customrt", "config.json");
    const before = readFileSync(path, "utf8");
    const second = adapter.apply(adapter.plan(payload(), env()), payload(), env(), applyOpts());
    expect(second.steps_executed).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  test("verify reports drift when the custom-shape entry is edited", () => {
    adapter.apply(adapter.plan(payload(), env()), payload(), env(), applyOpts());
    const path = join(home, ".customrt", "config.json");
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    parsed.mcp["open-second-brain"].enabled = false;
    writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n");
    const v = adapter.verify(env());
    expect(v.status).toBe("drift");
  });

  test("uninstall removes only our keys and the manifest entry", () => {
    const path = join(home, ".customrt", "config.json");
    adapter.apply(adapter.plan(payload(), env()), payload(), env(), applyOpts());
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    parsed.mcp.other = { type: "remote", url: "https://x" };
    writeFileSync(path, JSON.stringify(parsed, null, 2) + "\n");

    adapter.uninstall(env(), applyOpts());
    expect(readManifest(vault).installs["custom-shape-test"]).toBeUndefined();
    const after = JSON.parse(readFileSync(path, "utf8"));
    expect(after.mcp["open-second-brain"]).toBeUndefined();
    expect(after.mcp["open-second-brain-writer"]).toBeUndefined();
    expect(after.mcp.other).toEqual({ type: "remote", url: "https://x" });
    expect(existsSync(path)).toBe(true);
  });
});
