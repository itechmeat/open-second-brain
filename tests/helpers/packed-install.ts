import { existsSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tempDirs } from "./temp-dir.ts";
import { spawnNpmSync } from "../../scripts/npm.ts";
import {
  assertInside,
  findCommand,
  findInstallDir,
  makeEnvironment,
  run,
  type PackageManager,
} from "../../scripts/scratch-environment.ts";

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
