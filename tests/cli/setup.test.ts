/**
 * `o2b setup` - command-line level tests.
 *
 * Every run that can reach an adapter goes through a child process with
 * the sandbox's HOME, as the install verb's tests do: Bun fixes
 * `os.homedir()` when a process starts, so a HOME set by this file does not
 * move the home `buildInstallEnv` hands the adapters, and an in-process
 * run wrote `~/.cursor/mcp.json` into the developer's real home. The one
 * in-process run below replaces both adapter calls that touch a home.
 */

import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseSimpleYaml } from "../../src/core/config.ts";
import { cursorAdapter } from "../../src/core/install/adapters/cursor.ts";
import { captureStdout, cmdSetup } from "../../src/cli/setup.ts";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { runCli } from "../helpers/run-cli.ts";
import { sqliteVecLoadable } from "../helpers/sqlite-vec.ts";
import { tempDirs } from "../helpers/temp-dir.ts";

// Every case spawns a process; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const mkTemp = tempDirs();
// Outside the per-test root its snapshots compare: a child Bun keeps its
// transpiler cache under XDG_CACHE_HOME.
const cacheRoot = mkTemp("setup-cli-cache-");
const SELFTEST_AVAILABLE = sqliteVecLoadable();
const testWithSelftest = test.skipIf(!SELFTEST_AVAILABLE);

let root: string;
let home: string;
let configPath: string;
let sandboxEnv: Record<string, string>;
let baseline: string[];

beforeEach(() => {
  root = mkTemp("setup-cli-");
  home = join(root, "home");
  configPath = join(root, "xdg-config", "open-second-brain", "config.yaml");
  mkdirSync(home, { recursive: true });
  mkdirSync(join(root, "tmp"), { recursive: true });
  sandboxEnv = {
    HOME: home,
    XDG_CONFIG_HOME: join(root, "xdg-config"),
    XDG_DATA_HOME: join(root, "xdg-data"),
    XDG_CACHE_HOME: cacheRoot,
    XDG_STATE_HOME: join(root, "xdg-state"),
    CODEX_HOME: join(root, "codex"),
    GROK_HOME: join(root, "grok"),
    PI_HOME: join(root, "pi"),
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    OPEN_SECOND_BRAIN_STORE_ROOT: join(root, "store"),
    TMPDIR: join(root, "tmp"),
  };
  baseline = snapshot(root);
});

const savedEnv: Record<string, string | undefined> = {};

afterEach(() => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
    delete savedEnv[key];
  }
});

async function runSetup(
  args: string[],
  env: Record<string, string> = sandboxEnv,
): Promise<{ code: number; out: string; err: string }> {
  const result = await runCli(["setup", ...args, "--config", configPath], {
    env,
    subprocess: true,
  });
  return { code: result.returncode, out: result.stdout, err: result.stderr };
}

/** Runs setup in this process with the sandbox's variables, restored after the test. */
async function runSetupInProcess(args: string[]): Promise<number> {
  for (const [key, value] of Object.entries(sandboxEnv)) {
    if (!(key in savedEnv)) savedEnv[key] = process.env[key];
    process.env[key] = value;
  }
  return (await captureStdout(() => cmdSetup([...args, "--config", configPath]))).value;
}

function snapshot(path: string): string[] {
  if (!existsSync(path)) return [];
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const full = join(path, entry.name);
    const name = relative(root, full);
    return entry.isDirectory()
      ? [name, ...snapshot(full)]
      : [`${name}:${readFileSync(full, "utf8")}`];
  });
}

describe("o2b setup", () => {
  testWithSelftest(
    SELFTEST_AVAILABLE
      ? "sets up a fresh machine without a vault"
      : "NOT RUN: fresh no-vault setup requires sqlite-vec",
    async () => {
      const result = await runSetup([
        "--target",
        "cursor",
        "--no-vault",
        "--agent-name",
        "Setup Test",
        "--timezone",
        "UTC",
        "--apply",
        "--yes",
      ]);
      expect(result.code).toBe(0);
      expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(true);
      expect(existsSync(configPath)).toBe(true);
      expect(existsSync(join(root, "store", "shared", "store.json"))).toBe(true);
      expect(result.out).toContain("verified");
      const registration = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
      expect(registration.mcpServers["open-second-brain"].env.OPEN_SECOND_BRAIN_CONFIG).toBe(
        configPath,
      );
    },
  );

  testWithSelftest(
    SELFTEST_AVAILABLE ? "connects a configured vault" : "NOT RUN: vault setup requires sqlite-vec",
    async () => {
      const vault = join(root, "vault");
      mkdirSync(vault, { recursive: true });
      const init = await runSetup([
        "--target",
        "cursor",
        "--vault",
        vault,
        "--agent-name",
        "Setup Test",
        "--timezone",
        "UTC",
        "--apply",
        "--yes",
      ]);
      expect(init.code).toBe(0);
      expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(true);
    },
  );

  testWithSelftest(
    SELFTEST_AVAILABLE
      ? "a second run writes nothing and skips the self-test"
      : "NOT RUN: second setup run requires sqlite-vec on its first pass",
    async () => {
      const args = [
        "--target",
        "cursor",
        "--no-vault",
        "--agent-name",
        "Setup Test",
        "--timezone",
        "UTC",
        "--apply",
        "--yes",
      ];
      expect((await runSetup(args)).code).toBe(0);
      const before = snapshot(root);
      const result = await runSetup(args);
      expect(result.code).toBe(0);
      expect(snapshot(root)).toEqual(before);
      expect(result.out).toContain("already connected");
      expect(result.out).toContain("self-test skipped");
    },
  );

  test("an unconfigured plan needs no choices and writes nothing", async () => {
    const result = await runSetup(["--target", "cursor"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("--vault");
    expect(result.out).toContain("--no-vault");
    expect(result.out).toContain("--agent-name");
    expect(result.out).toContain("--timezone");
    expect(snapshot(root)).toEqual(baseline);
  });

  test.each([
    [[], "--vault or --no-vault"],
    [["--no-vault"], "--agent-name"],
    [["--no-vault", "--agent-name", "Setup Test"], "--timezone"],
  ])("a missing apply choice names %s before writing", async (choices, missing) => {
    const result = await runSetup(["--target", "cursor", ...choices, "--apply", "--yes"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain(missing);
    expect(snapshot(root)).toEqual(baseline);
  });

  test.each([[[]], [["--apply", "--yes"]]])(
    "Aider without a vault stops and asks for --vault before writing (%p)",
    async (mode) => {
      const result = await runSetup([
        "--target",
        "aider",
        "--no-vault",
        "--agent-name",
        "Setup Test",
        "--timezone",
        "UTC",
        ...mode,
      ]);
      expect(result.code).toBe(2);
      expect(result.err).toContain("pass --vault <path>");
      expect(snapshot(root)).toEqual(baseline);
    },
  );

  test("headless consent refusal writes nothing", async () => {
    const result = await runSetup([
      "--target",
      "cursor",
      "--no-vault",
      "--agent-name",
      "Setup Test",
      "--timezone",
      "UTC",
      "--apply",
    ]);
    expect(result.code).toBe(6);
    expect(result.err).toContain("--yes");
    expect(snapshot(root)).toEqual(baseline);
  });

  test("JSON usage refusal is one document with no writes", async () => {
    const result = await runSetup(["--target", "cursor", "--apply", "--yes", "--json"]);
    const report = JSON.parse(result.out);
    expect(result.code).toBe(2);
    expect(report.steps[0].outcome).toBe("failed");
    expect(report.steps[0].output).toContain("--vault or --no-vault");
    expect(snapshot(root)).toEqual(baseline);
  });

  test("a vault flag that contradicts configuration is refused without writes", async () => {
    const configuredVault = join(root, "configured-vault");
    mkdirSync(join(root, "xdg-config", "open-second-brain"), { recursive: true });
    writeFileSync(configPath, `vault: ${configuredVault}\n`);
    baseline = snapshot(root);
    const result = await runSetup([
      "--target",
      "cursor",
      "--vault",
      join(root, "other-vault"),
      "--apply",
      "--yes",
    ]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("--vault");
    expect(result.err).toContain(configuredVault);
    expect(result.err).toContain("o2b init --vault");
    expect(snapshot(root)).toEqual(baseline);
  });

  test("changed explicit identity is refused with the command that updates it", async () => {
    mkdirSync(join(root, "xdg-config", "open-second-brain"), { recursive: true });
    writeFileSync(configPath, "agent_name: Setup Test\ntimezone: UTC\n");
    baseline = snapshot(root);
    const result = await runSetup(["--target", "cursor", "--agent-name", "Different"]);
    expect(result.code).toBe(2);
    expect(result.err).toContain("o2b init --agent-name");
    expect(snapshot(root)).toEqual(baseline);
  });

  testWithSelftest("retry initializes a store after the first store creation fails", async () => {
    const blockedStoreRoot = join(root, "store-blocker");
    writeFileSync(blockedStoreRoot, "file prevents store directory creation");
    const failingEnv = { ...sandboxEnv, OPEN_SECOND_BRAIN_STORE_ROOT: blockedStoreRoot };
    const args = [
      "--target",
      "cursor",
      "--no-vault",
      "--agent-name",
      "Setup Test",
      "--timezone",
      "UTC",
      "--apply",
      "--yes",
    ];
    expect((await runSetup(args, failingEnv)).code).toBe(1);
    expect(parseSimpleYaml(readFileSync(configPath, "utf8"))).toMatchObject({
      agent_name: "Setup Test",
      timezone: "UTC",
    });
    const retryEnv = { ...sandboxEnv, OPEN_SECOND_BRAIN_STORE_ROOT: join(root, "store") };
    const retry = await runSetup(args, retryEnv);
    expect(retry.code).toBe(0);
    expect(existsSync(join(root, "store", "shared", "store.json"))).toBe(true);
  });

  testWithSelftest("relative --vault registers the resolved command in the report", async () => {
    const result = await runCli(
      [
        "setup",
        "--target",
        "cursor",
        "--vault",
        "./notes",
        "--agent-name",
        "Setup Test",
        "--timezone",
        "UTC",
        "--apply",
        "--yes",
        "--json",
        "--config",
        configPath,
      ],
      { env: sandboxEnv, cwd: root, subprocess: true },
    );
    expect(result.returncode).toBe(0);
    const report = JSON.parse(result.stdout);
    const expectedVault = resolve(root, "notes").replace(/\\/g, "/");
    const vaultIndex = report.registeredCommand.args.indexOf("--vault");
    expect(report.registeredCommand.args[vaultIndex + 1]).toBe(expectedVault);
    const registered = JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8"));
    expect(registered.mcpServers["open-second-brain"].args).toEqual(report.registeredCommand.args);
  });

  test("plugin and print hosts end with code 7 without host files", async () => {
    mkdirSync(join(root, "xdg-config", "open-second-brain"), { recursive: true });
    writeFileSync(configPath, "agent_name: Setup Test\ntimezone: UTC\n");
    const plugin = await runSetup(["--target", "hermes", "--apply", "--yes"]);
    expect(plugin.code).toBe(7);
    expect(plugin.out).toContain("install/hermes.md");
    expect(existsSync(join(home, ".hermes"))).toBe(false);
    const generic = await runSetup(["--target", "generic", "--apply", "--yes"]);
    expect(generic.code).toBe(7);
    expect(generic.out).toContain("mcp");
    expect(existsSync(join(home, ".hermes"))).toBe(false);
  });

  testWithSelftest(
    SELFTEST_AVAILABLE
      ? "a host not installed before setup is applied"
      : "NOT RUN: adapter setup requires sqlite-vec self-test",
    async () => {
      const result = await runSetup([
        "--target",
        "cursor",
        "--no-vault",
        "--agent-name",
        "Setup Test",
        "--timezone",
        "UTC",
        "--apply",
        "--yes",
      ]);
      expect(result.code).toBe(0);
      expect(JSON.parse(readFileSync(join(home, ".cursor/mcp.json"), "utf8"))).toHaveProperty(
        "mcpServers.open-second-brain",
      );
    },
  );

  testWithSelftest(
    SELFTEST_AVAILABLE
      ? "a failed post-apply verification keeps its exit code"
      : "NOT RUN: adapter apply verification requires sqlite-vec self-test",
    async () => {
      // A failed verification after a clean apply cannot be produced by a
      // real child (Cursor has no host probe), so this run stays in the
      // process. The process's home is the developer's real one, so every
      // adapter call that reads or writes a home is handed the sandbox's.
      const original = {
        plan: cursorAdapter.plan,
        apply: cursorAdapter.apply,
        verify: cursorAdapter.verify,
      };
      let calls = 0;
      cursorAdapter.plan = (payload, env) =>
        original.plan.call(cursorAdapter, payload, { ...env, home });
      cursorAdapter.apply = (plan, payload, env, opts) =>
        original.apply.call(cursorAdapter, plan, payload, { ...env, home }, opts);
      cursorAdapter.verify = (env) => {
        const actual = original.verify.call(cursorAdapter, { ...env, home });
        calls += 1;
        return { ...actual, status: calls === 1 ? "not-installed" : "mcp-unreachable" };
      };
      try {
        const code = await runSetupInProcess([
          "--target",
          "cursor",
          "--no-vault",
          "--agent-name",
          "Setup Test",
          "--timezone",
          "UTC",
          "--apply",
          "--yes",
        ]);
        expect(code).toBe(5);
        expect(calls).toBeGreaterThanOrEqual(2);
        expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(true);
      } finally {
        Object.assign(cursorAdapter, original);
      }
    },
  );

  testWithSelftest(
    SELFTEST_AVAILABLE
      ? "JSON output is one document with captured step output"
      : "NOT RUN: setup JSON apply requires sqlite-vec self-test",
    async () => {
      const result = await runSetup([
        "--target",
        "cursor",
        "--no-vault",
        "--agent-name",
        "Setup Test",
        "--timezone",
        "UTC",
        "--apply",
        "--yes",
        "--json",
      ]);
      const report = JSON.parse(result.out);
      expect(result.code).toBe(0);
      expect(Array.isArray(report.steps)).toBe(true);
      expect(report.steps.some((step: { output?: string }) => Boolean(step.output))).toBe(true);
    },
  );

  test("stdout is restored after a captured step throws", async () => {
    const original = process.stdout.write;
    await expect(
      captureStdout(() => {
        process.stdout.write("inside\n");
        throw new Error("step failed");
      }),
    ).rejects.toThrow("step failed");
    expect(process.stdout.write).toBe(original);
  });
});
