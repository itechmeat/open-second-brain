/**
 * Resolvability probe for a registered command's words (t_3477c9e8).
 *
 * Pure over its inputs, impure only where the question demands it: the
 * answer is read off the filesystem (`existsSync`) and out of the probe's
 * own environment (`PATH`, `PATHEXT`), both injectable so a test pins the
 * machine the verdict describes instead of inheriting the developer's.
 *
 * The three verdicts are graded, and the grading is the false-alarm bound
 * the design settles:
 *
 *   - `resolves` - the command word was found.
 *   - `absent`   - an ABSOLUTE path-form command word (or a resolved
 *     runner's absolute script argument) is PROVED not to exist on disk.
 *     Never a guess.
 *   - `unresolved` - a BARE name that this process's PATH does not carry,
 *     or a RELATIVE path form. This is deliberately not `absent`: the
 *     probe runs on the doctor's PATH and cwd, while the host client
 *     spawns the command with ITS OWN PATH and working directory, which
 *     may differ. An unresolved word therefore claims "could not confirm
 *     here", never "broken"; a relative word's detail still says what the
 *     doctor's own cwd holds.
 *
 * Windows bare names are probed through PATHEXT (the documented default
 * list when the variable is unset), because that is what the `cmd /d /c`
 * launcher written by {@link launcherCommand} searches. The probe never
 * searches the current directory for a bare name - the posture
 * `WINDOWS_LAUNCHER_ENV` (payload.ts) imposes on cmd.exe - so a file that
 * happens to share the name with the workspace the doctor ran from is not
 * a resolution.
 *
 * Two shapes written by this repo get interpretation rather than a raw
 * lookup: the Windows payload's `cmd /d /c <launcher>` prefix is stripped
 * with the same `cliArgs` rule the adapters use (an entry is judged on its
 * own shape, not the current platform), and a `run <path>` argument after
 * a resolved runner (grok registers `bun run <repo>/src/cli/main.ts`) is
 * checked as a file - ONE finding class whose detail says whether the
 * runner or the script is the leg that stopped resolving.
 */

import { existsSync } from "node:fs";
import { join, posix, win32 } from "node:path";

import { cliArgs, launcherCommand } from "./payload.ts";

// ----- Constants ------------------------------------------------------------

/**
 * PATHEXT's documented Windows default, used when the probed environment
 * does not set it. Extensions are tried in list order after the bare name.
 */
const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";

/** The argument word that makes `<runner> run <script>` a script launch. */
const RUNNER_RUN_WORD = "run";

/** The platform whose bare-name search rules (PATHEXT, `;` delimiter) apply. */
const WINDOWS_PLATFORM = "win32";

// ----- Errors ---------------------------------------------------------------

/** Raised for input a verdict cannot honestly describe. */
export class CommandProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CommandProbeError";
  }
}

// ----- Types ----------------------------------------------------------------

/** The closed verdict vocabulary. The docblock fixes what each member may claim. */
export const COMMAND_PROBE_VERDICT = Object.freeze({
  /** The command word (and, when applicable, its script) was found. */
  resolves: "resolves",
  /** A path-form word is proved not to exist on disk. */
  absent: "absent",
  /** A bare name this process's PATH does not carry. */
  unresolved: "unresolved",
} as const);

export type CommandProbeVerdict =
  (typeof COMMAND_PROBE_VERDICT)[keyof typeof COMMAND_PROBE_VERDICT];

/** One probe outcome: the verdict plus the evidence behind it. */
export interface CommandProbeOutcome {
  readonly verdict: CommandProbeVerdict;
  readonly detail: string;
}

export interface CommandProbeContext {
  /** Defaults to `process.platform`. */
  readonly platform?: string;
  /**
   * The environment the probe resolves against; defaults to `process.env`.
   * Only `PATH` and `PATHEXT` are read.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** cwd a relative path-form word is reported against; defaults to `process.cwd()`. */
  readonly cwd?: string;
}

interface ResolvedContext {
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
}

// ----- Probe ----------------------------------------------------------------

/**
 * Probe one registered command: `command` plus its leading `args`, exactly
 * as the client config records them. Throws {@link CommandProbeError} when
 * the command word is not a non-empty string - a verdict about an
 * unnameable command would be noise, so the caller gets a named refusal
 * instead.
 */
export function probeCommandResolvability(
  command: string,
  args: ReadonlyArray<string>,
  context: CommandProbeContext = {},
): CommandProbeOutcome {
  if (typeof command !== "string" || command.trim().length === 0) {
    throw new CommandProbeError("probeCommandResolvability: command word is empty or not a string");
  }
  const ctx: ResolvedContext = {
    platform: context.platform ?? process.platform,
    env: context.env ?? process.env,
    cwd: context.cwd ?? process.cwd(),
  };

  // The Windows payload registers `cmd /d /c <launcher> ...`. `cliArgs`
  // strips the prefix only when the entry's own shape carries the exact
  // `cmd /d /c o2b` head, so a shorter (stripped) tail proves the wrap -
  // and the word it removed is the launcher, the prefix's last word.
  const win = launcherCommand(WINDOWS_PLATFORM);
  const stripped = cliArgs({ command, args });
  if (stripped.length < args.length) {
    const launcher = win.prefix[win.prefix.length - 1]!;
    const inner = probeLauncherWord(launcher, stripped, ctx);
    return {
      verdict: inner.verdict,
      detail: `cmd /d /c launcher '${launcher}': ${inner.detail}`,
    };
  }
  return probeLauncherWord(command, args, ctx);
}

/**
 * Resolve one command word, then - only if the word itself resolved - check
 * whether a `run <path>` script argument exists. An unresolved runner stays
 * unresolved; adding a second verdict for a script the runner could not
 * have launched would report two findings for one registration.
 */
function probeLauncherWord(
  word: string,
  args: ReadonlyArray<string>,
  ctx: ResolvedContext,
): CommandProbeOutcome {
  const leg = probeWord(word, ctx);
  if (leg.verdict !== COMMAND_PROBE_VERDICT.resolves) return leg;
  const script = runnerScriptArgument(args, ctx);
  if (script === null) return leg;
  if (!isAbsoluteWord(script, ctx.platform)) {
    return {
      verdict: COMMAND_PROBE_VERDICT.unresolved,
      detail: `${leg.detail}; ${relativePathDetail(script, ctx)}`,
    };
  }
  if (existsSync(script)) {
    return {
      verdict: COMMAND_PROBE_VERDICT.resolves,
      detail: `${leg.detail}; script argument '${script}' exists`,
    };
  }
  return {
    verdict: COMMAND_PROBE_VERDICT.absent,
    detail: `${leg.detail}; script argument '${script}' does not exist`,
  };
}

function probeWord(word: string, ctx: ResolvedContext): CommandProbeOutcome {
  if (isPathForm(word, ctx.platform)) {
    if (!isAbsoluteWord(word, ctx.platform)) {
      return { verdict: COMMAND_PROBE_VERDICT.unresolved, detail: relativePathDetail(word, ctx) };
    }
    if (existsSync(word)) {
      return {
        verdict: COMMAND_PROBE_VERDICT.resolves,
        detail: `path '${word}' exists`,
      };
    }
    return {
      verdict: COMMAND_PROBE_VERDICT.absent,
      detail: `path '${word}' does not exist`,
    };
  }
  return probeBareName(word, ctx);
}

/**
 * The detail of a relative path form: the client resolves it from its own
 * working directory, which the probe cannot see, so what the doctor's cwd
 * holds is reported as context, never as the verdict.
 */
function relativePathDetail(word: string, ctx: ResolvedContext): string {
  const here = join(ctx.cwd, word);
  return (
    `relative path '${word}' resolves from the client's own working directory; ` +
    `under the probe cwd '${here}' ${existsSync(here) ? "exists" : "does not exist"}`
  );
}

/**
 * Search the probe's PATH - and only PATH - for the bare name. On the
 * Windows platform shape each PATHEXT extension is tried after the bare
 * name itself (so a name that already carries an extension resolves as
 * recorded). No match is `unresolved`: the client's spawn PATH may still
 * carry what this process's does not.
 */
function probeBareName(word: string, ctx: ResolvedContext): CommandProbeOutcome {
  const dirs = pathValue(ctx.env)
    .split(pathDelimiter(ctx.platform))
    .filter((d) => d.length > 0);
  const extensions = bareNameExtensions(ctx);
  for (const dir of dirs) {
    for (const ext of extensions) {
      const candidate = join(dir, `${word}${ext}`);
      if (existsSync(candidate)) {
        return {
          verdict: COMMAND_PROBE_VERDICT.resolves,
          detail: `bare name '${word}' resolves on the probe PATH at '${candidate}'`,
        };
      }
    }
  }
  return {
    verdict: COMMAND_PROBE_VERDICT.unresolved,
    detail:
      `bare name '${word}' is not on this probe's PATH - ` +
      "the host client's spawn PATH may still resolve it",
  };
}

function pathValue(env: Readonly<Record<string, string | undefined>>): string {
  const value = env["PATH"];
  return typeof value === "string" ? value : "";
}

function pathDelimiter(platform: string): string {
  return platform === WINDOWS_PLATFORM ? win32.delimiter : posix.delimiter;
}

function isAbsoluteWord(word: string, platform: string): boolean {
  return platform === WINDOWS_PLATFORM ? win32.isAbsolute(word) : posix.isAbsolute(word);
}

/** A word that names a location rather than something a PATH search finds. */
function isPathForm(word: string, platform: string): boolean {
  return word.includes("/") || word.includes("\\") || isAbsoluteWord(word, platform);
}

function bareNameExtensions(ctx: ResolvedContext): ReadonlyArray<string> {
  if (ctx.platform !== WINDOWS_PLATFORM) return [""];
  const raw = ctx.env["PATHEXT"];
  const list = typeof raw === "string" && raw.trim().length > 0 ? raw : DEFAULT_PATHEXT;
  return [
    "",
    ...list
      .split(";")
      .map((ext) => ext.trim())
      .filter((ext) => ext.length > 0),
  ];
}

/**
 * The script file a resolved runner would launch: `args[1]` of
 * `<runner> run <script>` when it is path-form. A bare word (`bun run dev`)
 * names a package script the runner resolves itself - not a file this
 * probe can judge - so it is left unchecked.
 */
function runnerScriptArgument(args: ReadonlyArray<string>, ctx: ResolvedContext): string | null {
  const second = args[1];
  if (args[0] !== RUNNER_RUN_WORD || typeof second !== "string") return null;
  if (!isPathForm(second, ctx.platform)) return null;
  return second;
}
