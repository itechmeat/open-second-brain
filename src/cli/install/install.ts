/**
 * `o2b install` CLI verb.
 *
 *   o2b install                          # detect-only table
 *   o2b install --json                   # detect-only as JSON
 *   o2b install --target X               # plan-only
 *   o2b install --target X --apply       # execute the plan
 *   o2b install --target X --check       # verify
 *   o2b install --check                  # verify every known target
 *   o2b install --target generic --out <p|->     # generic adapter only
 *   o2b install --target generic --format json|yaml
 *
 * Exit codes ({@link INSTALL_EXIT}):
 *   0  success / no drift
 *   1  I/O / runtime error
 *   2  usage error (unknown target, bad flag)
 *   3  --check found drift
 *   4  user-modified-block conflict on apply (use --force to override)
 *   5  --check found a runtime it proved unreachable
 *
 * Code 5 exists because 0 was wrong. `--check` used to exit 0 for both
 * `not-installed` and `mcp-unreachable`, so `o2b install --check` reported
 * success for a runtime whose own adapter had just failed to reach it -
 * the one verify state backed by a live query rather than a file read.
 * The two are not the same answer and no longer share a code.
 */

import { homedir } from "node:os";

import { parseFlags } from "../argparse.ts";
import { defaultConfigPath, discoverConfig } from "../../core/config.ts";
import { defaultRegistry } from "../../core/install/registry.ts";
// The canonical adapter set registers itself into `defaultRegistry` at
// module-load time via this barrel (single source of the adapter list).
import "../../core/install/adapters/all.ts";

import { buildPayload, PayloadError } from "../../core/install/payload.ts";
import { InstallError } from "../../core/install/types.ts";
import type { ApplyOpts, InstallEnv, VerifyResult } from "../../core/install/types.ts";
import {
  renderApplyJson,
  renderApplyResult,
  renderDetectJson,
  renderDetectTable,
  renderPlan,
  renderVerifyJson,
  renderVerifyTable,
} from "./render.ts";

/**
 * Every code this verb can return, named once so the docblock above, the
 * returns below and the tests all read the same table.
 */
export const INSTALL_EXIT = Object.freeze({
  ok: 0,
  runtimeError: 1,
  usage: 2,
  drift: 3,
  userModifiedBlock: 4,
  mcpUnreachable: 5,
} as const);

interface ParsedInstallArgs {
  readonly target: string | null;
  readonly apply: boolean;
  readonly check: boolean;
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly json: boolean;
  readonly out: string | null;
  readonly format: "json" | "yaml" | null;
  readonly vault: string | null;
  readonly config: string;
}

function parseInstallArgs(argv: string[]): ParsedInstallArgs {
  const { flags } = parseFlags(argv, {
    target: { type: "string" },
    apply: { type: "boolean" },
    check: { type: "boolean" },
    "dry-run": { type: "boolean" },
    force: { type: "boolean" },
    json: { type: "boolean" },
    out: { type: "string" },
    format: { type: "string" },
    vault: { type: "string" },
    config: { type: "string" },
  });
  const fmtRaw = flags["format"] as string | undefined;
  let format: "json" | "yaml" | null = null;
  if (fmtRaw) {
    if (fmtRaw !== "json" && fmtRaw !== "yaml") {
      throw new UsageError(`--format must be json or yaml, got: ${fmtRaw}`);
    }
    format = fmtRaw;
  }
  return {
    target: (flags["target"] as string | undefined) ?? null,
    apply: Boolean(flags["apply"]),
    check: Boolean(flags["check"]),
    dryRun: Boolean(flags["dry-run"]),
    force: Boolean(flags["force"]),
    json: Boolean(flags["json"]),
    out: (flags["out"] as string | undefined) ?? null,
    format,
    vault: (flags["vault"] as string | undefined) ?? null,
    config: (flags["config"] as string | undefined) ?? defaultConfigPath(),
  };
}

class UsageError extends Error {}

function buildInstallEnv(args: ParsedInstallArgs): InstallEnv {
  const cfg = discoverConfig(args.config).data;
  const vault = args.vault ?? cfg["vault"] ?? process.env["VAULT_DIR"] ?? "";
  const env = { ...process.env } as Record<string, string>;
  if (cfg["agent_name"]) env["VAULT_AGENT_NAME"] = cfg["agent_name"];
  if (cfg["timezone"]) env["VAULT_TIMEZONE"] = cfg["timezone"];
  return {
    vault,
    home: homedir(),
    cwd: process.cwd(),
    env,
    now: new Date(),
  };
}

function buildApplyOpts(
  args: ParsedInstallArgs,
  stdout: NodeJS.WriteStream,
  stderr: NodeJS.WriteStream,
): ApplyOpts {
  return {
    dryRun: args.dryRun,
    force: args.force,
    stdout,
    stderr,
    ...(args.out !== null ? { outPath: args.out } : {}),
    ...(args.format !== null ? { format: args.format } : {}),
  };
}

function loadPayload(args: ParsedInstallArgs, env: InstallEnv) {
  const cfg = discoverConfig(args.config).data;
  const vault = env.vault || cfg["vault"];
  if (!vault) {
    throw new UsageError(
      "o2b install: vault not configured. Pass --vault <path>, set VAULT_DIR, or run `o2b init`.",
    );
  }
  return buildPayload({
    vault,
    agent_name: cfg["agent_name"] ?? process.env["VAULT_AGENT_NAME"] ?? null,
    timezone: cfg["timezone"] ?? process.env["VAULT_TIMEZONE"] ?? null,
  });
}

export async function cmdInstall(argv: string[]): Promise<number> {
  let args: ParsedInstallArgs;
  try {
    args = parseInstallArgs(argv);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`error: ${e.message}\n`);
      return INSTALL_EXIT.usage;
    }
    throw e;
  }

  // `--check` is its own mode — runs verify per target.
  if (args.check) return runCheck(args);

  // No --target → detect-only mode.
  if (!args.target) return runDetect(args);

  // --target X with or without --apply.
  return runTarget(args);
}

function runDetect(args: ParsedInstallArgs): number {
  const env = buildInstallEnv(args);
  const results = defaultRegistry.detectAll(env);
  if (args.json) {
    process.stdout.write(renderDetectJson(results));
  } else {
    process.stdout.write(renderDetectTable(results));
  }
  return INSTALL_EXIT.ok;
}

function runTarget(args: ParsedInstallArgs): number {
  const adapter = defaultRegistry.get(args.target!);
  if (!adapter) {
    process.stderr.write(
      `error: unknown --target: ${args.target}. ` +
        `Available: ${defaultRegistry.targets().join(", ")}\n`,
    );
    return INSTALL_EXIT.usage;
  }
  const env = buildInstallEnv(args);
  let payload;
  try {
    payload = loadPayload(args, env);
  } catch (e) {
    if (e instanceof UsageError) {
      process.stderr.write(`error: ${e.message}\n`);
      return INSTALL_EXIT.usage;
    }
    if (e instanceof PayloadError) {
      process.stderr.write(`error: ${e.message}\n`);
      return INSTALL_EXIT.usage;
    }
    throw e;
  }

  const opts = buildApplyOpts(
    args,
    process.stdout as NodeJS.WriteStream,
    process.stderr as NodeJS.WriteStream,
  );

  const plan = adapter.plan(payload, env);

  // Plan-only (no --apply, no --check) — print and return.
  if (!args.apply) {
    if (args.json) {
      process.stdout.write(JSON.stringify({ schema_version: 1, plan }, null, 2) + "\n");
    } else {
      process.stdout.write(renderPlan(plan));
    }
    return INSTALL_EXIT.ok;
  }

  try {
    const result = adapter.apply(plan, payload, env, opts);
    if (args.json) {
      process.stdout.write(renderApplyJson(result));
    } else {
      process.stdout.write(renderApplyResult(result));
    }
    return INSTALL_EXIT.ok;
  } catch (e) {
    if (e instanceof InstallError && e.kind === "user-modified-block") {
      process.stderr.write(`error: ${e.message}\n`);
      if (e.hint) process.stderr.write(`hint: ${e.hint}\n`);
      return INSTALL_EXIT.userModifiedBlock;
    }
    if (e instanceof InstallError) {
      process.stderr.write(`error: ${e.message}\n`);
      if (e.hint) process.stderr.write(`hint: ${e.hint}\n`);
      return INSTALL_EXIT.runtimeError;
    }
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return INSTALL_EXIT.runtimeError;
  }
}

function runCheck(args: ParsedInstallArgs): number {
  const env = buildInstallEnv(args);
  // `verify()` reads the per-vault sidecar manifest. With an unset vault,
  // every adapter would silently report "not-installed" off a bogus path
  // and the operator gets no signal that the vault is unconfigured.
  if (!env.vault) {
    process.stderr.write(
      "error: vault not configured. Pass --vault <path>, set VAULT_DIR, or run `o2b init`.\n",
    );
    return INSTALL_EXIT.usage;
  }
  const targets = args.target
    ? defaultRegistry.get(args.target)
      ? [defaultRegistry.get(args.target)!]
      : []
    : defaultRegistry.list();
  if (args.target && targets.length === 0) {
    process.stderr.write(
      `error: unknown --target: ${args.target}. ` +
        `Available: ${defaultRegistry.targets().join(", ")}\n`,
    );
    return INSTALL_EXIT.usage;
  }
  const results: VerifyResult[] = [];
  for (const a of targets) results.push(a.verify(env));
  if (args.json) {
    process.stdout.write(renderVerifyJson(results));
  } else {
    process.stdout.write(renderVerifyTable(results));
  }
  return exitCodeForVerify(results);
}

/**
 * The exit code a `--check` run over `results` earns.
 *
 * Drift outranks unreachable deliberately, and the order is the operator's
 * repair order rather than a severity ranking: a runtime may be unreachable
 * BECAUSE its config drifted, so re-running `--apply` is the first move and
 * a liveness verdict taken over a wrong config means nothing. `not-installed`
 * stays 0 - the operator never asked for that runtime - which is exactly the
 * bucket `mcp-unreachable` was wrongly sharing.
 *
 * Exported for the exit-code tests: `mcp-unreachable` is reachable only from
 * an adapter that shells out to a runtime CLI, which a CLI-level test cannot
 * stage without also staging that runtime.
 */
export function exitCodeForVerify(results: ReadonlyArray<VerifyResult>): number {
  if (results.some((r) => r.status === "drift")) return INSTALL_EXIT.drift;
  if (results.some((r) => r.status === "mcp-unreachable")) return INSTALL_EXIT.mcpUnreachable;
  return INSTALL_EXIT.ok;
}
