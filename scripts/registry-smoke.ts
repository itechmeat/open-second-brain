import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { performance } from "node:perf_hooks";
import { findCommand, findInstallDir, makeEnvironment, run } from "./scratch-environment.ts";

type RetryClock = { now: () => number; sleep: (ms: number) => Promise<void> };

export function isLocalTarball(spec: string): boolean {
  return spec.endsWith(".tgz") && (existsSync(spec) || spec.includes("/") || spec.includes("\\"));
}

function isVersionMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as {
    code?: string;
    message?: string;
    stdout?: Uint8Array;
    stderr?: Uint8Array;
  };
  if (candidate.code === "E404") return true;
  const text = [
    candidate.message,
    candidate.stdout && new TextDecoder().decode(candidate.stdout),
    candidate.stderr && new TextDecoder().decode(candidate.stderr),
  ]
    .filter(Boolean)
    .join("\n");
  try {
    return (JSON.parse(text) as { error?: { code?: string } }).error?.code === "E404";
  } catch {
    return false;
  }
}

export function bunInstallError(output: string): Error & { code?: string } {
  const error = new Error(output || "bun global install failed") as Error & { code?: string };
  const missingVersion =
    /No version matching/i.test(output) && !/minimum-release-age/i.test(output);
  if (/E404|404 Not Found/i.test(output) || missingVersion) error.code = "E404";
  return error;
}

export async function retryRegistryInstall<T>(
  install: (timeoutMs: number) => Promise<T> | T,
  clock: RetryClock = {
    now: performance.now,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
): Promise<T> {
  const deadline = clock.now() + 300_000;
  let lastMissingVersionError: unknown;
  for (;;) {
    // Whole milliseconds: the spawn timeout refuses a fractional value.
    const remaining = Math.floor(deadline - clock.now());
    if (remaining < 1)
      throw new Error("registry version was not served within five minutes", {
        cause: lastMissingVersionError,
      });
    try {
      // Each install attempt must finish before deciding whether to retry.
      // oxlint-disable-next-line no-await-in-loop
      return await install(remaining);
    } catch (error) {
      if (!isVersionMissing(error)) throw error;
      lastMissingVersionError = error;
      const afterAttempt = deadline - clock.now();
      if (afterAttempt <= 0)
        throw new Error("registry version was not served within five minutes", { cause: error });
      // Wait between attempts so the registry can propagate the version.
      // oxlint-disable-next-line no-await-in-loop
      await clock.sleep(Math.min(10_000, afterAttempt));
    }
  }
}

export async function registrySmoke(spec: string, expectedVersion: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "o2b-registry-smoke-")));
  const binDir = join(root, "bun-bin");
  const env = makeEnvironment(root, binDir, "bun");
  const cwd = join(root, "work");
  try {
    // A local tarball is resolved here: the child runs in the scratch directory.
    const installSpec = isLocalTarball(spec) ? resolve(spec) : spec;
    const install = (installTimeoutMs?: number) => {
      const result = run(process.execPath, ["add", "--global", installSpec], {
        cwd,
        env,
        timeout: installTimeoutMs,
      });
      if (result.exitCode === 0) return result;
      const output = new TextDecoder().decode(result.stderr || result.stdout);
      throw bunInstallError(output);
    };
    if (isLocalTarball(spec)) install();
    else await retryRegistryInstall((installTimeoutMs) => install(installTimeoutMs));
    const installDir = findInstallDir("bun", root);
    const command = findCommand("bun", binDir, "o2b");
    const version = run(command, ["version"], { cwd, env });
    const versionText = new TextDecoder().decode(version.stdout).trim();
    const escapedVersion = expectedVersion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const hasExpectedVersion = new RegExp(
      `(?:^|[^0-9A-Za-z.+-])v?${escapedVersion}(?:$|[^0-9A-Za-z.+-])`,
    ).test(versionText);
    if (version.exitCode !== 0 || !hasExpectedVersion)
      throw new Error(`installed version check failed for ${expectedVersion}: ${versionText}`);
    const setup = run(
      command,
      ["setup", "--target", "cursor", "--no-vault", "--agent-name", "smoke", "--timezone", "UTC"],
      { cwd, env },
    );
    if (setup.exitCode !== 0)
      throw new Error(
        `setup plan failed for ${expectedVersion} on ${process.platform}: ${new TextDecoder().decode(setup.stderr).trim()}`,
      );
    const paths = [
      env.HOME!,
      env.XDG_CONFIG_HOME!,
      env.XDG_DATA_HOME!,
      env.XDG_STATE_HOME!,
      env.XDG_CACHE_HOME!,
      env.BUN_INSTALL!,
      env.BUN_INSTALL_GLOBAL_DIR!,
      env.BUN_INSTALL_BIN!,
      env.BUN_INSTALL_CACHE_DIR!,
      env.npm_config_prefix!,
      env.npm_config_cache!,
      env.npm_config_userconfig!,
      env.npm_config_globalconfig!,
      env.OPEN_SECOND_BRAIN_CONFIG!,
      env.OPEN_SECOND_BRAIN_STORE_ROOT!,
      env.CODEX_HOME!,
      env.GROK_HOME!,
      env.PI_HOME!,
      env.TMPDIR!,
      env.TEMP!,
      env.TMP!,
      env.USERPROFILE,
      env.APPDATA,
      env.LOCALAPPDATA,
      installDir,
      command,
    ].filter((path): path is string => Boolean(path));
    if (paths.some((path) => !path.startsWith(root)))
      throw new Error("registry smoke wrote outside its scratch directory");
    return { version: versionText, setupExitCode: setup.exitCode, root, paths };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const [spec, expectedVersion] = process.argv.slice(2);
  if (!spec || !expectedVersion)
    throw new Error("usage: registry-smoke.ts <spec> <expected-version>");
  const result = await registrySmoke(spec, expectedVersion);
  process.stdout.write(`registry smoke passed: ${result.version}\n`);
}
