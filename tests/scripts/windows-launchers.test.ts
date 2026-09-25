/**
 * The Windows `.cmd` launchers, run for real through `cmd.exe`.
 *
 * Two things only a real cmd.exe can show:
 *
 *  - END TO END: `installCliWindows` writes a launcher into a bin
 *    directory, and an MCP host's `cmd /d /c o2b ...` (the payload form)
 *    reaches the CLI through it and the checkout's `scripts\o2b.cmd`.
 *  - THE CURRENT-DIRECTORY HIJACK: cmd.exe looks for a bare command name in
 *    the current directory before PATH, and an agent host runs in the
 *    project it opened. A repository that ships `o2b.cmd` or `bun.cmd`
 *    must not get them run. The payload's environment stops the first,
 *    the launchers' own `NoDefaultCurrentDirectoryInExePath` the second.
 *    A control case runs the same command without the protection and
 *    asserts the planted file DOES run, so the fixture is proven live.
 *
 * Windows only; the POSIX launchers have no such lookup.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { installCliWindows } from "../../src/cli/install-cli-windows.ts";
import { launcherCommand, WINDOWS_LAUNCHER_ENV } from "../../src/core/install/payload.ts";
import { IS_WINDOWS } from "../helpers/platform.ts";

const REPO = resolve(import.meta.dir, "..", "..");
const SCRIPTS = join(REPO, "scripts");
const VERSION = (
  JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string }
).version;

let root: string;
let plant: string;
let bin: string;

/** A batch file that leaves a marker next to itself and says it ran. */
function plantedCmd(name: string): void {
  writeFileSync(
    join(plant, `${name}.cmd`),
    `@echo off\r\necho planted>"%~dp0ran-${name}.txt"\r\necho PLANTED ${name}\r\n`,
  );
}

function ranPlanted(name: string): boolean {
  return existsSync(join(plant, `ran-${name}.txt`));
}

/** The environment a host starts the server with: PATH = bin, Bun, the rest. */
function hostEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || k.toLowerCase() === "nodefaultcurrentdirectoryinexepath") continue;
    if (k.toLowerCase() === "path") continue;
    env[k] = v;
  }
  env["PATH"] = [bin, dirname(process.execPath), process.env["PATH"] ?? ""].join(";");
  return { ...env, ...extra };
}

function cmd(args: ReadonlyArray<string>, env: Record<string, string>, cwd = plant) {
  const comspec = process.env["ComSpec"] || "cmd.exe";
  return spawnSync(comspec, [...args], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
}

describe.skipIf(!IS_WINDOWS)("Windows .cmd launchers through cmd.exe", () => {
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "o2b-winlaunch-"));
    plant = join(root, "some-project");
    bin = join(root, "bin");
    mkdirSync(plant, { recursive: true });
    plantedCmd("o2b");
    plantedCmd("bun");
    const res = installCliWindows(["o2b", "o2b-hook"], SCRIPTS, bin);
    expect(res.errors).toEqual([]);
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("control: without the protection, cmd runs the o2b.cmd in the current directory", () => {
    const { prefix } = launcherCommand("win32");
    const proc = cmd([...prefix, "--version"], hostEnv());
    expect(proc.stdout).toContain("PLANTED o2b");
    expect(ranPlanted("o2b")).toBe(true);
    rmSync(join(plant, "ran-o2b.txt"));
  });

  test("the payload's command and environment reach the real CLI, end to end", () => {
    const { prefix } = launcherCommand("win32");
    const proc = cmd([...prefix, "--version"], hostEnv({ ...WINDOWS_LAUNCHER_ENV }));
    expect(proc.stdout).not.toContain("PLANTED");
    expect(proc.stdout).toContain(VERSION);
    expect(proc.status).toBe(0);
    expect(ranPlanted("o2b")).toBe(false);
    expect(ranPlanted("bun")).toBe(false);
  });

  test("the launcher itself never runs a bun.cmd from the current directory", () => {
    // Claude Code starts the checkout's launcher by absolute path, with no
    // payload environment at all: the launcher has to protect its own
    // `bun` lookup.
    const proc = cmd(["/d", "/c", join(SCRIPTS, "o2b.cmd"), "--version"], hostEnv());
    expect(proc.stdout).not.toContain("PLANTED");
    expect(proc.stdout).toContain(VERSION);
    expect(proc.status).toBe(0);
    expect(ranPlanted("bun")).toBe(false);
  });

  test("a % in the checkout path survives the generated launcher", () => {
    const checkout = join(root, "pct%OS%dir");
    mkdirSync(join(checkout, "scripts"), { recursive: true });
    writeFileSync(join(checkout, "scripts", "o2b.cmd"), "@echo reached %*\r\n");
    const pctBin = join(root, "pct-bin");
    expect(installCliWindows(["o2b"], join(checkout, "scripts"), pctBin).errors).toEqual([]);
    const proc = cmd(["/d", "/c", join(pctBin, "o2b.cmd"), "hi"], hostEnv(), root);
    expect(proc.stdout.trim()).toBe("reached hi");
  });

  test("o2b-hook.cmd passes an empty argument through instead of stopping at it", () => {
    const pluginRoot = join(root, "plugin");
    mkdirSync(join(pluginRoot, "hooks"), { recursive: true });
    writeFileSync(
      join(pluginRoot, "hooks", "echo-args.ts"),
      "process.stdout.write(JSON.stringify(process.argv.slice(2)));\n",
    );
    const proc = cmd(
      ["/d", "/c", join(SCRIPTS, "o2b-hook.cmd"), "echo-args", "a", "", "b"],
      hostEnv({ CLAUDE_PLUGIN_ROOT: pluginRoot }),
    );
    expect(proc.status).toBe(0);
    expect(JSON.parse(proc.stdout)).toEqual(["a", "", "b"]);
    expect(ranPlanted("bun")).toBe(false);
  });
});
