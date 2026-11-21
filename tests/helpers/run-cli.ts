/**
 * Test helper: run the `o2b` CLI as a subprocess and capture stdout/stderr/code.
 *
 * Each invocation gets an isolated `OPEN_SECOND_BRAIN_CONFIG` so init-tests
 * never clobber the developer's `~/.config/open-second-brain/config.yaml`.
 * Tests that explicitly want to verify default-config behavior can pass their
 * own value in `env`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, posix, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../../src/cli/main.ts";
import { PARTNER_CODEGRAPH_DISABLED_ENV } from "../../src/core/config.ts";
import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { CLI_CHILD_LIMIT_MS, EXIT_DRAIN_GRACE_MS, KILL_REAP_MS } from "./cli-timeout.ts";
import { DEFAULT_STORE_ROOT_ENV } from "./test-store.ts";
import { diskProbeLines, stallProbeDirs } from "./stall-probe.ts";
import {
  OS_PROBE_LIMIT_MS,
  windowsDescendants,
  windowsProcessAfterKill,
  windowsProcessState,
} from "./windows-process-probe.ts";

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly returncode: number;
  /**
   * Set only when the child exited but its output pipes stayed open past a
   * short grace period (a process it started holds them); says which and
   * for how long. The same line goes to this process's stderr.
   */
  readonly warning?: string;
}

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..");
const CLI_ENTRY = join(ROOT, "src", "cli", "main.ts");

/**
 * Env vars that the CLI reads for vault / identity / timezone resolution
 * AND `OPEN_SECOND_BRAIN_CONFIG` itself. Each one MUST start unset in tests
 * unless the caller passes it explicitly — the developer's shell almost
 * certainly has `VAULT_AGENT_NAME`, `OPEN_SECOND_BRAIN_CONFIG`, etc. pointing
 * at their real vault / persisted config; if we let those leak into the
 * child process, init-tests can write to the real `~/.config/open-second-brain/`
 * instead of a per-test sandbox.
 */
const RUNTIME_OVERRIDABLE_ENV = [
  "VAULT_DIR",
  "VAULT_AGENT_NAME",
  "VAULT_TIMEZONE",
  "OPEN_SECOND_BRAIN_CONFIG",
  "OPEN_SECOND_BRAIN_TRIGGER_COOLDOWN_DAYS",
  "OPEN_SECOND_BRAIN_WIKI_LINK_FORMAT",
  "OPEN_SECOND_BRAIN_RECALL_GATE_TELEMETRY",
  "OPEN_SECOND_BRAIN_BENCH_JUDGE_CMD",
  "OPEN_SECOND_BRAIN_POST_COMPACT_SURVIVAL_AUDIT",
  // Search-lane selection. `resolveSearchConfig` reads these straight off
  // `process.env`, so a developer with semantic search configured ran a
  // DIFFERENT pipeline than CI - against a remote embedding provider -
  // and every "deterministic and network-free" claim in the tree was a
  // property of an unset shell rather than of the code.
  "OPEN_SECOND_BRAIN_SEARCH_SEMANTIC",
  "OPEN_SECOND_BRAIN_EMBEDDING_PROVIDER",
  // The optional decision model: a developer who enabled it in the shell
  // must not turn a network-free test into one that calls an endpoint.
  "OPEN_SECOND_BRAIN_DECISION_MODEL_ENABLED",
  "OPEN_SECOND_BRAIN_DECISION_MODEL_PROVIDER",
  "OPEN_SECOND_BRAIN_DECISION_MODEL_BASE_URL",
  "OPEN_SECOND_BRAIN_DECISION_MODEL_ID",
  "OPEN_SECOND_BRAIN_DECISION_MODEL_ENV_KEY",
  "OPEN_SECOND_BRAIN_DECISION_MODEL_ALLOW_INSECURE_HTTP",
  "OPEN_SECOND_BRAIN_DECISION_MODEL_TIMEOUT_MS",
  "OPEN_SECOND_BRAIN_DECISION_MODEL_HOOK_BUDGET_MS",
  "OPEN_SECOND_BRAIN_DECISION_MODEL_MAX_STATE_TOKENS",
  "OPEN_SECOND_BRAIN_DECISION_MODEL_USES",
  "OPEN_SECOND_BRAIN_DECISION_MODEL_COST_GATE_USD",
  "OPEN_SECOND_BRAIN_DECISION_MODEL_INPUT_PRICE_USD_PER_MTOK",
  "OPEN_SECOND_BRAIN_DECISION_MODEL_ALLOW_UNCALIBRATED",
  // The codegraph partner switch, for the same reason and with a default
  // of its own below.
  PARTNER_CODEGRAPH_DISABLED_ENV,
  // The secret store's environment unlock is consumed-once; a developer
  // shell that happens to carry it must not turn a locked-store test into
  // an unlocked one (or steal the value mid-run).
  "OPEN_SECOND_BRAIN_SECRETS_PASSPHRASE",
  // Lesson-promotion scope selection (t_1e952e43). A developer shell
  // carrying an enabled scope must not silently flip the promotion gate
  // in every lessons CLI test.
  "OPEN_SECOND_BRAIN_LESSONS_PROMOTION_SCOPES",
] as const;

export interface RunCliOptions {
  readonly env?: Record<string, string>;
  readonly stdin?: string;
  readonly cwd?: string;
  /**
   * Force a fresh child process instead of the in-process fast path. The
   * in-process path imports `main()` once and calls it directly - two orders of
   * magnitude cheaper than spawning `bun run src/cli/main.ts` per call (that
   * re-parses and re-evaluates the whole CLI import graph every time). Set this
   * only when a test genuinely needs OS-level process isolation (real stdin, a
   * long-running server command, signal handling). Passing `stdin` implies it.
   */
  readonly subprocess?: boolean;
  /**
   * The longest a spawned child may run (default {@link CLI_CHILD_LIMIT_MS}).
   * Only the subprocess path has one; a caller whose test timeout is
   * shorter than `CLI_SPAWN_BUDGET_MS` passes
   * `cliChildLimitFor(<its timeout>)` (`cli-timeout.ts`).
   */
  readonly limitMs?: number;
}

/** The XDG bases and where a POSIX home puts each when it is unset. */
const XDG_HOME_DEFAULTS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["XDG_CONFIG_HOME", [".config"]],
  ["XDG_CACHE_HOME", [".cache"]],
  ["XDG_STATE_HOME", [".local", "state"]],
  ["XDG_DATA_HOME", [".local", "share"]],
];

/** The Windows app-data bases and where a profile puts each when it is unset. */
const WINDOWS_HOME_DEFAULTS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ["LOCALAPPDATA", ["AppData", "Local"]],
  ["APPDATA", ["AppData", "Roaming"]],
];

/**
 * The per-user bases a `runCli` caller's environment leaves to the home
 * fallback, named under the HOME it sandboxes, or a refusal when it
 * sandboxes none.
 *
 * Bun fixes `os.homedir()` when the process starts, so an in-process run
 * cannot move it: a base the caller leaves to the home fallback would
 * resolve to the developer's REAL home in-process while a child given the
 * caller's HOME resolves it under the sandbox. Naming each such base under
 * the caller's HOME gives both modes the child's answer.
 *
 * - POSIX: an XDG base passed empty, and the config base when not passed
 *   at all (the preload pins it to a root of the run, which a caller that
 *   sandboxes HOME means to replace), go under HOME.
 * - Windows (`src/core/platform-dirs.ts`): every base is an exported XDG
 *   variable, else `%LOCALAPPDATA%`, which the preload pins, so an emptied
 *   XDG base already lands in the run's app-data root. What falls back to
 *   the home there is `%LOCALAPPDATA%` or `%APPDATA%` passed empty: each
 *   goes under the caller's HOME (`USERPROFILE` when it passes that), and
 *   a `USERPROFILE` passed empty beside a HOME becomes that HOME.
 *
 * A base passed empty with no sandboxed home falls back to the developer's
 * real home in either mode, and the real-home guard sees the entries and
 * control-file changes such a run leaves, not what it reads, so that is
 * refused. `XDG_CACHE_HOME` is among them: the signal dedup cache
 * (`src/core/brain/dedup-index-cache.ts`) lives under it when its own
 * variable is unset or empty. So is `USERPROFILE` passed empty on Windows,
 * the home itself.
 */
export function perUserSandbox(
  callerEnv: Readonly<Record<string, string>>,
  platform: string = process.platform,
): Record<string, string> {
  const windows = platform === "win32";
  const pathJoin = windows ? win32.join : posix.join;
  const home = windows
    ? (nonEmptyValue(callerEnv["USERPROFILE"]) ?? nonEmptyValue(callerEnv["HOME"]))
    : nonEmptyValue(callerEnv["HOME"]);
  const bases = windows ? WINDOWS_HOME_DEFAULTS : XDG_HOME_DEFAULTS;
  if (home === null) {
    const homeVars = windows ? ["USERPROFILE"] : [];
    const emptied = [...bases.map(([name]) => name), ...homeVars].filter(
      (n) => callerEnv[n] === "",
    );
    if (emptied.length > 0) {
      throw new Error(
        `runCli: ${emptied.join(", ")} passed empty without a HOME resolves to the real ` +
          "home directory; pass HOME (a temp dir) with it",
      );
    }
    return {};
  }
  const out: Record<string, string> = {};
  if (windows && callerEnv["USERPROFILE"] === "") out["USERPROFILE"] = home;
  for (const [name, parts] of bases) {
    const passed = callerEnv[name];
    if (passed === "" || (!windows && passed === undefined && name === "XDG_CONFIG_HOME")) {
      out[name] = pathJoin(home, ...parts);
    }
  }
  return out;
}

function nonEmptyValue(value: string | undefined): string | null {
  return value !== undefined && value.length > 0 ? value : null;
}

/**
 * The real `process.env` on Windows is case-insensitive: the variable the
 * OS calls `Path` answers to `process.env.PATH`, which is how the product
 * reads it. The in-process runner swaps in a plain object copy, which is
 * case-SENSITIVE, so without this fold every `process.env["PATH"]` read in
 * the CLI saw `undefined` (snapshot tooling then reported `tar` missing),
 * and a caller's `PATH` override sat beside the inherited `Path` instead of
 * replacing it. Rename inherited `Path` to `PATH`, and drop any inherited
 * key that differs from a caller key only by case.
 */
function foldWindowsEnvCase(env: Record<string, string>, callerEnv: Record<string, string>): void {
  for (const key of Object.keys(env)) {
    if (key !== "PATH" && key.toUpperCase() === "PATH") {
      if (!("PATH" in env)) env["PATH"] = env[key] as string;
      delete env[key];
    }
  }
  const callerUpper = new Set(Object.keys(callerEnv).map((k) => k.toUpperCase()));
  for (const key of Object.keys(env)) {
    if (callerUpper.has(key.toUpperCase()) && !(key in callerEnv)) delete env[key];
  }
}

/**
 * Compute the child environment the caller's overrides produce, mirroring the
 * process-level resolution the CLI performs from `process.env`.
 */
function resolveEnv(callerEnv: Record<string, string>): {
  env: Record<string, string>;
  cleanupDir: string | null;
} {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  for (const key of RUNTIME_OVERRIDABLE_ENV) {
    if (!(key in callerEnv)) delete env[key];
  }
  if (process.platform === "win32") foldWindowsEnvCase(env, callerEnv);
  Object.assign(env, callerEnv);
  // A caller that sandboxes HOME means "the user's home directory". On
  // Windows `os.homedir()` answers from USERPROFILE and ignores HOME, so
  // without this mirror an install test wrote the operator's real
  // `%USERPROFILE%\.cursor\mcp.json` instead of the temp home it named.
  if (process.platform === "win32" && "HOME" in callerEnv && !("USERPROFILE" in callerEnv)) {
    env["USERPROFILE"] = callerEnv["HOME"] as string;
  }
  Object.assign(env, perUserSandbox(callerEnv));
  // `o2b doctor` consults the codegraph partner by spawning a third-party
  // CLI once per discovered project whenever that binary is on PATH. The
  // suite runs from this repo, which IS such a project, so the check ran
  // for real on any developer machine with codegraph installed and did not
  // run at all on CI, where the binary is absent - the suite's cost and its
  // dependency on a foreign tool were both properties of the machine. On
  // this workstation that was 96.0 s for `tests/cli/cli.test.ts` against
  // 1.1 s with the partner left alone. Tests keep the switch ON by default
  // and the partner check has its own coverage that calls `doctor()`
  // directly; a caller that wants the real consultation passes the key.
  if (!(PARTNER_CODEGRAPH_DISABLED_ENV in env)) env[PARTNER_CODEGRAPH_DISABLED_ENV] = "true";
  let cleanupDir: string | null = null;
  if (!("OPEN_SECOND_BRAIN_CONFIG" in env)) {
    cleanupDir = mkdtempSync(join(tmpdir(), "o2b-test-"));
    env["OPEN_SECOND_BRAIN_CONFIG"] = join(cleanupDir, "isolated-config.yaml");
  }
  // `o2b init` creates the brain store (design D14 item 1). A run that
  // still names the preload's shared default root gets a root of its own,
  // removed with the run, so one test's store never leaks into another.
  // A caller (or a test that set the variable itself) keeps its root.
  const sharedRoot = env[DEFAULT_STORE_ROOT_ENV];
  if (
    !(STORE_ROOT_ENV in callerEnv) &&
    sharedRoot !== undefined &&
    env[STORE_ROOT_ENV] === sharedRoot
  ) {
    cleanupDir ??= mkdtempSync(join(tmpdir(), "o2b-test-"));
    env[STORE_ROOT_ENV] = join(cleanupDir, "store");
  }
  return { env, cleanupDir };
}

/**
 * The current directory, or null when the process no longer has one.
 *
 * `process.cwd()` throws ENOENT once the directory it names is deleted,
 * which happens routinely in a suite that chdirs into temp vaults and
 * removes them. A run does not need to know where it started to work; only
 * the restore does, and it can honestly do nothing when there is nowhere
 * to return to.
 */
function currentDirectoryOrNull(): string | null {
  try {
    return process.cwd();
  } catch {
    return null;
  }
}

/** A `process.stdout.write`-shaped sink that appends decoded chunks to `sink`. */
function captureWrite(sink: (s: string) => void) {
  return (chunk: unknown, ...rest: unknown[]): boolean => {
    sink(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
    const cb = rest[rest.length - 1];
    if (typeof cb === "function") (cb as () => void)();
    return true;
  };
}

/** A stream being read into a sink, and the way to stop reading it. */
interface Drain {
  readonly done: Promise<void>;
  /** Whether end-of-file has arrived. */
  readonly ended: () => boolean;
  /** Stops reading and closes the pipe, so its writers see it closed. */
  readonly cancel: () => void;
}

/** Appends a stream's decoded text to `sink` as it arrives. */
function drain(stream: ReadableStream<Uint8Array>, sink: (s: string) => void): Drain {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let ended = false;
  const pump = (): Promise<void> =>
    reader.read().then((chunk) => {
      if (chunk.done) {
        ended = true;
        sink(decoder.decode());
        return undefined;
      }
      sink(decoder.decode(chunk.value, { stream: true }));
      return pump();
    });
  return {
    done: pump(),
    ended: () => ended,
    cancel: () => {
      reader.cancel().catch(() => undefined);
    },
  };
}

/** Resolves `"late"` after `ms`; `clear` cancels the timer. */
function lateAfter(ms: number): { readonly late: Promise<"late">; readonly clear: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<"late">((done) => {
    timer = setTimeout(() => done("late"), ms);
  });
  return { late, clear: () => clearTimeout(timer) };
}

export interface SpawnWithLimitOptions {
  readonly env: Record<string, string>;
  readonly cwd?: string;
  /** Written to the child's stdin, then closed; absent, stdin is ignored. */
  readonly stdin?: string;
  readonly limitMs: number;
}

/**
 * Runs `cmd` to completion and captures its output, but never longer than
 * `limitMs`: a child still running then is killed, and the call fails with
 * the command line, the elapsed time, when its last output arrived and the
 * stdout and stderr captured so far. A child that hangs (seen on the
 * Windows runner) thus fails its test with evidence instead of a bare test
 * timeout. No retry.
 *
 * The child's exit decides, not end-of-file on its pipes: a process the
 * child started can inherit the pipes and keep them open long after the
 * child is gone. After the exit the pipes get {@link EXIT_DRAIN_GRACE_MS}
 * to deliver what is buffered; a pipe still open then is closed on this
 * side, and the result carries a `warning` (also written to this process's
 * stderr) naming the open pipes, so a leaked handle is seen, not hidden.
 * The readers are stopped with a limit failure too, so they never outlive
 * the call. The failure says whether the disk under each temp folder
 * still answers a flushed write (`stall-probe.ts`): the hangs seen on the
 * Windows runner came with a stalled disk. On Windows it also names the
 * child's state from the operating system at the limit, its live
 * descendants with their command lines (the processes that can hold its
 * pipes) and whether it is gone after the kill (`windows-process-probe.ts`).
 */
export async function spawnWithLimit(
  cmd: ReadonlyArray<string>,
  opts: SpawnWithLimitOptions,
): Promise<RunResult> {
  const started = Date.now();
  const proc = Bun.spawn([...cmd], {
    cwd: opts.cwd ?? ROOT,
    env: opts.env,
    stdin: opts.stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  let stdout = "";
  let stderr = "";
  let lastOutputAt: number | null = null;
  const outputAt = (): void => {
    lastOutputAt = Date.now();
  };
  const drains = [
    drain(proc.stdout, (s) => {
      if (s !== "") outputAt();
      stdout += s;
    }),
    drain(proc.stderr, (s) => {
      if (s !== "") outputAt();
      stderr += s;
    }),
  ];
  const stopReading = (): void => {
    for (const d of drains) d.cancel();
  };
  const output = Promise.all(drains.map((d) => d.done));
  // A reader's failure surfaces after the exit, where `output` is awaited.
  output.catch(() => undefined);
  const run = (async (): Promise<number> => {
    if (opts.stdin !== undefined && proc.stdin !== undefined) {
      proc.stdin.write(opts.stdin);
      await proc.stdin.end();
    }
    return await proc.exited;
  })();
  const limit = lateAfter(opts.limitMs);
  let outcome: number | "late";
  try {
    outcome = await Promise.race([run, limit.late]);
  } catch (err) {
    // A failed run (stdin delivery) must not leave the child running
    // without its limit.
    proc.kill("SIGKILL");
    stopReading();
    throw err;
  } finally {
    limit.clear();
  }
  if (outcome !== "late") return await afterExit(outcome);
  const elapsedMs = Date.now() - started;
  const windows = process.platform === "win32";
  // The probes run side by side, each bounded by the one probe limit the
  // failure path has room for (`cli-timeout.ts`).
  const [atLimit, descendants, disks] = await Promise.all([
    windows ? windowsProcessState(proc.pid, started) : null,
    windows ? windowsDescendants(proc.pid) : null,
    diskProbeLines(stallProbeDirs(), OS_PROBE_LIMIT_MS),
  ]);
  proc.kill("SIGKILL");
  await Promise.race([proc.exited, new Promise((r) => setTimeout(r, KILL_REAP_MS))]);
  const afterKill = windows
    ? windowsProcessAfterKill(proc.pid, proc.exitCode ?? proc.signalCode)
    : null;
  stopReading();
  // Keep the run's late rejection (if any) from surfacing unhandled.
  run.catch(() => undefined);
  const lastOutput: number | null = lastOutputAt;
  throw new Error(
    [
      `CLI child still running after the ${opts.limitMs} ms per-call limit: killed.`,
      `command: ${cmd.map((part) => JSON.stringify(part)).join(" ")}`,
      `cwd: ${opts.cwd ?? ROOT}`,
      `pid: ${proc.pid}, elapsed ${elapsedMs} ms, exit after kill: ${proc.exitCode ?? "not reaped"}, stdin: ${opts.stdin === undefined ? "ignored" : `${opts.stdin.length} chars, closed`}`,
      // Output that arrived after the limit (during the probe and the
      // kill) means a slow child, not a stuck one.
      `last output: ${lastOutput === null ? "none" : `${lastOutput - started} ms after the spawn`}`,
      ...(atLimit === null ? [] : [atLimit]),
      ...(descendants === null ? [] : [descendants]),
      ...disks,
      ...(afterKill === null ? [] : [afterKill]),
      `--- stdout so far (${stdout.length} chars) ---`,
      stdout,
      `--- stderr so far (${stderr.length} chars) ---`,
      stderr,
    ].join("\n"),
  );

  /** The result once the child exited, with at most a short wait for its pipes. */
  async function afterExit(returncode: number): Promise<RunResult> {
    const grace = lateAfter(EXIT_DRAIN_GRACE_MS);
    let drained: void[] | "late";
    try {
      drained = await Promise.race([output, grace.late]);
    } finally {
      grace.clear();
    }
    if (drained !== "late") return { stdout, stderr, returncode };
    const open = [drains[0]?.ended() ? null : "stdout", drains[1]?.ended() ? null : "stderr"]
      .filter((name): name is string => name !== null)
      .join(" and ");
    stopReading();
    const warning =
      `${open} still open ${EXIT_DRAIN_GRACE_MS} ms after the child exited with ${returncode}: ` +
      "a process it started holds the pipe; the result is returned without waiting for it";
    process.stderr.write(
      `spawnWithLimit: ${warning}\ncommand: ${cmd.map((part) => JSON.stringify(part)).join(" ")}\n`,
    );
    return { stdout, stderr, returncode, warning };
  }
}

/** Fresh-process invocation - the original behavior, kept for isolation cases. */
async function runCliSubprocess(
  args: ReadonlyArray<string>,
  opts: RunCliOptions,
): Promise<RunResult> {
  const { env, cleanupDir } = resolveEnv(opts.env ?? {});
  let result: RunResult;
  try {
    result = await spawnWithLimit(["bun", "run", CLI_ENTRY, ...args], {
      env,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts.stdin !== undefined ? { stdin: opts.stdin } : {}),
      limitMs: opts.limitMs ?? CLI_CHILD_LIMIT_MS,
    });
  } catch (err) {
    // After a killed child (Windows keeps its files busy for a moment) a
    // failed cleanup must not replace the evidence.
    if (cleanupDir !== null) {
      try {
        rmSync(cleanupDir, { recursive: true, force: true });
      } catch {
        // the evidence below matters more than the temp directory
      }
    }
    throw err;
  }
  if (cleanupDir !== null) rmSync(cleanupDir, { recursive: true, force: true });
  return result;
}

/**
 * In-process invocation: apply the resolved env + cwd, capture stdout/stderr,
 * call `main()`, then restore everything. `main()` never calls `process.exit`
 * (that lives behind its `import.meta.main` guard) and returns an exit code, so
 * a direct call is a faithful black-box of the full parse + dispatch path. An
 * uncaught throw is mapped to code 1 with the message on stderr, matching how a
 * crashing child process would surface.
 */
/**
 * In-process runs mutate process-wide state - the environment, the working
 * directory, and both output streams - and restore it in a `finally`. Two
 * overlapping runs therefore capture each other’s swapped state as their
 * "saved" state and restore the wrong thing, which leaves a test-scoped
 * config path installed for the rest of the process and misroutes captured
 * output. The corruption surfaces far away, in an unrelated later file, as
 * a vault that cannot be found.
 *
 * So overlapping is refused rather than survived. A caller that genuinely
 * needs concurrency passes `subprocess: true`, which owns none of this
 * state.
 */
let inProcessRunActive = false;

/** Thrown when a second in-process CLI run starts while one is still open. */
export class ConcurrentInProcessRunError extends Error {
  constructor(args: ReadonlyArray<string>) {
    super(
      `runCli(${JSON.stringify(args)}) started while another in-process run was ` +
        "still open. In-process runs swap process.env, the working directory and " +
        "both output streams, so they cannot overlap: await each run, or pass " +
        "{ subprocess: true } for the ones that must run concurrently.",
    );
    this.name = "ConcurrentInProcessRunError";
  }
}

async function runCliInProcess(
  args: ReadonlyArray<string>,
  opts: RunCliOptions,
): Promise<RunResult> {
  if (inProcessRunActive) throw new ConcurrentInProcessRunError(args);
  inProcessRunActive = true;
  // Everything from here to the outer `finally` runs under the flag,
  // setup included. An earlier version claimed the flag only while the CLI
  // itself ran, which left `resolveEnv` and `process.cwd()` outside it -
  // and `process.cwd()` throws ENOENT when the directory a test removed is
  // still the process's own, which is routine in a suite that builds and
  // deletes temp vaults. A throw there left the flag raised for the rest of
  // the process and every later run failed blaming a concurrency that never
  // happened, which is the same misdirected report this guard exists to
  // stop.
  let savedEnv: NodeJS.ProcessEnv | null = null;
  let savedCwd: string | null = null;
  let realOut: typeof process.stdout.write | null = null;
  let realErr: typeof process.stderr.write | null = null;
  let cleanupDir: string | null = null;
  let stdout = "";
  let stderr = "";
  try {
    const resolved = resolveEnv(opts.env ?? {});
    cleanupDir = resolved.cleanupDir;
    savedEnv = process.env;
    // A cwd that no longer exists is not an error here: the run is about to
    // chdir anyway, and only the restore needs somewhere to go back to.
    savedCwd = currentDirectoryOrNull();
    realOut = process.stdout.write.bind(process.stdout);
    realErr = process.stderr.write.bind(process.stderr);
    process.env = resolved.env;
    try {
      process.chdir(opts.cwd ?? ROOT);
    } catch {
      // A caller cwd that does not exist would also fail a subprocess spawn.
    }
    process.stdout.write = captureWrite((s) => (stdout += s)) as typeof process.stdout.write;
    process.stderr.write = captureWrite((s) => (stderr += s)) as typeof process.stderr.write;
    let returncode: number;
    try {
      returncode = await main(args);
    } catch (err) {
      stderr += `${(err as Error)?.stack ?? String(err)}\n`;
      returncode = 1;
    }
    return { stdout, stderr, returncode };
  } finally {
    if (realOut !== null) process.stdout.write = realOut;
    if (realErr !== null) process.stderr.write = realErr;
    if (savedEnv !== null) process.env = savedEnv;
    if (savedCwd !== null) {
      try {
        process.chdir(savedCwd);
      } catch {
        /* restore best-effort */
      }
    }
    if (cleanupDir !== null) rmSync(cleanupDir, { recursive: true, force: true });
    inProcessRunActive = false;
  }
}

export async function runCli(
  args: ReadonlyArray<string>,
  opts: RunCliOptions = {},
): Promise<RunResult> {
  // Real stdin or an explicit isolation request needs a child process; every
  // other command runs in-process for speed.
  if (opts.subprocess === true || opts.stdin !== undefined) {
    return runCliSubprocess(args, opts);
  }
  return runCliInProcess(args, opts);
}
