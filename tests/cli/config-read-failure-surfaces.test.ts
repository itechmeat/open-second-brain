/**
 * What an OPERATOR sees when the plugin config is present but unreadable.
 *
 * `ConfigReadError` is raised deep in the config reader, which is the right
 * place to detect the condition and the wrong place to report it. These
 * tests own the reporting end: every assertion here is about what escapes
 * the command line, so they spawn `o2b` rather than calling `main()`. The
 * in-process runner maps an uncaught throw to "code 1 with the stack on
 * stderr", which is indistinguishable from a handled refusal - exactly the
 * confusion that let the raw crash ship.
 *
 * Three properties, together, are what the operator needs:
 *
 *   - a FORMATTED refusal (one `error:` line naming the file and the way
 *     out), not a source excerpt and a stack;
 *   - a STABLE exit code - 1, the environment-error code this command line
 *     already uses for `no vault configured`, distinct from 2 for a usage
 *     error;
 *   - on a `--json` surface, PARSEABLE JSON on stdout, because a machine
 *     consumer cannot read the stderr prose and empty stdout is not a
 *     result.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CLI_ENTRY = join(REPO_ROOT, "src", "cli", "main.ts");

/** A config an operator could plausibly have written. */
const VALID_CONFIG = `vault: "/srv/example-vault"\nagent_name: "someone"\n`;

/** Bun prints an unhandled throw as a numbered source excerpt plus frames. */
const SOURCE_EXCERPT_RE = /^\s*\d+ \|/m;
const STACK_FRAME_RE = /^\s+at .+ \(.*:\d+:\d+\)$/m;

interface RunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exit: number;
}

let tmp: string;
let configPath: string;
let vault: string;

/**
 * Spawn `o2b` with an env built from scratch. Nothing is inherited beyond
 * `PATH`, so the developer's `O2B_DEVICE_ID` / `VAULT_DIR` / real config
 * cannot decide the outcome, and `HOME` points inside the sandbox.
 */
async function runO2b(args: string[], env: Record<string, string> = {}): Promise<RunResult> {
  const proc = Bun.spawn(["bun", "run", CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      PATH: process.env["PATH"] ?? "",
      HOME: tmp,
      OPEN_SECOND_BRAIN_CONFIG: configPath,
      ...env,
    },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exit = await proc.exited;
  return { stdout, stderr, exit } satisfies RunResult;
}

/** Run `args` with the config file unreadable, restoring the mode after. */
async function withUnreadableConfig(
  args: string[],
  env: Record<string, string> = {},
): Promise<RunResult> {
  chmodSync(configPath, 0o000);
  try {
    return await runO2b(args, env);
  } finally {
    chmodSync(configPath, 0o600);
  }
}

/** Every refusal below must be a formatted one, never a raw crash. */
function expectFormattedRefusal(result: RunResult): void {
  expect(result.stderr).toMatch(/^error: /);
  expect(result.stderr).toContain(configPath);
  expect(result.stderr).not.toMatch(SOURCE_EXCERPT_RE);
  expect(result.stderr).not.toMatch(STACK_FRAME_RE);
  expect(result.stderr).not.toContain("ConfigReadError:");
  expect(result.exit).toBe(1);
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-config-read-cli-"));
  configPath = join(tmp, "config.yaml");
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  writeFileSync(configPath, VALID_CONFIG, "utf8");
});

afterEach(() => {
  chmodSync(configPath, 0o600);
  rmSync(tmp, { recursive: true, force: true });
});

describe("an unreadable plugin config is a named refusal, not a crash", () => {
  /**
   * `doctor` is the worst case and the reason this matters: its whole job
   * is diagnosing this condition, and it can - see the companion test
   * below. Only the unhandled raise on the way in destroyed the report.
   */
  test("doctor refuses by name instead of printing a stack", async () => {
    const result = await withUnreadableConfig(["doctor"]);
    expectFormattedRefusal(result);
  });

  test("status refuses by name instead of printing a stack", async () => {
    const result = await withUnreadableConfig(["status"]);
    expectFormattedRefusal(result);
  });

  test("secrets list refuses by name instead of printing a stack", async () => {
    const result = await withUnreadableConfig(["secrets", "list"]);
    expectFormattedRefusal(result);
  });

  test("export-config refuses by name instead of printing a stack", async () => {
    const result = await withUnreadableConfig([
      "export-config",
      "--output",
      join(tmp, "exported.json"),
    ]);
    expectFormattedRefusal(result);
  });

  /**
   * The refusal is not merely formatted, it is actionable: it says the file
   * is present (so its settings are NOT in force and were not read as
   * absent) and names both ways out.
   */
  test("the refusal names the remedy, not only the failure", async () => {
    const result = await withUnreadableConfig(["doctor"]);
    expect(result.stderr).toContain("OPEN_SECOND_BRAIN_CONFIG");
    expect(result.stderr).toContain("chmod");
  });

  /**
   * The exit code is the environment-error code, matching `no vault
   * configured` - a broken config file is a fact about the machine, not a
   * mistake in the argv. 2 stays reserved for usage errors.
   */
  test("the exit code is the environment-error code, not the usage one", async () => {
    const broken = await withUnreadableConfig(["doctor"]);
    const noVault = await runO2b(["doctor"], {
      OPEN_SECOND_BRAIN_CONFIG: join(tmp, "absent.yaml"),
    });
    const usage = await runO2b(["completions", "not-a-shell"]);
    expect(broken.exit).toBe(noVault.exit);
    expect(usage.exit).toBe(2);
  });

  /**
   * The diagnosis the crash destroyed. With the vault supplied explicitly
   * nothing resolves through the broken file on the way in, and `doctor`
   * reports the condition as a check with a fix line - which is what the
   * refusal above now points the operator at.
   */
  test("doctor --vault still diagnoses the same file as a failed check", async () => {
    const result = await withUnreadableConfig(["doctor", "--vault", vault]);
    expect(result.stdout).toContain("[FAIL] config_writeable");
    expect(result.stdout).toContain(configPath);
    expect(result.stdout).toContain("fix:");
  });
});

describe("machine consumers get JSON, never empty stdout", () => {
  /**
   * `status --json` renders its own payload, so it is never wrapped in the
   * `withJsonFallback` envelope: without a handler of its own a consumer
   * got empty stdout plus a stack trace.
   */
  test("status --json emits parseable JSON naming the unreadable file", async () => {
    const result = await withUnreadableConfig(["status", "--json"]);
    expect(result.exit).toBe(1);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload["config_path"]).toBe(configPath);
    expect(String(payload["error"])).toContain(configPath);
  });

  /**
   * A command whose JSON IS the envelope: the fallback has no catch of its
   * own, so a throw escaped it and printed no envelope at all. Handling the
   * error inside the dispatch restores it.
   */
  test("the --json envelope survives for a command that does not own its JSON", async () => {
    const result = await withUnreadableConfig([
      "export-config",
      "--output",
      join(tmp, "exported.json"),
      "--json",
    ]);
    const payload = JSON.parse(result.stdout) as Record<string, unknown>;
    expect(payload["ok"]).toBe(false);
    expect(String(payload["stderr"])).toContain(configPath);
  });
});

/**
 * Identity resolution (Finding 3). With `VAULT_DIR` set, nothing upstream
 * has opened the config, so the first read is the device-id lookup inside
 * the claim shard path. It raises - deliberately, because the alternative
 * is minting a fresh device id and persisting it over a config we could
 * not read - and the operator has to be able to see why.
 */
describe("identity resolution surfaces the same file, actionably", () => {
  test("brain truth ingest names the unreadable config and exits non-zero", async () => {
    const result = await withUnreadableConfig(
      [
        "brain",
        "truth",
        "ingest",
        "--entity",
        "a",
        "--aspect",
        "b",
        "--value",
        "c",
        "--source",
        "s",
      ],
      { VAULT_DIR: vault },
    );
    expect(result.exit).not.toBe(0);
    expect(result.stderr).toContain(configPath);
    expect(result.stderr).toContain("OPEN_SECOND_BRAIN_CONFIG");
    expect(result.stderr).not.toMatch(SOURCE_EXCERPT_RE);
    expect(result.stderr).not.toMatch(STACK_FRAME_RE);
  });

  /** And it wrote nothing: no claim shard, no rewritten config. */
  test("nothing is written when identity cannot be resolved", async () => {
    await withUnreadableConfig(
      [
        "brain",
        "truth",
        "ingest",
        "--entity",
        "a",
        "--aspect",
        "b",
        "--value",
        "c",
        "--source",
        "s",
      ],
      { VAULT_DIR: vault },
    );
    const result = await runO2b(["status"], {});
    expect(result.stdout).toContain("config_exists: true");
    expect(Bun.file(join(vault, "Brain", "truth", "claims.jsonl")).size).toBe(0);
  });
});
