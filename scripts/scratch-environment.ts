import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { performance } from "node:perf_hooks";

export type PackageManager = "bun" | "npm";

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

export function assertInside(root: string, paths: string[]): void {
  for (const path of paths) {
    const fromBase = relative(root, canonicalPath(path));
    if (
      fromBase !== "" &&
      (fromBase === ".." || fromBase.startsWith(`..${sep}`) || isAbsolute(fromBase))
    )
      throw new Error(`scratch path escaped root: ${path}`);
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

export function run(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; stdin?: Uint8Array; timeout?: number },
) {
  const started = performance.now();
  const invocation =
    process.platform === "win32" && /\.cmd$/i.test(command)
      ? [
          join(options.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"),
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
    timeout: options.timeout,
    stdout: "pipe",
    stderr: "pipe",
    windowsVerbatimArguments: process.platform === "win32" && /\.cmd$/i.test(command),
  });
  return { ...result, durationMs: performance.now() - started };
}

export function findInstallDir(manager: PackageManager, root: string): string {
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

export function findCommand(manager: PackageManager, binDir: string, name: string): string {
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

export function makeEnvironment(
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
  const codexHome = join(root, "codex");
  const grokHome = join(root, "grok");
  const piHome = join(root, "pi");
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
    codexHome,
    grokHome,
    piHome,
    dirname(configPath),
    storeRoot,
    join(root, "work"),
  ];
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  const userConfig = join(root, "npm-user-config");
  const globalConfig = join(root, "npm-global-config");
  for (const file of [userConfig, globalConfig]) if (!existsSync(file)) writeFileSync(file, "");
  const env: Record<string, string> = {
    PATH: [binDir, bunBin, ...systemPath()].join(delimiter),
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
    CODEX_HOME: codexHome,
    GROK_HOME: grokHome,
    PI_HOME: piHome,
  };
  mkdirSync(env.TMPDIR!, { recursive: true });
  if (process.platform === "win32") {
    env.USERPROFILE = home;
    env.APPDATA = join(root, "appdata");
    env.LOCALAPPDATA = join(root, "localappdata");
    env.SystemRoot = process.env.SystemRoot ?? "C:\\Windows";
    env.PATHEXT = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
    mkdirSync(env.APPDATA, { recursive: true });
    mkdirSync(env.LOCALAPPDATA, { recursive: true });
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
    codexHome,
    grokHome,
    piHome,
    userConfig,
    globalConfig,
    configPath,
    storeRoot,
  ]);
  return env;
}
