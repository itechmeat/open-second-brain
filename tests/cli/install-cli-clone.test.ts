import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CLI_SPAWN_BUDGET_MS } from "../helpers/cli-timeout.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("install-cli in a checkout copy publishes the existing scripts launchers", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "o2b-cli-clone-")));
  roots.push(root);
  const checkout = join(root, "checkout");
  mkdirSync(checkout, { recursive: true });
  for (const name of readdirSync(resolve("."))) {
    if ([".git", ".review", "node_modules"].includes(name)) continue;
    cpSync(join(resolve("."), name), join(checkout, name), { recursive: true });
  }
  const modules = resolve("node_modules");
  if (existsSync(modules))
    symlinkSync(
      modules,
      join(checkout, "node_modules"),
      process.platform === "win32" ? "junction" : "dir",
    );
  const home = join(root, "isolated home");
  const bin = join(root, "installed bin");
  for (const dir of [
    home,
    bin,
    join(root, "config"),
    join(root, "data"),
    join(root, "state"),
    join(root, "cache"),
    join(root, "bun-install"),
    join(root, "bun-global"),
    join(root, "bun-bin"),
    join(root, "bun-cache"),
    join(root, "npm-prefix"),
    join(root, "npm-cache"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  const env: Record<string, string> = {
    PATH: (process.platform === "win32"
      ? [
          dirname(process.execPath),
          bin,
          join(root, "bun-bin"),
          join(process.env.SystemRoot ?? "C:\\Windows", "System32"),
          process.env.SystemRoot ?? "C:\\Windows",
        ]
      : [dirname(process.execPath), bin, join(root, "bun-bin"), "/usr/bin", "/bin"]
    ).join(process.platform === "win32" ? ";" : ":"),
    HOME: home,
    XDG_CONFIG_HOME: join(root, "config"),
    XDG_DATA_HOME: join(root, "data"),
    XDG_STATE_HOME: join(root, "state"),
    XDG_CACHE_HOME: join(root, "cache"),
    TMPDIR: join(root, "tmp"),
    TEMP: join(root, "tmp"),
    TMP: join(root, "tmp"),
    BUN_INSTALL: join(root, "bun-install"),
    BUN_INSTALL_GLOBAL_DIR: join(root, "bun-global"),
    BUN_INSTALL_BIN: join(root, "bun-bin"),
    BUN_INSTALL_CACHE_DIR: join(root, "bun-cache"),
    npm_config_prefix: join(root, "npm-prefix"),
    npm_config_cache: join(root, "npm-cache"),
    OPEN_SECOND_BRAIN_CONFIG: join(root, "config", "config.yaml"),
    OPEN_SECOND_BRAIN_STORE_ROOT: join(root, "data", "store"),
  };
  mkdirSync(env.TMPDIR!, { recursive: true });
  if (process.platform === "win32") {
    env["USERPROFILE"] = home;
    env["APPDATA"] = join(root, "appdata");
    env["LOCALAPPDATA"] = join(root, "localappdata");
    env["SystemRoot"] = process.env.SystemRoot ?? "C:\\Windows";
    env["PATHEXT"] = process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  }
  const result = Bun.spawnSync(
    [process.execPath, "run", "src/cli/main.ts", "install-cli", "--bindir", bin],
    {
      cwd: checkout,
      env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(result.exitCode).toBe(0);
  const output = new TextDecoder().decode(result.stdout);
  expect(output).toContain("o2b install-cli");
  for (const name of ["o2b", "vault-log", "o2b-hook"]) {
    if (process.platform === "win32") {
      const wrapper = join(bin, `${name}.cmd`);
      expect(existsSync(wrapper)).toBe(true);
      expect(readFileSync(wrapper, "utf8")).toContain(join(checkout, "scripts", `${name}.cmd`));
    } else {
      const link = join(bin, name);
      expect(lstatSync(link).isSymbolicLink()).toBe(true);
      expect(realpathSync(link)).toBe(join(checkout, "scripts", name));
    }
  }
});
