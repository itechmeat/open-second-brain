/**
 * The launchers' dependency bootstrap (issue #260).
 *
 * A Codex marketplace add/upgrade replaces the checkout wholesale, so the
 * tree can arrive with package.json and bun.lock but WITHOUT node_modules.
 * The CLI then cannot start (`Cannot find package 'proper-lockfile'` from
 * src/core/config.ts), and `o2b install-cli` cannot repair anything because
 * it runs through the same import. The fix lives in the shared launcher
 * preamble: `scripts/_bun-precheck.sh` (bash) and the `.cmd` twins probe for
 * the one runtime dependency with a file stat and run
 * `bun install --frozen-lockfile` once when it is missing.
 *
 * Three layers are pinned here:
 *
 *  - POSIX unit tests source `scripts/_bun-precheck.sh` against a stub `bun`
 *    that logs its arguments, so the probe's decision is observable without
 *    importing the CLI at all: a cold tree installs once, a warm tree never,
 *    a failed install degrades to a named manual command, and the
 *    O2B_SKIP_DEP_BOOTSTRAP seam opts out.
 *  - A Windows unit test drives `scripts/o2b.cmd` through cmd.exe with the
 *    same kind of stub, following tests/scripts/windows-launchers.test.ts.
 *  - The end-to-end regression copies the launcher-relevant tree (src, hooks,
 *    scripts, package.json, bun.lock, bunfig.toml) WITHOUT node_modules into
 *    a temp directory, runs the real launcher with an isolated HOME and an
 *    empty bun cache, and asserts the CLI answers `--version` - a real
 *    entry point, no model credentials, and only the network the
 *    `bun install` itself needs. `install-cli` then works from the same
 *    checkout, which is the order the documented Codex flow relies on.
 */
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";
import { homeEnv, IS_WINDOWS } from "../helpers/platform.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const VERSION = (
  JSON.parse(readFileSync(join(REPO, "package.json"), "utf8")) as { version: string }
).version;

/** The failure the launcher must never let surface (issue #260's symptom). */
const MODULE_NOT_FOUND = "Cannot find package";

const tmps: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmps.push(dir);
  return dir;
}

afterEach(() => {
  while (tmps.length) {
    try {
      rmSync(tmps.pop()!, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup: a temp dir some process still holds must not
      // fail the suite (Windows refuses to delete open directories).
    }
  }
});

/**
 * The tree a cold marketplace clone holds: the launcher-relevant sources and
 * the manifests, and deliberately no node_modules. The full src and hooks
 * trees are needed because `--version` imports the whole CLI graph, which
 * reaches hooks/lib from src.
 */
function coldTree(): string {
  const tree = tempDir("o2b-boot-tree-");
  cpSync(join(REPO, "src"), join(tree, "src"), { recursive: true });
  cpSync(join(REPO, "hooks"), join(tree, "hooks"), { recursive: true });
  cpSync(join(REPO, "scripts"), join(tree, "scripts"), { recursive: true });
  for (const name of ["package.json", "bun.lock", "bunfig.toml"]) {
    cpSync(join(REPO, name), join(tree, name));
  }
  rmSync(join(tree, "node_modules"), { recursive: true, force: true });
  return tree;
}

/**
 * Just the launcher script under test in a scripts/ directory. The unit
 * layers stub bun out, so no sources and no manifests are needed - the
 * decision under test is the probe, and a full copy would spend seconds
 * per test on files the stub never reads.
 */
function minimalTree(scriptName: string): string {
  const tree = tempDir("o2b-boot-mini-");
  mkdirSync(join(tree, "scripts"), { recursive: true });
  cpSync(join(REPO, "scripts", scriptName), join(tree, "scripts", scriptName));
  return tree;
}

/** Plant the probe's marker: the file the bootstrap stats on the warm path. */
function plantDependencies(tree: string): void {
  const marker = join(tree, "node_modules", "proper-lockfile");
  mkdirSync(marker, { recursive: true });
  writeFileSync(join(marker, "package.json"), '{"name":"proper-lockfile"}\n');
}

// ── POSIX: the shared preamble sourced against a stub bun ──────────────────

// Everything `_bun-precheck.sh` reaches for that is not a shell builtin.
// The child's PATH is built from exactly these plus the stub, so no real
// Bun on this machine can answer for the tree under test.
const REQUIRED_UTILITIES = ["bash", "cat", "tr", "head"];

/** A `bun` whose arguments are logged and whose version check succeeds. */
function stubBun(bin: string, options: { failInstall?: boolean } = {}): void {
  const install = options.failInstall ? "exit 1" : ":";
  const stub = join(bin, "bun");
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> "$BUN_CALL_LOG"`,
      `if [ "$1" = "--version" ]; then printf '%s\\n' "1.4.3"; else ${install}; fi`,
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o755);
}

/** A PATH holding the preamble's utilities and provably no real bun. */
function isolatedPath(): string {
  const bin = tempDir("o2b-boot-bin-");
  for (const name of REQUIRED_UTILITIES) {
    const resolved = Bun.which(name);
    if (!resolved) throw new Error(`test prerequisite missing from this machine: ${name}`);
    symlinkSync(resolved, join(bin, name));
  }
  if (Bun.which("bun", { PATH: bin })) throw new Error("isolated PATH leaked a bun");
  return bin;
}

interface PrecheckRun {
  readonly code: number;
  /** Both streams: the assertions look for notices wherever they printed. */
  readonly output: string;
  /** One entry per stub-bun invocation, in order. */
  readonly calls: string[];
}

async function sourcePrecheck(
  tree: string,
  options: { failInstall?: boolean; skipBootstrap?: boolean } = {},
): Promise<PrecheckRun> {
  const bin = isolatedPath();
  stubBun(bin, options);
  const log = join(tempDir("o2b-boot-log-"), "bun-calls.log");
  const env: Record<string, string> = {
    HOME: tempDir("o2b-boot-home-"),
    PATH: bin,
    REPO_ROOT: tree,
    BUN_CALL_LOG: log,
    ...(options.skipBootstrap ? { O2B_SKIP_DEP_BOOTSTRAP: "1" } : {}),
  };
  const proc = Bun.spawn(
    ["bash", "-c", `. "${join(tree, "scripts", "_bun-precheck.sh")}"; echo PRECHECK_PASSED`],
    { env, stdout: "pipe", stderr: "pipe" },
  );
  const [stderr, code, stdout] = await Promise.all([
    new Response(proc.stderr).text(),
    proc.exited,
    new Response(proc.stdout).text(),
  ]);
  const calls = existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : [];
  return { code: code ?? -1, output: stderr + stdout, calls };
}

describe.skipIf(IS_WINDOWS)("launcher bootstrap decision (scripts/_bun-precheck.sh)", () => {
  test("a cold checkout runs the frozen install exactly once and then passes", async () => {
    const tree = minimalTree("_bun-precheck.sh");
    const run = await sourcePrecheck(tree);
    expect(run.code).toBe(0);
    expect(run.output).toContain("bun install --frozen-lockfile");
    expect(run.calls.filter((call) => call.startsWith("install"))).toHaveLength(1);
    expect(run.calls.some((call) => call.startsWith("--version"))).toBe(true);
  });

  test("a checkout with the dependency tree present adds no bootstrap", async () => {
    const tree = minimalTree("_bun-precheck.sh");
    plantDependencies(tree);
    const run = await sourcePrecheck(tree);
    expect(run.code).toBe(0);
    expect(run.calls.some((call) => call.startsWith("install"))).toBe(false);
    // The only Bun work left is the version check the precheck always does.
    expect(run.calls).toEqual(["--version"]);
  });

  test("a failed bootstrap exits nonzero and names the manual command", async () => {
    const tree = minimalTree("_bun-precheck.sh");
    const run = await sourcePrecheck(tree, { failInstall: true });
    expect(run.code).not.toBe(0);
    expect(run.output).toContain("bun install --frozen-lockfile");
    expect(run.output).toContain("then retry");
  });

  test("O2B_SKIP_DEP_BOOTSTRAP opts a cold checkout out of the install", async () => {
    const tree = minimalTree("_bun-precheck.sh");
    const run = await sourcePrecheck(tree, { skipBootstrap: true });
    expect(run.code).toBe(0);
    expect(run.calls.some((call) => call.startsWith("install"))).toBe(false);
  });
});

// ── Windows: the .cmd twin through cmd.exe, with a logging bun stub ─────────

/** A bun.cmd whose arguments are logged; o2b.cmd finds it first on PATH. */
function stubBunCmd(bin: string, log: string): void {
  writeFileSync(join(bin, "bun.cmd"), `@echo off\r\necho %*>>"${log}"\r\n`);
}

function runO2bCmd(
  tree: string,
  args: ReadonlyArray<string>,
  env: Record<string, string>,
): { status: number | null; stdout: string; stderr: string } {
  const comspec = process.env["ComSpec"] || "cmd.exe";
  const proc = spawnSync(comspec, ["/d", "/c", join(tree, "scripts", "o2b.cmd"), ...args], {
    env,
    encoding: "utf8",
    timeout: CLI_SPAWN_BUDGET_MS,
    windowsHide: true,
  });
  return { status: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
}

function stubEnv(log: string): Record<string, string> {
  const bin = tempDir("o2b-boot-cmdbin-");
  stubBunCmd(bin, log);
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(process.env)) {
    if (value !== undefined) env[name] = value;
  }
  env["BUN_CALL_LOG"] = log;
  delete env["O2B_SKIP_DEP_BOOTSTRAP"];
  // The stub dir first, so the launcher's `where bun` and its later bare
  // `bun` invocations both answer the stub.
  env["PATH"] = `${bin};${process.env["PATH"] ?? ""}`;
  return env;
}

function readCalls(log: string): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").split("\r\n").filter(Boolean) : [];
}

describe.skipIf(!IS_WINDOWS)("launcher bootstrap decision (scripts/o2b.cmd)", () => {
  test("a cold checkout runs the frozen install exactly once and then passes", () => {
    const tree = minimalTree("o2b.cmd");
    const log = join(tempDir("o2b-boot-cmdlog-"), "bun-calls.log");
    const run = runO2bCmd(tree, ["--version"], stubEnv(log));
    expect(run.status).toBe(0);
    const installs = readCalls(log).filter((call) => call.startsWith("install"));
    expect(installs).toHaveLength(1);
    expect(installs[0]).toContain("--frozen-lockfile");
  });

  test("a checkout with the dependency tree present adds no bootstrap", () => {
    const tree = minimalTree("o2b.cmd");
    plantDependencies(tree);
    const log = join(tempDir("o2b-boot-cmdlog-"), "bun-calls.log");
    const run = runO2bCmd(tree, ["--version"], stubEnv(log));
    expect(run.status).toBe(0);
    expect(readCalls(log).some((call) => call.startsWith("install"))).toBe(false);
  });
});

// ── End to end: the real launcher, a real CLI start, no node_modules ────────

describe("cold marketplace checkout self-heals on the first launcher run", () => {
  let tree: string;

  /**
   * The real launcher, isolated HOME, empty bun cache - the reporter's repro.
   *
   * The child's TMPDIR is pointed at a temp entry of this file's own: bun's
   * native-module staging (node-gyp) scratches in the ambient temp directory
   * during a cold install, and the suite's leftover guard fails the run for
   * anything a child abandons there (tests/setup.ts). Scratch lives and dies
   * with the afterEach sweep below.
   */
  function runLauncher(args: ReadonlyArray<string>) {
    const home = tempDir("o2b-boot-e2e-home-");
    const scratch = tempDir("o2b-boot-e2e-scratch-");
    const env: Record<string, string> = { ...homeEnv(home) };
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined) env[name] = value;
    }
    env["BUN_INSTALL_CACHE_DIR"] = tempDir("o2b-boot-e2e-cache-");
    env["npm_config_devdir"] = join(scratch, ".node-gyp");
    for (const name of ["TMPDIR", "TMP", "TEMP"] as const) env[name] = scratch;
    delete env["O2B_SKIP_DEP_BOOTSTRAP"];
    if (IS_WINDOWS) {
      const comspec = process.env["ComSpec"] || "cmd.exe";
      return spawnSync(comspec, ["/d", "/c", join(tree, "scripts", "o2b.cmd"), ...args], {
        env,
        encoding: "utf8",
        timeout: CLI_SPAWN_BUDGET_MS,
        windowsHide: true,
      });
    }
    return spawnSync("bash", [join(tree, "scripts", "o2b"), ...args], {
      env,
      encoding: "utf8",
      timeout: CLI_SPAWN_BUDGET_MS,
    });
  }

  test("a fresh checkout starts the real CLI and then serves install-cli", () => {
    tree = coldTree();

    // The core regression: the launcher runs, the bootstrap installs once,
    // and the CLI answers - a real entry point, not manifest validation.
    const cold = runLauncher(["--version"]);
    expect(cold.status).toBe(0);
    expect(cold.stdout).toContain(VERSION);
    expect(cold.stderr).not.toContain(MODULE_NOT_FOUND);
    // The self-heal is what made it pass: the notice ran and the tree the
    // probe wanted now exists.
    expect(cold.stderr).toContain("bun install --frozen-lockfile");
    expect(existsSync(join(tree, "node_modules", "proper-lockfile", "package.json"))).toBe(true);

    // The documented Codex flow's next step, from the same now-warm checkout.
    const bin = tempDir("o2b-boot-e2e-bin-");
    const install = runLauncher(["install-cli", "--bindir", bin]);
    expect(install.status).toBe(0);
    expect(install.stderr ?? "").not.toContain(MODULE_NOT_FOUND);
    // POSIX writes symlinks, Windows writes .cmd shims; both are exit 0.
    expect(existsSync(join(bin, IS_WINDOWS ? "o2b.cmd" : "o2b"))).toBe(true);
  });
});
