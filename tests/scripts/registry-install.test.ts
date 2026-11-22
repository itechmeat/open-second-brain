import { afterAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { sqliteVecLoadable } from "../helpers/sqlite-vec.ts";
import {
  cleanupPacked,
  installPacked,
  packCheckout,
  probeRegistry,
  runPackedCommand,
  type PackedInstall,
  type PackedTarball,
} from "../helpers/packed-install.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

function expectPackedCommandSuccess(
  result: ReturnType<typeof runPackedCommand>,
  install: PackedInstall,
  command: string,
): void {
  const stderr = new TextDecoder().decode(result.stderr).trim();
  expect(result.exitCode, `Started ${install.commands[command]}\nstderr:\n${stderr}`).toBe(0);
}

const SELFTEST_AVAILABLE = sqliteVecLoadable();
const testWithSelftest = test.skipIf(!SELFTEST_AVAILABLE);

const roots: string[] = [];
const tarball: PackedTarball | null = (() => {
  const packed = packCheckout();
  roots.push(packed.root);
  return packed;
})();
let bunInstall: PackedInstall | null = null;
let npmInstall: PackedInstall | null = null;
let spacedInstall: PackedInstall | null = null;
let registryFailure: string | null = null;
try {
  bunInstall = installPacked(tarball, "bun");
  roots.push(bunInstall.root);
  npmInstall = installPacked(tarball, "npm");
  roots.push(npmInstall.root);
  spacedInstall = installPacked(tarball, "bun", " space café ");
  roots.push(spacedInstall.root);
} catch (error) {
  const installError = error instanceof Error ? error.message : String(error);
  const registry = probeRegistry();
  if (registry.reachable)
    throw new Error(`registry is reachable, but packed install failed: ${installError}`, {
      cause: error,
    });
  registryFailure = `${registry.reason}; install error: ${installError}`;
  for (const root of roots.splice(0)) cleanupPacked(root);
  if (process.env["O2B_REQUIRE_REGISTRY_INSTALL"] === "1") {
    throw new Error(`registry install required in CI: ${registryFailure}`, { cause: error });
  }
}

afterAll(() => {
  for (const root of roots.splice(0)) cleanupPacked(root);
});

if (registryFailure) {
  test.skip(`packed registry install skipped because registry access failed: ${registryFailure}`, () => {});
} else {
  const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version;
  describe("package installed from its tarball", () => {
    test("Bun install runs every command and initializes a store under scratch", () => {
      const install = bunInstall!;
      const versionResult = runPackedCommand(install, "o2b", ["version"]);
      expectPackedCommandSuccess(versionResult, install, "o2b");
      expect(new TextDecoder().decode(versionResult.stdout)).toContain(version);
      if (process.platform !== "win32") {
        const cloneStarted = performance.now();
        const cloneVersion = Bun.spawnSync([resolve("scripts/o2b"), "version"], {
          cwd: install.cwd,
          env: install.env,
          stdout: "pipe",
          stderr: "pipe",
        });
        const cloneDurationMs = performance.now() - cloneStarted;
        expect(cloneVersion.exitCode).toBe(0);
        expect(new TextDecoder().decode(cloneVersion.stdout)).toContain(version);
        console.log(
          `o2b version startup ms: registry=${versionResult.durationMs.toFixed(2)} clone=${cloneDurationMs.toFixed(2)}`,
        );
      }

      const init = runPackedCommand(install, "o2b", ["init", "--agent-name", "Registry Test"]);
      expectPackedCommandSuccess(init, install, "o2b");
      expect(readFileSync(join(install.storeRoot, "shared", "store.json"), "utf8")).toContain(
        "store_id",
      );
      expect(install.storeRoot.startsWith(install.root)).toBe(true);

      const hook = runPackedCommand(
        install,
        "o2b-hook",
        ["active-inject"],
        new TextEncoder().encode(
          '{"hook_event_name":"SessionStart","session_id":"registry-test"}\n',
        ),
      );
      expectPackedCommandSuccess(hook, install, "o2b-hook");

      const initialize = new TextEncoder().encode(
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"registry-test","version":"1"}}}\n',
      );
      const mcp = runPackedCommand(install, "o2b-mcp", [], initialize);
      expectPackedCommandSuccess(mcp, install, "o2b-mcp");
      expect(
        new TextDecoder().decode(mcp.stdout).startsWith('{"jsonrpc":"2.0","id":1,"result"'),
      ).toBe(true);
    });

    test("npm generated shims run from the same packed tarball", () => {
      const result = runPackedCommand(npmInstall!, "o2b", ["version"]);
      expectPackedCommandSuccess(result, npmInstall!, "o2b");
      expect(new TextDecoder().decode(result.stdout)).toContain(version);
    });

    test("bootstrap from a registry package writes its absolute Bun launcher", () => {
      const install = bunInstall!;
      const vault = join(install.root, "bootstrap-vault");
      const init = runPackedCommand(install, "o2b", [
        "init",
        "--vault",
        vault,
        "--agent-name",
        "Registry Bootstrap",
        "--timezone",
        "UTC",
      ]);
      expect(init.exitCode).toBe(0);
      const bootstrap = runPackedCommand(install, "o2b", [
        "bootstrap",
        "--vault",
        vault,
        "--target",
        "codex",
        "--agent",
        "registry-bootstrap",
        "--token",
      ]);
      expect(bootstrap.exitCode).toBe(0);
      const codexConfig = readFileSync(join(install.env.CODEX_HOME!, "config.toml"), "utf8");
      const codex = Bun.TOML.parse(codexConfig) as {
        mcp_servers: Record<string, { command: string; args: string[] }>;
      };
      const registered = codex.mcp_servers["open-second-brain"]!;
      expect(registered.command).toBe(process.execPath);
      expect(registered.args.slice(0, 2)).toEqual([
        "run",
        join(install.installDir, "bin", "o2b.js"),
      ]);
    });

    testWithSelftest(
      SELFTEST_AVAILABLE
        ? "setup from a registry package registers its launcher in the scratch host home"
        : "NOT RUN: registry setup acceptance requires sqlite-vec self-test",
      () => {
        const install = bunInstall!;
        const vault = join(install.root, "bootstrap-vault");
        const setup = runPackedCommand(install, "o2b", [
          "setup",
          "--target",
          "cursor",
          "--vault",
          vault,
          "--agent-name",
          "Registry Bootstrap",
          "--timezone",
          "UTC",
          "--apply",
          "--yes",
        ]);
        if (setup.exitCode !== 0) {
          throw new Error(
            `setup exited ${setup.exitCode}: ${new TextDecoder().decode(setup.stderr).trim()}\n${new TextDecoder().decode(setup.stdout).trim()}`,
          );
        }
        const cursorConfig = readFileSync(join(install.home, ".cursor/mcp.json"), "utf8");
        const parsed = JSON.parse(cursorConfig) as {
          mcpServers: Record<string, { command: string; args: string[] }>;
        };
        const registered = parsed.mcpServers["open-second-brain"]!;
        expect(registered.command).toBe(process.execPath);
        expect(registered.args.slice(0, 2)).toEqual([
          "run",
          join(install.installDir, "bin/o2b.js"),
        ]);
        const check = runPackedCommand(install, "o2b", [
          "install",
          "--target",
          "cursor",
          "--check",
        ]);
        if (check.exitCode !== 0) {
          throw new Error(
            `install --check exited ${check.exitCode}: ${new TextDecoder().decode(check.stderr).trim()}\n${new TextDecoder().decode(check.stdout).trim()}\n${cursorConfig}`,
          );
        }
      },
    );

    test("commands run from an install and home path with spaces and non-ASCII characters", () => {
      expect(spacedInstall!.root).toMatch(/space café/);
      const versionResult = runPackedCommand(spacedInstall!, "o2b", ["version"]);
      expectPackedCommandSuccess(versionResult, spacedInstall!, "o2b");
      expect(new TextDecoder().decode(versionResult.stdout)).toContain(version);
      const hook = runPackedCommand(
        spacedInstall!,
        "o2b-hook",
        ["active-inject"],
        new TextEncoder().encode(
          '{"hook_event_name":"SessionStart","session_id":"registry-space"}\n',
        ),
      );
      expectPackedCommandSuccess(hook, spacedInstall!, "o2b-hook");
    });
  });
}
