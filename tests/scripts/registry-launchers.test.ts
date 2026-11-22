import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { makeLauncherRoot, removeLauncherRoot } from "../helpers/registry-launcher-fixture.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) removeLauncherRoot(root);
});
function makeRoot(requiredBun?: string): string {
  const value = makeLauncherRoot(requiredBun);
  roots.push(value);
  return value;
}
function run(rootPath: string, launcher: string, args: string[], env: Record<string, string> = {}) {
  const childEnv: Record<string, string> = { ...process.env, ...env } as Record<string, string>;
  if (childEnv["REGISTRY_CLEAR_DYLD"] === "1") {
    delete childEnv["REGISTRY_CLEAR_DYLD"];
    delete childEnv["DYLD_LIBRARY_PATH"];
  }
  return Bun.spawnSync([process.execPath, join(rootPath, "bin", launcher), ...args], {
    cwd: rootPath,
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
}

async function stopProcesses(proc: ReturnType<typeof Bun.spawn>, pidFile: string): Promise<void> {
  if (existsSync(pidFile)) {
    const pid = Number(readFileSync(pidFile, "utf8"));
    if (Number.isInteger(pid) && pid > 0) {
      try {
        process.kill(pid, "SIGTERM");
      } catch {
        // The child may have exited already.
      }
    }
  }
  try {
    proc.kill("SIGTERM");
  } catch {
    // The launcher may have exited already.
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    proc.exited,
    new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // The launcher may have exited already.
        }
        resolve();
      }, 1_000);
    }),
  ]);
  if (timer) clearTimeout(timer);
}

describe("registry launchers", () => {
  test("preserves arguments and inserts command prefixes", () => {
    const packageRoot = makeRoot();
    const argsFile = join(packageRoot, "args.json");
    const args = ["space value", `quote'"`, "$HOME; *", "жёлтый"];
    for (const [launcher, input, expected] of [
      ["o2b.js", args, args],
      ["o2b-mcp.js", args, ["mcp", ...args]],
    ] as const) {
      const result = run(packageRoot, launcher, input, { REGISTRY_ARGS_FILE: argsFile });
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(readFileSync(argsFile, "utf8"))).toEqual(expected);
    }
  });

  test("matches the checkout precheck minimum", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { engines: { bun: string } };
    const precheck = readFileSync("scripts/_bun-precheck.sh", "utf8");
    const required = pkg.engines.bun.match(/(\d+\.\d+\.\d+)/)?.[1];
    expect(required).toBeDefined();
    expect(precheck).toContain(`MIN_BUN_MAJOR=${required!.split(".")[0]}`);
    expect(precheck).toContain(`MIN_BUN_MINOR=${required!.split(".")[1]}`);
    expect(precheck).toContain(`MIN_BUN_PATCH=${required!.split(".")[2]}`);
  });

  test.skipIf(process.platform === "win32")(
    "applies the macOS SQLite environment rule only to o2b and o2b-mcp",
    () => {
      const packageRoot = makeRoot();
      const first = join(packageRoot, "sqlite-first");
      const second = join(packageRoot, "sqlite-second");
      writeFileSync(first, "not a directory");
      mkdirSync(second);
      for (const launcher of ["o2b.js", "o2b-mcp.js"]) {
        const dyldFile = join(packageRoot, `${launcher}.dyld.json`);
        const result = run(packageRoot, launcher, [], {
          REGISTRY_DYLD_FILE: dyldFile,
          REGISTRY_CLEAR_DYLD: "1",
          O2B_MACOS_FORCE_PLATFORM: "Darwin",
          O2B_MACOS_SQLITE_PREFIXES_OVERRIDE: `${first}:${second}`,
        });
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(readFileSync(dyldFile, "utf8"))).toBe(second);
      }
      for (const [launcher, args] of [["o2b-hook.js", ["session-start"]]] as const) {
        const dyldFile = join(packageRoot, `${launcher}.dyld.json`);
        const result = run(packageRoot, launcher, [...args], {
          REGISTRY_DYLD_FILE: dyldFile,
          REGISTRY_CLEAR_DYLD: "1",
          O2B_MACOS_FORCE_PLATFORM: "Darwin",
          O2B_MACOS_SQLITE_PREFIXES_OVERRIDE: first,
        });
        expect(result.exitCode).toBe(0);
        expect(JSON.parse(readFileSync(dyldFile, "utf8"))).toBe(null);
      }
    },
  );

  test("propagates a child's exit code", () => {
    const packageRoot = makeRoot();
    const result = run(packageRoot, "o2b.js", [], { REGISTRY_EXIT_CODE: "7" });
    expect(result.exitCode).toBe(7);
  });

  test("refuses old Bun for program commands and makes hook refusal non-blocking", () => {
    const packageRoot = makeRoot("999.0.0");
    for (const launcher of ["o2b.js", "o2b-mcp.js"]) {
      const result = run(packageRoot, launcher, []);
      expect(result.exitCode).toBe(1);
      expect(new TextDecoder().decode(result.stderr)).toContain(`requires Bun 999.0.0`);
    }
    const hook = run(packageRoot, "o2b-hook.js", ["session-start"]);
    expect(hook.exitCode).toBe(0);
    expect(new TextDecoder().decode(hook.stderr)).toContain(`requires Bun 999.0.0`);
  });

  test("hook errors never block and write diagnostics only to stderr", () => {
    const packageRoot = makeRoot();
    for (const name of ["", "missing", "exit-two"]) {
      const result = run(packageRoot, "o2b-hook.js", name ? [name] : []);
      expect(result.exitCode).toBe(0);
      expect(new TextDecoder().decode(result.stdout)).toBe("");
      expect(new TextDecoder().decode(result.stderr)).toMatch(/^Open Second Brain hook .+\n$/);
    }
  });

  test("forwards SIGTERM and exits after its child", async () => {
    if (process.platform === "win32") return;
    const packageRoot = makeRoot();
    const readyFile = join(packageRoot, "child-ready");
    const signalFile = join(packageRoot, "child-signal");
    const pidFile = join(packageRoot, "child-pid");
    const proc = Bun.spawn([process.execPath, join(packageRoot, "bin", "o2b.js")], {
      cwd: packageRoot,
      env: {
        ...process.env,
        REGISTRY_HANG: "1",
        REGISTRY_READY_FILE: readyFile,
        REGISTRY_SIGNAL_FILE: signalFile,
        REGISTRY_PID_FILE: pidFile,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          clearInterval(poll);
          reject(new Error("fixture child did not become ready"));
        }, 1_000);
        const poll = setInterval(() => {
          if (existsSync(readyFile)) {
            clearTimeout(deadline);
            clearInterval(poll);
            resolve();
          }
        }, 10);
      });
      expect(existsSync(readyFile)).toBe(true);
      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(143);
      expect(readFileSync(signalFile, "utf8")).toBe("SIGTERM");
    } finally {
      await stopProcesses(proc, pidFile);
    }
  });

  test("a signaled hook remains non-blocking", async () => {
    if (process.platform === "win32") return;
    const packageRoot = makeRoot();
    const readyFile = join(packageRoot, "hook-ready");
    const signalFile = join(packageRoot, "hook-signal");
    const pidFile = join(packageRoot, "hook-pid");
    const proc = Bun.spawn(
      [process.execPath, join(packageRoot, "bin", "o2b-hook.js"), "session-start"],
      {
        cwd: packageRoot,
        env: {
          ...process.env,
          REGISTRY_HANG: "1",
          REGISTRY_READY_FILE: readyFile,
          REGISTRY_SIGNAL_FILE: signalFile,
          REGISTRY_PID_FILE: pidFile,
        },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    try {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          clearInterval(poll);
          reject(new Error("fixture hook did not become ready"));
        }, 1_000);
        const poll = setInterval(() => {
          if (existsSync(readyFile)) {
            clearTimeout(deadline);
            clearInterval(poll);
            resolve();
          }
        }, 10);
      });
      proc.kill("SIGTERM");
      expect(await proc.exited).toBe(0);
      expect(readFileSync(signalFile, "utf8")).toBe("SIGTERM");
    } finally {
      await stopProcesses(proc, pidFile);
    }
  });

  test("checkout launchers run version, hook, and MCP protocol", async () => {
    const version = Bun.spawnSync([process.execPath, "bin/o2b.js", "version"], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(version.exitCode).toBe(0);
    expect(new TextDecoder().decode(version.stdout)).toContain(
      JSON.parse(readFileSync("package.json", "utf8")).version,
    );
    const hookRoot = mkdtempSync(join(tmpdir(), "o2b-registry-hook-"));
    roots.push(hookRoot);
    const hook = Bun.spawnSync([process.execPath, "bin/o2b-hook.js", "active-inject"], {
      cwd: process.cwd(),
      stdin: new TextEncoder().encode(
        '{"hook_event_name":"SessionStart","session_id":"registry-launcher-test"}\n',
      ),
      env: { ...process.env, OPEN_SECOND_BRAIN_CONFIG_DIR: join(hookRoot, "config") },
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(hook.exitCode).toBe(0);
    const mcpRoot = mkdtempSync(join(tmpdir(), "o2b-registry-mcp-"));
    roots.push(mcpRoot);
    const mcpConfig = join(mcpRoot, "config");
    const mcp = Bun.spawn([process.execPath, "bin/o2b-mcp.js"], {
      stdin: new TextEncoder().encode(
        '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1"}}}\n',
      ),
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, OPEN_SECOND_BRAIN_CONFIG_DIR: mcpConfig },
    });
    const output = await new Response(mcp.stdout).text();
    expect(await mcp.exited).toBe(0);
    expect(output.startsWith('{"jsonrpc":"2.0","id":1,"result"')).toBe(true);
  });

  test("declares package command paths", () => {
    const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { bin: Record<string, string> };
    expect(pkg.bin["o2b"]).toBe("./bin/o2b.js");
    expect(pkg.bin["o2b-mcp"]).toBe("./bin/o2b-mcp.js");
    expect(pkg.bin["o2b-hook"]).toBe("./bin/o2b-hook.js");
    expect(existsSync(join("bin", "_launch.js"))).toBe(true);
  });
});
