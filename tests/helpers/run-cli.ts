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
] as const;

export async function runCli(
  args: ReadonlyArray<string>,
  opts: { env?: Record<string, string>; stdin?: string; cwd?: string } = {},
): Promise<RunResult> {
  const callerEnv = opts.env ?? {};
  // Build the child env from process.env, then strip any runtime-resolution
  // env that the caller did not explicitly pass. The caller's passed values
  // — including empty strings — are honoured verbatim.
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
