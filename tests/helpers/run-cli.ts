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
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { main } from "../../src/cli/main.ts";

export interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly returncode: number;
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
  Object.assign(env, callerEnv);
  let cleanupDir: string | null = null;
  if (!("OPEN_SECOND_BRAIN_CONFIG" in env)) {
    cleanupDir = mkdtempSync(join(tmpdir(), "o2b-test-"));
    env["OPEN_SECOND_BRAIN_CONFIG"] = join(cleanupDir, "isolated-config.yaml");
  }
  return { env, cleanupDir };
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

/** Fresh-process invocation - the original behavior, kept for isolation cases. */
async function runCliSubprocess(
  args: ReadonlyArray<string>,
  opts: RunCliOptions,
): Promise<RunResult> {
  const { env, cleanupDir } = resolveEnv(opts.env ?? {});
  try {
    const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
      cwd: opts.cwd ?? ROOT,
      env,
      stdin: opts.stdin === undefined ? "ignore" : "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    if (opts.stdin !== undefined && proc.stdin !== undefined) {
      proc.stdin.write(opts.stdin);
      await proc.stdin.end();
    }
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const returncode = await proc.exited;
    return { stdout, stderr, returncode };
  } finally {
    if (cleanupDir !== null) rmSync(cleanupDir, { recursive: true, force: true });
  }
}

/**
 * In-process invocation: apply the resolved env + cwd, capture stdout/stderr,
 * call `main()`, then restore everything. `main()` never calls `process.exit`
 * (that lives behind its `import.meta.main` guard) and returns an exit code, so
 * a direct call is a faithful black-box of the full parse + dispatch path. An
 * uncaught throw is mapped to code 1 with the message on stderr, matching how a
 * crashing child process would surface.
 */
async function runCliInProcess(
  args: ReadonlyArray<string>,
  opts: RunCliOptions,
): Promise<RunResult> {
  const { env, cleanupDir } = resolveEnv(opts.env ?? {});
  const savedEnv = process.env;
  const savedCwd = process.cwd();
  let stdout = "";
  let stderr = "";
  const realOut = process.stdout.write.bind(process.stdout);
  const realErr = process.stderr.write.bind(process.stderr);
  process.env = env;
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
  } finally {
    process.stdout.write = realOut;
    process.stderr.write = realErr;
    process.env = savedEnv;
    try {
      process.chdir(savedCwd);
    } catch {
      /* restore best-effort */
    }
    if (cleanupDir !== null) rmSync(cleanupDir, { recursive: true, force: true });
  }
  return { stdout, stderr, returncode };
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
