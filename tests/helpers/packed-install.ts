import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { tempDirs } from "./temp-dir.ts";
import { spawnNpmSync } from "../../scripts/npm.ts";

export type PackageManager = "bun" | "npm";

export interface PackedTarball {
  root: string;
  tarball: string;
}

export interface PackedInstall {
  root: string;
  manager: PackageManager;
  prefix: string;
  binDir: string;
  installDir: string;
  home: string;
  configPath: string;
  storeRoot: string;
  stateHome: string;
  cwd: string;
  env: Record<string, string>;
  commands: Record<string, string>;
}

const makeTemp = tempDirs();

function canonicalPath(path: string): string {
  let current = resolve(path);
  const suffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    suffix.unshift(basename(current));
    current = parent;
  }
  return resolve(realpathSync(current), ...suffix);
}

function inside(root: string, path: string): boolean {
  const base = root;
  const target = canonicalPath(path);
  const fromBase = relative(base, target);
  return (
    fromBase === "" ||
    (fromBase !== ".." && !fromBase.startsWith(`..${sep}`) && !isAbsolute(fromBase))
  );
}

function assertInside(root: string, paths: string[]): void {
  for (const path of paths) {
    if (!inside(root, path)) throw new Error(`scratch path escaped root: ${path}`);
  }
}

function systemPath(): string[] {
  const bunDir = dirname(process.execPath);
  const extra = [Bun.which("npm"), Bun.which("node")]
    .filter((path): path is string => path !== null)
    .map(dirname);
  if (process.platform === "win32") {
    const systemRoot = process.env.SystemRoot ?? "C:\\Windows";
    return [...new Set([bunDir, ...extra, join(systemRoot, "System32"), systemRoot])];
  }
  return [...new Set([bunDir, ...extra, "/usr/bin", "/bin", "/usr/sbin", "/sbin"])];
}

function makeEnvironment(
  root: string,
  binDir: string,
  manager: PackageManager,
): Record<string, string> {
  const home = join(root, "home");
  const config = join(root, "xdg-config");
  const data = join(root, "xdg-data");
  const state = join(root, "xdg-state");
  const cache = join(root, "xdg-cache");
  const bunInstall = join(root, "bun-install");
  const bunGlobal = join(root, "bun-global");
  const bunBin = join(root, "bun-bin");
  const bunCache = join(root, "bun-cache");
  const npmPrefix = manager === "npm" ? join(root, "npm-prefix") : join(root, "npm-unused-prefix");
  const npmCache = join(root, "npm-cache");
  const configPath = join(root, "app", "config.yaml");
  const storeRoot = join(root, "app", "store");
  const dirs = [
    home,
    config,
    data,
    state,
    cache,
    bunInstall,
    bunGlobal,
    bunBin,
    bunCache,
    npmPrefix,
    npmCache,
    dirname(configPath),
    storeRoot,
    join(root, "work"),
  ];
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  const userConfig = join(root, "npm-user-config");
  const globalConfig = join(root, "npm-global-config");
  for (const file of [userConfig, globalConfig]) {
    if (!existsSync(file)) writeFileSync(file, "");
  }
  const env: Record<string, string> = {
    PATH: [...systemPath(), binDir, bunBin].join(delimiter),
    HOME: home,
    XDG_CONFIG_HOME: config,
    XDG_DATA_HOME: data,
    XDG_STATE_HOME: state,
    XDG_CACHE_HOME: cache,
    TMPDIR: join(root, "tmp"),
    TEMP: join(root, "tmp"),
    TMP: join(root, "tmp"),
    BUN_INSTALL: bunInstall,
    BUN_INSTALL_GLOBAL_DIR: bunGlobal,
    BUN_INSTALL_BIN: bunBin,
    BUN_INSTALL_CACHE_DIR: bunCache,
    npm_config_prefix: npmPrefix,
    npm_config_cache: npmCache,
    npm_config_userconfig: userConfig,
    npm_config_globalconfig: globalConfig,
    OPEN_SECOND_BRAIN_CONFIG: configPath,
    OPEN_SECOND_BRAIN_STORE_ROOT: storeRoot,
  };
  mkdirSync(env.TMPDIR!, { recursive: true });
  if (process.platform === "win32") {
    env["USERPROFILE"] = home;
    env["APPDATA"] = join(root, "appdata");
    env["LOCALAPPDATA"] = join(root, "localappdata");
    env["SystemRoot"] = process.env.SystemRoot ?? "C:\\Windows";
    env["PATHEXT"] = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
    mkdirSync(env["APPDATA"], { recursive: true });
    mkdirSync(env["LOCALAPPDATA"], { recursive: true });
  }
  assertInside(root, [
    home,
    config,
    data,
    state,
    cache,
    bunInstall,
    bunGlobal,
    bunBin,
    bunCache,
    npmPrefix,
    npmCache,
    userConfig,
    globalConfig,
    configPath,
    storeRoot,
  ]);
  return env;
}

function run(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdin?: Uint8Array },
) {
  const started = performance.now();
  const invocation =
    process.platform === "win32" && /\.cmd$/i.test(command)
      ? [
          join(options.env["SystemRoot"] ?? "C:\\Windows", "System32", "cmd.exe"),
          "/d",
          "/s",
          "/c",
          `"${[command, ...args].map((arg) => `"${arg.replaceAll('"', '""')}"`).join(" ")}"`,
        ]
      : [command, ...args];
  const result = Bun.spawnSync(invocation, {
    cwd: options.cwd,
    env: options.env,
    stdin: options.stdin,
    stdout: "pipe",
    stderr: "pipe",
    windowsVerbatimArguments: process.platform === "win32" && /\.cmd$/i.test(command),
  });
  return { ...result, durationMs: performance.now() - started };
}

function findInstallDir(manager: PackageManager, root: string): string {
  const candidates =
    manager === "bun"
      ? [
          join(root, "bun-global", "node_modules", "open-second-brain"),
          join(root, "bun-global", "open-second-brain"),
        ]
      : [
          join(root, "npm-prefix", "lib", "node_modules", "open-second-brain"),
          join(root, "npm-prefix", "node_modules", "open-second-brain"),
        ];
  const path = candidates.find((candidate) => existsSync(join(candidate, "package.json")));
  if (!path) throw new Error(`installed package not found under scratch prefix ${root}`);
  return resolve(path);
}

function findCommand(manager: PackageManager, binDir: string, name: string): string {
  const names =
    process.platform !== "win32"
      ? [name]
      : manager === "npm"
        ? [`${name}.cmd`]
        : [`${name}.exe`, `${name}.cmd`, `${name}.bat`, name];
  const path = names.map((candidate) => join(binDir, candidate)).find(existsSync);
  if (!path) throw new Error(`installed command missing: ${name} in ${binDir}`);
  return resolve(path);
}

export function packCheckout(): PackedTarball {
  const root = realpathSync(makeTemp("o2b-packed-tarball-"));
  const env = makeEnvironment(root, join(root, "bin-unused"), "npm");
  const packed = spawnNpmSync(["pack", "--ignore-scripts", "--pack-destination", root], {
    cwd: resolve("."),
    env,
  });
  if (packed.exitCode !== 0)
    throw new Error(new TextDecoder().decode(packed.stderr).trim() || "npm pack failed");
  const name = `open-second-brain-${(JSON.parse(readFileSync("package.json", "utf8")) as { version: string }).version}.tgz`;
  const tarball = join(root, name);
  if (!existsSync(tarball)) throw new Error(`npm pack did not create ${tarball}`);
  assertInside(root, [tarball]);
  return { root, tarball };
}

export function installPacked(
  tarball: PackedTarball,
  manager: PackageManager,
  suffix = "",
): PackedInstall {
  const root = realpathSync(makeTemp(`o2b-packed-${manager}-${suffix}`));
  try {
    const prefix = manager === "bun" ? join(root, "bun-global") : join(root, "npm-prefix");
    const binDir =
      manager === "bun"
        ? join(root, "bun-bin")
        : process.platform === "win32"
          ? prefix
          : join(prefix, "bin");
    const env = makeEnvironment(root, binDir, manager);
    assertInside(root, [
      prefix,
      binDir,
      env["OPEN_SECOND_BRAIN_CONFIG"]!,
      env["OPEN_SECOND_BRAIN_STORE_ROOT"]!,
      env["XDG_STATE_HOME"]!,
    ]);
    const cwd = join(root, "work");
    if (manager === "bun") {
      const result = run(process.execPath, ["add", "--global", tarball.tarball], { cwd, env });
      if (result.exitCode !== 0)
        throw new Error(
          new TextDecoder().decode(result.stderr).trim() || "bun global install failed",
        );
    } else {
      const result = spawnNpmSync(["install", "--global", "--ignore-scripts", tarball.tarball], {
        cwd,
        env,
      });
      if (result.exitCode !== 0)
        throw new Error(
          new TextDecoder().decode(result.stderr).trim() || "npm global install failed",
        );
    }
    const installDir = realpathSync(findInstallDir(manager, root));
    const resolvedBin = realpathSync(binDir);
    const configPath = resolve(env["OPEN_SECOND_BRAIN_CONFIG"]!);
    const storeRoot = resolve(env["OPEN_SECOND_BRAIN_STORE_ROOT"]!);
    const stateHome = resolve(env["XDG_STATE_HOME"]!);
    assertInside(root, [installDir, resolvedBin, configPath, storeRoot, stateHome]);
    const commands = Object.fromEntries(
      ["o2b", "o2b-mcp", "o2b-hook"].map((name) => [name, findCommand(manager, binDir, name)]),
    );
    return {
      root,
      manager,
      prefix,
      binDir: resolvedBin,
      installDir,
      home: env["HOME"]!,
      configPath,
      storeRoot,
      stateHome,
      cwd,
      env,
      commands,
    };
  } catch (error) {
    cleanupPacked(root);
    throw error;
  }
}

export function runPackedCommand(
  install: PackedInstall,
  command: string,
  args: string[],
  stdin?: Uint8Array,
) {
  const paths = [
    install.installDir,
    install.binDir,
    install.configPath,
    install.storeRoot,
    install.stateHome,
  ];
  assertInside(install.root, paths);
  return run(install.commands[command]!, args, { cwd: install.cwd, env: install.env, stdin });
}

export function cleanupPacked(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

export function probeRegistry(): { reachable: boolean; reason: string } {
  const root = realpathSync(makeTemp("o2b-registry-probe-"));
  try {
    const env = makeEnvironment(root, join(root, "bin-unused"), "npm");
    const result = spawnNpmSync(["ping", "--fetch-retries=0", "--fetch-timeout=10000"], {
      cwd: join(root, "work"),
      env,
    });
    const output = new TextDecoder().decode(result.stderr || result.stdout).trim();
    return {
      reachable: result.exitCode === 0,
      reason: output || `npm ping exited ${result.exitCode}`,
    };
  } finally {
    cleanupPacked(root);
  }
}
