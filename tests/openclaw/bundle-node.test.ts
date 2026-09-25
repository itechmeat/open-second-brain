/**
 * The OpenClaw bundle runs under Node, not Bun.
 *
 * `openclaw/index.js` is built with `--target=node`, and OpenClaw loads it
 * in a Node process where the `Bun` global does not exist. The bundle
 * therefore cannot call a Bun-only API on any path its tools reach, and a
 * Bun test process cannot notice when it does: `Bun` is defined there. So
 * this test loads the committed bundle in a real `node` and drives a tool.
 *
 * The path driven is the contended first use of the installation secret:
 * `second_brain_status` renders `vault_path` through the opaque store
 * reference, which generates the secret under a directory lock and waits
 * between attempts while another process holds it. That wait is the one
 * place the bundle used to call `Bun.sleepSync`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const BUNDLE = join(ROOT, "openclaw", "index.js");
const NODE = Bun.which("node");

// The SDK is an external of the bundle. Its entry helper is the identity
// on the plugin definition, which is all the bundle needs from it here.
const SDK_STUB = "export function definePluginEntry(entry) { return entry; }\n";

const DRIVER = `
import plugin from "./index.js";
const tools = new Map();
plugin.register({
  pluginConfig: { vault: process.env.DRIVER_VAULT },
  on() {},
  registerTool(tool) { tools.set(tool.name, tool); },
});
const out = await tools.get("second_brain_status").execute();
process.stdout.write(out.content[0].text);
`;

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "osb-openclaw-node-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("openclaw bundle under node", () => {
  test("a node binary is available (CI runners ship one)", () => {
    // A missing node would turn the test below into a silent skip, which
    // reads as a pass on exactly the runtime it exists to cover.
    if (process.env["CI"]) expect(NODE).not.toBeNull();
  });

  test.skipIf(NODE === null)(
    "status generates the store reference while the config lock is held",
    () => {
      const app = join(root, "app");
      mkdirSync(join(app, "node_modules", "openclaw", "plugin-sdk"), { recursive: true });
      cpSync(BUNDLE, join(app, "index.js"));
      writeFileSync(join(app, "package.json"), JSON.stringify({ type: "module" }));
      writeFileSync(
        join(app, "node_modules", "openclaw", "package.json"),
        JSON.stringify({
          name: "openclaw",
          type: "module",
          exports: { "./plugin-sdk/plugin-entry": "./plugin-sdk/plugin-entry.js" },
        }),
      );
      writeFileSync(
        join(app, "node_modules", "openclaw", "plugin-sdk", "plugin-entry.js"),
        SDK_STUB,
      );
      writeFileSync(join(app, "driver.mjs"), DRIVER);

      const configDir = join(root, "config");
      mkdirSync(configDir);
      const configPath = join(configDir, "config.yaml");
      // A fresh lock directory is a live holder to proper-lockfile, so every
      // attempt reports ELOCKED and the bundle takes the wait between them.
      mkdirSync(`${configDir}.lock`);
      const vault = join(root, "vault");
      mkdirSync(vault);

      const env: Record<string, string> = {
        PATH: process.env["PATH"] ?? "",
        HOME: root,
        USERPROFILE: root,
        OPEN_SECOND_BRAIN_CONFIG: configPath,
        DRIVER_VAULT: vault,
      };
      if (process.env["SYSTEMROOT"]) env["SYSTEMROOT"] = process.env["SYSTEMROOT"];
      const proc = Bun.spawnSync({
        cmd: [NODE as string, "driver.mjs"],
        cwd: app,
        env,
        stdout: "pipe",
        stderr: "pipe",
      });
      const stderr = proc.stderr.toString();
      expect(stderr).not.toContain("Bun is not defined");
      expect(proc.exitCode).toBe(0);
      const status = JSON.parse(proc.stdout.toString()) as { vault_path: string };
      expect(status.vault_path).toMatch(/^vault:\/\/[0-9a-f]{32}$/);
      // The secret it was keyed by was persisted after the lock wait gave up.
      expect(readFileSync(configPath, "utf8")).toMatch(/installation_secret: "?[0-9a-f]{32}"?/);
    },
    30_000,
  );
});
