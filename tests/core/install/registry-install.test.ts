import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import { cursorAdapter } from "../../../src/core/install/adapters/cursor.ts";
import { createRegistry } from "../../../src/core/install/registry.ts";
import { readManifest } from "../../../src/core/install/manifest.ts";
import { buildPayload } from "../../../src/core/install/payload.ts";
import { runUpdate } from "../../../src/core/install/update.ts";
import type { InstallEnv } from "../../../src/core/install/types.ts";
import { tempDirs } from "../../helpers/temp-dir.ts";

const root = tempDirs()("registry-install-test-");
const vault = join(root, "vault");
const home = join(root, "home");
const packageRoot = join(root, "prefix", "node_modules", "open-second-brain");

function env(): InstallEnv {
  return {
    vault,
    home,
    cwd: root,
    env: {},
    now: new Date("2026-11-22T12:00:00.000Z"),
    origin: { kind: "registry", root: packageRoot, version: "2.0.0" },
  };
}

function streams() {
  return {
    stdout: new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
    stderr: new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    }),
  };
}

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("registry install command lifecycle", () => {
  test("apply writes an absolute Bun and launcher pair, then verifies without drift", () => {
    mkdirSync(vault, { recursive: true });
    mkdirSync(home, { recursive: true });
    const runEnv = env();
    const payload = buildPayload({
      vault,
      agent_name: null,
      timezone: null,
      origin: runEnv.origin,
    });
    const plan = cursorAdapter.plan(payload, runEnv);
    cursorAdapter.apply(plan, payload, runEnv, { dryRun: false, force: false, ...streams() });
    const written = JSON.parse(readFileSync(join(home, ".cursor/mcp.json"), "utf8"));
    expect(written.mcpServers["open-second-brain"].command).toBe(process.execPath);
    expect(written.mcpServers["open-second-brain"].args.slice(0, 2)).toEqual([
      "run",
      join(packageRoot, "bin/o2b.js"),
    ]);
    expect(cursorAdapter.verify(runEnv).status).toBe("ok");
    expect(readManifest(vault).installs.cursor?.origin).toEqual(runEnv.origin);
  });

  test("update reports a fresh registry apply as up to date without rewriting it", () => {
    mkdirSync(vault, { recursive: true });
    mkdirSync(home, { recursive: true });
    const runEnv = env();
    const payload = buildPayload({
      vault,
      agent_name: null,
      timezone: null,
      origin: runEnv.origin,
    });
    const plan = cursorAdapter.plan(payload, runEnv);
    cursorAdapter.apply(plan, payload, runEnv, { dryRun: false, force: false, ...streams() });
    const config = join(home, ".cursor/mcp.json");
    const before = readFileSync(config, "utf8");
    const registry = createRegistry();
    registry.register(cursorAdapter);
    const result = runUpdate(registry, runEnv, { dryRun: false, force: false, target: "cursor" });
    expect(result.targets[0]?.status).toBe("up-to-date");
    expect(readFileSync(config, "utf8")).toBe(before);
  });

  test("store-only apply writes no vault argument and verifies without drift", () => {
    mkdirSync(home, { recursive: true });
    const runEnv = { ...env(), vault: "" };
    const payload = buildPayload({
      vault: "",
      agent_name: null,
      timezone: null,
      origin: runEnv.origin,
    });
    expect(payload.full.args).toEqual(["run", join(packageRoot, "bin/o2b.js"), "mcp"]);
    const plan = cursorAdapter.plan(payload, runEnv);
    cursorAdapter.apply(plan, payload, runEnv, { dryRun: false, force: false, ...streams() });
    const written = JSON.parse(readFileSync(join(home, ".cursor/mcp.json"), "utf8"));
    expect(written.mcpServers["open-second-brain"].args).not.toContain("--vault");
    expect(cursorAdapter.verify(runEnv).status).toBe("ok");
  });
});
