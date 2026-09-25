/**
 * Hermes plugin resolver parity, kept out of the shared `doctor()` sequence.
 *
 * The check answers one question: does the Python plugin resolve the same
 * vault the TypeScript core resolves? GitHub #130 was the case where it did
 * not - a plugin whose own docstring claimed to mirror the core's resolution
 * chain and mirrored two of its four steps - and nothing anywhere compared
 * them, so a clean doctor and a wrong setup badge coexisted without
 * contradiction.
 *
 * ## Why it is not a member of `doctor()`
 *
 * It spawns a Python interpreter, deliberately: a TypeScript reimplementation
 * of the plugin's resolver would be a THIRD implementation and would prove
 * nothing about the two that disagree. That spawn is the reason this module is
 * separate. `src/core/doctor.ts` is bundled into `openclaw/index.js`, and
 * `tests/openclaw/bundle.test.ts` refuses a Python reference in that artifact,
 * because the legacy implementation dispatched to Python and a leftover
 * reference would mean the port was incomplete. That guard is right and stays
 * as it is. OpenClaw also has no Hermes plugin, so a check about the Hermes
 * relationship is not merely unbundlable there, it is meaningless there.
 *
 * The surfaces that own the Hermes relationship - the `o2b doctor` verb -
 * import this module directly and append its result. A runtime that has no
 * Hermes plugin neither imports it nor pays for it.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { defaultConfigPath, resolveVault } from "./config.ts";
import type { CheckResult } from "./types.ts";

const RESOLVER_PARITY = "hermes_resolver_parity";

/** One way to start a Python 3 interpreter: the command plus its leading args. */
interface PythonCandidate {
  readonly bin: string;
  readonly args: ReadonlyArray<string>;
}

/**
 * Interpreters tried, in order, to run the plugin's own resolver. Named rather
 * than discovered: `python` is ambiguous on installs that still ship a 2.x
 * under that name, so the versioned name is asked for first.
 *
 * Native Windows adds the `py` launcher (`py -3`), which the python.org
 * installer puts on PATH even when "add python.exe to PATH" is left
 * unticked - on many Windows machines it is the ONLY name that reaches a
 * real interpreter.
 */
const PYTHON_CANDIDATES: ReadonlyArray<PythonCandidate> = Object.freeze(
  process.platform === "win32"
    ? [
        { bin: "python3", args: [] },
        { bin: "python", args: [] },
        { bin: "py", args: ["-3"] },
      ]
    : [
        { bin: "python3", args: [] },
        { bin: "python", args: [] },
      ],
);

/**
 * Is `bin` the Microsoft Store "App Execution Alias" placeholder rather than
 * an interpreter?
 *
 * A stock Windows install puts `python.exe` and `python3.exe` stubs in
 * `%LOCALAPPDATA%\Microsoft\WindowsApps`. With no Store Python behind them
 * they print "Python was not found ..." and exit non-zero, so the spawn
 * SUCCEEDS where POSIX would answer ENOENT. Read as a crash, that stub would
 * stop the candidate walk at the first name and report a broken interpreter
 * on a machine that simply has none (or has one reachable only as `py`).
 * Only a FAILED run from that directory is treated as absent: a real Store
 * Python lives behind the same alias path and answers normally.
 */
export function isWindowsStoreAliasStub(
  bin: string,
  platform: NodeJS.Platform = process.platform,
  which: (cmd: string) => string | null = whichOnCurrentPath,
): boolean {
  if (platform !== "win32") return false;
  const found = which(bin);
  return found !== null && /[\\/]Microsoft[\\/]WindowsApps[\\/]/i.test(found);
}

/**
 * `Bun.which` over the CURRENT `PATH`, passed explicitly: `Bun.which`
 * otherwise searches the PATH this process started with, not the one the
 * spawn above just used. Null where there is no Bun (the Node bundle).
 */
function whichOnCurrentPath(cmd: string): string | null {
  const bun = (
    globalThis as {
      Bun?: { which?: (cmd: string, opts?: { PATH?: string }) => string | null };
    }
  ).Bun;
  return typeof bun?.which === "function"
    ? bun.which(cmd, { PATH: process.env["PATH"] ?? "" })
    : null;
}

/**
 * Wall-clock budget for the plugin-side probe. The driver reads at most a few
 * small files, so anything near this is a hang, and a doctor that hangs is
 * worse than one that reports it could not measure.
 */
const PLUGIN_RESOLVER_TIMEOUT_MS = 10_000;

/**
 * Runs the PLUGIN's resolver - not a second copy of the core's - and prints
 * one JSON line. Loading `config.py` by file location rather than importing
 * `plugins.hermes` keeps the probe to the module under comparison: a broken
 * bridge or a missing Hermes ABC must not be reported as a resolver
 * disagreement.
 */
const PLUGIN_RESOLVER_DRIVER = [
  "import importlib.util, json, sys",
  "spec = importlib.util.spec_from_file_location('o2b_hermes_config', sys.argv[1])",
  "mod = importlib.util.module_from_spec(spec)",
  "spec.loader.exec_module(mod)",
  "out = {'vault': None, 'error': None}",
  "try:",
  "    out['vault'] = mod.resolve_vault()",
  "except Exception as exc:",
  "    out['error'] = '%s: %s' % (type(exc).__name__, exc)",
  "sys.stdout.write(json.dumps(out))",
].join("\n");

export interface ResolverParityOptions {
  /** Config file both resolvers are pointed at. */
  readonly config?: string | null;
  /** Directory the project-pointer walk-up starts from. */
  readonly cwd?: string;
  /** Checkout that ships `plugins/hermes/`; defaults to this module's own. */
  readonly repoRoot?: string | null;
}

/** Either side's answer: a vault, or the reason there is no answer. */
interface ResolvedSide {
  readonly vault: string | null;
  /** Why this side could not answer; null when it did. */
  readonly undetermined: string | null;
}

/**
 * `<root>/plugins/hermes/config.py`, from an explicit checkout or from this
 * module's own position (`plugins/` ships in the npm package alongside
 * `src/`). Inside the bundled OpenClaw build `import.meta.dir` points at the
 * bundle instead, so the path does not exist and the check reports itself as
 * not applicable - which is correct there: OpenClaw hosts do not load the
 * Hermes plugin.
 */
/**
 * The plugin resolver to compare against, or null when this invocation did
 * not name a repository to check.
 *
 * An explicit root is REQUIRED, and that is the whole gate. `plugins/` ships
 * inside the published package, so falling back to the installed package root
 * made this check apply to every user of the CLI, including the large
 * majority who never wire the Hermes gateway. On a machine with no Python
 * interpreter that turned a plain `o2b doctor` into a permanent failure with
 * a fix line telling the operator to install Python for a plugin they do not
 * use. Every other plugin-surface check in this CLI is gated on `--repo` for
 * the same reason; this one now matches them.
 */
function pluginResolverPath(repoRoot: string | null | undefined): string | null {
  if (repoRoot === null || repoRoot === undefined || repoRoot === "") return null;
  return join(repoRoot, "plugins", "hermes", "config.py");
}

function resolveCoreSide(configPath: string, cwd: string): ResolvedSide {
  try {
    return { vault: resolveVault(configPath, { cwd }), undetermined: null };
  } catch (exc) {
    return { vault: null, undetermined: (exc as Error).message ?? String(exc) };
  }
}

function resolvePluginSide(resolver: string, configPath: string, cwd: string): ResolvedSide {
  const env = { ...process.env, OPEN_SECOND_BRAIN_CONFIG: configPath };
  let lastFailure = "no interpreter was tried";
  for (const { bin, args } of PYTHON_CANDIDATES) {
    const proc = spawnSync(bin, [...args, "-c", PLUGIN_RESOLVER_DRIVER, resolver], {
      cwd,
      env,
      encoding: "utf8",
      timeout: PLUGIN_RESOLVER_TIMEOUT_MS,
    });
    if (proc.error !== undefined) {
      // Only "this interpreter is not here" is worth trying the next name
      // for. Anything else - a hang killed by the timeout, a spawn refused -
      // is an answer about the interpreter that IS here.
      if ((proc.error as NodeJS.ErrnoException).code === "ENOENT") {
        lastFailure = `${bin}: ${proc.error.message}`;
        continue;
      }
      return { vault: null, undetermined: `${bin}: ${proc.error.message}` };
    }
    if (proc.status !== 0 && isWindowsStoreAliasStub(bin)) {
      lastFailure = `${bin}: only the Microsoft Store alias placeholder is installed`;
      continue;
    }
    if (proc.status !== 0) {
      const detail = (proc.stderr ?? "").trim().split("\n").at(-1) ?? "";
      return { vault: null, undetermined: `${bin} exited ${proc.status}: ${detail}` };
    }
    let parsed: { vault?: unknown; error?: unknown };
    try {
      parsed = JSON.parse(proc.stdout ?? "") as { vault?: unknown; error?: unknown };
    } catch {
      return { vault: null, undetermined: `${bin} printed no usable answer` };
    }
    if (typeof parsed.error === "string") {
      return { vault: null, undetermined: parsed.error };
    }
    return { vault: typeof parsed.vault === "string" ? parsed.vault : null, undetermined: null };
  }
  return { vault: null, undetermined: `no Python interpreter available (${lastFailure})` };
}

/**
 * Do the two vault resolvers - the TypeScript core's and the Hermes plugin's -
 * agree about this install?
 *
 * The whole of GitHub #130 was that they did not, and that nothing anywhere
 * compared them: `o2b doctor` validated the path IT resolved, the plugin
 * reported the path IT resolved, and a clean doctor coexisted with a "Needs
 * Setup" badge for five weeks without contradiction. This check exists to make
 * that disagreement impossible to hide.
 *
 * Three outcomes, never two. Agreement passes. Disagreement fails and prints
 * both answers. And a side that could not be MEASURED - no Python on the
 * machine, an interpreter that crashed, a config the core refuses to read -
 * fails with that reason, because reporting "clean" on an unmeasured half is
 * the same false confidence the check was written to remove.
 *
 * Returns null - the check does not apply - when this invocation named no
 * repository to check, or when the named repository has no Hermes plugin.
 */
export function checkHermesResolverParity(opts: ResolverParityOptions = {}): CheckResult | null {
  const resolver = pluginResolverPath(opts.repoRoot);
  if (resolver === null || !existsSync(resolver)) return null;

  const configPath = opts.config ?? defaultConfigPath();
  const cwd = opts.cwd ?? process.cwd();
  const core = resolveCoreSide(configPath, cwd);
  const plugin = resolvePluginSide(resolver, configPath, cwd);

  if (core.undetermined !== null && plugin.undetermined !== null) {
    return {
      name: RESOLVER_PARITY,
      ok: false,
      message:
        `neither resolver could answer for ${configPath}: ` +
        `core says ${core.undetermined}; plugin says ${plugin.undetermined}`,
      fix: `o2b doctor --config "${configPath}"`,
    };
  }
  if (core.undetermined !== null) {
    return {
      name: RESOLVER_PARITY,
      ok: false,
      message:
        `the core resolver could not determine a vault (${core.undetermined}), ` +
        `while the Hermes plugin resolved ${plugin.vault ?? "no vault"}`,
      fix: `chmod u+r "${configPath}"`,
    };
  }
  if (plugin.undetermined !== null) {
    return {
      name: RESOLVER_PARITY,
      ok: false,
      message:
        `the Hermes plugin resolver could not be measured (${plugin.undetermined}), ` +
        `so its agreement with the core (${core.vault ?? "no vault"}) is unknown`,
      fix: "install Python 3.11+ so the Hermes plugin resolver can be compared",
    };
  }
  if (core.vault !== plugin.vault) {
    return {
      name: RESOLVER_PARITY,
      ok: false,
      message:
        `vault resolvers disagree for ${configPath}: core resolves ` +
        `${core.vault ?? "no vault"}, Hermes plugin resolves ${plugin.vault ?? "no vault"}`,
      fix: "hermes open-second-brain config",
    };
  }
  return {
    name: RESOLVER_PARITY,
    ok: true,
    message:
      core.vault === null
        ? `both resolvers agree no vault is configured in ${configPath}`
        : `both resolvers agree on the vault: ${core.vault}`,
  };
}
