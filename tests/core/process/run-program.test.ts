/**
 * Starting, awaiting and ending a program (change `dream-launched-agent`,
 * design D4, task 1.3). Small scripts in a temp directory stand in for
 * the program; no shell is involved.
 */
import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  findProgram,
  programInvocation,
  runProgram,
  treeKillInvocation,
} from "../../../src/core/process/run-program.ts";
import { homeEnv } from "../../helpers/platform.ts";
import { tempDirs } from "../../helpers/temp-dir.ts";

const mkTemp = tempDirs();
const BUN = process.execPath;

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  if (process.platform !== "linux") return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return !stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
  } catch {
    return false;
  }
}

function childEnv(dir: string): Record<string, string | undefined> {
  return {
    ...process.env,
    ...homeEnv(join(dir, "home")),
    OPEN_SECOND_BRAIN_CONFIG: join(dir, "config.yaml"),
    OPEN_SECOND_BRAIN_STORE_ROOT: join(dir, "store"),
    OPEN_SECOND_BRAIN_DREAM_AGENT_COMMAND: undefined,
    OPEN_SECOND_BRAIN_DREAM_AGENT_FALLBACKS: undefined,
    VAULT_DIR: join(dir, "vault"),
  };
}

describe("runProgram", () => {
  test("a program that exits: its code, its output in the log", async () => {
    const dir = mkTemp("o2b-run-program-");
    const s = script(dir, "exit.js", `console.log("hello"); process.exit(3);`);
    const log = join(dir, "log");
    const result = await runProgram({
      program: BUN,
      args: [s],
      env: childEnv(dir),
      deadline: Date.now() + 20_000,
      logPath: log,
    });
    expect(result).toEqual({ status: "exited", code: 3, signal: null });
    expect(readFileSync(log, "utf8")).toContain("hello");
  });

  test("Windows batch spawn is verbatim and tree cleanup runs after normal exit", async () => {
    const dir = mkTemp("o2b-run-program-win-");
    const batch = script(dir, "agent launcher.cmd", "@echo off\n");
    const child = Object.assign(new EventEmitter(), { pid: 4312 }) as unknown as ChildProcess;
    let captured: { command: string; args: string[]; options: Record<string, unknown> } | undefined;
    const treeKills: Array<{ command: string; args: string[] }> = [];
    const result = await runProgram(
      {
        program: batch,
        args: ["two words"],
        env: { ...childEnv(dir), COMSPEC: "cmd.exe" },
        deadline: Date.now() + 20_000,
        platform: "win32",
      },
      {
        spawn: ((command: string, args: string[], options: Record<string, unknown>) => {
          captured = { command, args, options };
          queueMicrotask(() => child.emit("exit", 0, null));
          return child;
        }) as never,
        spawnSync: ((command: string, args: string[]) => {
          treeKills.push({ command, args });
          return { pid: 1, output: [], stdout: null, stderr: null, status: 128, signal: null };
        }) as never,
      },
    );
    expect(result).toEqual({ status: "exited", code: 0, signal: null });
    expect(captured).toMatchObject({
      command: "cmd.exe",
      args: ["/d", "/s", "/c", `""${batch}" "two words""`],
      options: { windowsVerbatimArguments: true, detached: false },
    });
    expect(treeKills).toEqual([{ command: "taskkill", args: ["/T", "/F", "/PID", "4312"] }]);
  });

  test("Windows executable spawn leaves argument escaping at Node defaults", async () => {
    const dir = mkTemp("o2b-run-program-exe-");
    const executable = script(dir, "agent.exe", "");
    const child = Object.assign(new EventEmitter(), { pid: 4313 }) as unknown as ChildProcess;
    let optionsSeen: Record<string, unknown> | undefined;
    await runProgram(
      {
        program: executable,
        args: ["two words"],
        env: childEnv(dir),
        deadline: Date.now() + 20_000,
        platform: "win32",
      },
      {
        spawn: ((_command: string, _args: string[], options: Record<string, unknown>) => {
          optionsSeen = options;
          queueMicrotask(() => child.emit("exit", 0, null));
          return child;
        }) as never,
        spawnSync: (() => ({
          pid: 1,
          output: [],
          stdout: null,
          stderr: null,
          status: 0,
          signal: null,
        })) as never,
      },
    );
    expect(optionsSeen).toMatchObject({ detached: false });
    expect(optionsSeen).not.toHaveProperty("windowsVerbatimArguments");
  });

  test("arguments with spaces, quotes and non-ASCII are passed intact, with no shell", async () => {
    const dir = mkTemp("o2b-run-program-");
    const out = join(dir, "args.json");
    const s = script(
      dir,
      "args.js",
      `require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));`,
    );
    const args = ["two words", `"quoted" 'single'`, "Привет мир", "$HOME", "a;b|c", "*"];
    const result = await runProgram({
      program: BUN,
      args: [s, ...args],
      env: childEnv(dir),
      deadline: Date.now() + 20_000,
    });
    expect(result.status).toBe("exited");
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(args);
  });

  test("a program past its deadline is ended", async () => {
    const dir = mkTemp("o2b-run-program-");
    const s = script(dir, "hang.js", `setInterval(() => {}, 1000);`);
    const started = Date.now();
    const result = await runProgram({
      program: BUN,
      args: [s],
      env: childEnv(dir),
      deadline: Date.now() + 500,
    });
    expect(result).toEqual({ status: "timed-out" });
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  test.skipIf(process.platform === "win32")(
    "a program that ignores the termination signal is killed",
    async () => {
      const dir = mkTemp("o2b-run-program-");
      const s = script(
        dir,
        "stubborn.js",
        `process.on("SIGTERM", () => {}); setInterval(() => {}, 1000);`,
      );
      const started = Date.now();
      const result = await runProgram({
        program: BUN,
        args: [s],
        env: childEnv(dir),
        deadline: Date.now() + 300,
        killGraceMs: 500,
      });
      expect(result).toEqual({ status: "timed-out" });
      expect(Date.now() - started).toBeLessThan(8_000);
    },
  );

  test.skipIf(process.platform === "win32")("a child of the program is ended with it", async () => {
    const dir = mkTemp("o2b-run-program-");
    const pidFile = join(dir, "child.pid");
    const child = script(dir, "child.js", `setInterval(() => {}, 1000);`);
    const s = script(
      dir,
      "parent.js",
      `const c = require("node:child_process").spawn(${JSON.stringify(BUN)}, [${JSON.stringify(child)}], { stdio: "ignore" });
       require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
       setInterval(() => {}, 1000);`,
    );
    const result = await runProgram({
      program: BUN,
      args: [s],
      env: childEnv(dir),
      deadline: Date.now() + 1_500,
      killGraceMs: 500,
    });
    expect(result.status).toBe("timed-out");
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    const until = Date.now() + 5_000;
    while (alive(pid) && Date.now() < until) await Bun.sleep(100);
    expect(alive(pid)).toBe(false);
  });

  test("a program that does not exist is not started", async () => {
    const result = await runProgram({
      program: join(mkTemp("o2b-run-program-"), "missing"),
      args: [],
      env: process.env,
      deadline: Date.now() + 1_000,
    });
    expect(result.status).toBe("not-started");
  });
});

describe("findProgram", () => {
  test("finds a program on PATH, refuses a relative path", () => {
    const dir = mkTemp("o2b-find-program-");
    const name = process.platform === "win32" ? "tool.cmd" : "tool";
    script(dir, name, "x");
    // Windows file names are case-insensitive; the extension comes back as PATHEXT spells it.
    expect(findProgram("tool", { PATH: dir, PATHEXT: ".CMD" })?.toLowerCase()).toBe(
      join(dir, name).toLowerCase(),
    );
    expect(findProgram("absent-tool", { PATH: dir })).toBeNull();
    expect(findProgram("./tool", { PATH: dir })).toBeNull();
  });
});

describe("programInvocation", () => {
  test("uses cmd.exe only for Windows batch launchers and rejects unsafe input", () => {
    expect(
      programInvocation(
        "C:\\Program Files\\agent.cmd",
        ["two words"],
        { COMSPEC: "C:\\Windows\\cmd.exe" },
        "win32",
      ),
    ).toEqual({
      command: "C:\\Windows\\cmd.exe",
      args: ["/d", "/s", "/c", '""C:\\Program Files\\agent.cmd" "two words""'],
      windowsVerbatimArguments: true,
    });
    expect(programInvocation("C:\\agent.exe", ["a&b"], {}, "win32")).toEqual({
      command: "C:\\agent.exe",
      args: ["a&b"],
    });
    expect(programInvocation("C:\\agent.cmd", ["a&b"], {}, "win32")).toMatchObject({
      error: expect.any(String),
    });
    expect(programInvocation("/tmp/agent.cmd", ["a&b"], {}, "linux")).toEqual({
      command: "/tmp/agent.cmd",
      args: ["a&b"],
    });
  });

  test("tree cleanup is a Windows taskkill request and a POSIX group signal", () => {
    expect(treeKillInvocation(4312, "win32")).toEqual({
      command: "taskkill",
      args: ["/T", "/F", "/PID", "4312"],
    });
    expect(treeKillInvocation(4312, "linux")).toBeNull();
  });
});
