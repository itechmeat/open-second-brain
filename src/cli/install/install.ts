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
 *   o2b install --friction                       # capability matrix, every runtime
 *   o2b install --friction --target X            # one runtime
 *   o2b install --friction --base A --compare B  # only what differs
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
import { defaultConfigPath, discoverConfig, resolveVault } from "../../core/config.ts";
import { defaultRegistry } from "../../core/install/registry.ts";
// The canonical adapter set registers itself into `defaultRegistry` at
// module-load time via this barrel (single source of the adapter list).
import "../../core/install/adapters/all.ts";

import { buildPayload, PayloadError } from "../../core/install/payload.ts";
import {
  buildFrictionMatrix,
  diffFrictionRows,
  FRICTION_DIMENSIONS,
  frictionRowFor,
  type FrictionInput,
} from "../../core/install/friction.ts";
import { isInstallTargetId, type InstallTargetId } from "../../core/runtime/host-facts.ts";
import { renderDataOwnership } from "../../core/install/ownership.ts";
import type { DataOwnership } from "../../core/install/ownership.ts";
import { measureDataOwnership } from "../../core/install/ownership-measure.ts";
import { InstallError } from "../../core/install/types.ts";
import type { ApplyOpts, InstallEnv, VerifyResult } from "../../core/install/types.ts";
import {
  renderApplyJson,
  renderApplyResult,
  renderDetectJson,
  renderDetectTable,
  renderFrictionDiff,
  renderFrictionDiffJson,
  renderFrictionJson,
  renderFrictionTable,
  renderPlan,
  renderPlanJson,
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
  readonly friction: boolean;
  readonly base: string | null;
  readonly compare: string | null;
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
    friction: { type: "boolean" },
    base: { type: "string" },
    compare: { type: "string" },
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
    friction: Boolean(flags["friction"]),
    base: (flags["base"] as string | undefined) ?? null,
    compare: (flags["compare"] as string | undefined) ?? null,
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

/**
 * The vault this verb installs FOR, resolved through the one chain the
 * rest of the CLI uses.
 *
 * `--vault` comes first because it is the operator naming the directory in
 * the same breath as the command; everything below it is
 * {@link resolveVault} verbatim - `VAULT_DIR`, the project pointer, the
 * active profile, then the config `vault` key - so the path written into
 * an agent's MCP entry is the path every other verb operates on.
 *
 * This verb used to carry its own chain (`--vault` then the config key
 * then `VAULT_DIR`), which put `VAULT_DIR` LAST where the canonical
 * resolver puts it FIRST and consulted neither pointers nor profiles. On a
 * machine with both settings the installer wrote one vault into the MCP
 * config while `o2b status` read another, and nothing reported the split.
 *
 * The absent case stays the empty string rather than `null`: every caller
 * here refuses it by name (`runCheck`, {@link loadPayload}) and an
 * `InstallEnv.vault` is typed `string`.
 */
export function resolveInstallVault(explicitVault: string | null, configPath: string): string {
  return explicitVault ?? resolveVault(configPath) ?? "";
}

/**
 * The `InstallEnv` every adapter on this run is handed.
 *
 * `OPEN_SECOND_BRAIN_CONFIG` is stamped from the resolved `--config` so
 * that ONE file parameterises the whole run. It did not used to be: the
 * agent name, timezone and vault came from `--config`, while
 * `install_hook_timeout_seconds` and `mcp_tool_profile` were read by
 * `installSettingsSource` out of `~/.config/open-second-brain/config.yaml`
 * because `InstallEnv` carried no config path and the resolver fell back
 * to the machine default. On a box with both files populated, `--apply`
 * generated from one and `--check` verified against the other. Publishing
 * the choice as the variable `resolveDefaultConfigPath` already consults
 * first keeps a single override in a single place, and keeps `InstallEnv`
 * the complete description of the run it is documented to be.
 */
function buildInstallEnv(args: ParsedInstallArgs): InstallEnv {
  const cfg = discoverConfig(args.config).data;
  const vault = resolveInstallVault(args.vault, args.config);
  const env = { ...process.env } as Record<string, string>;
  env["OPEN_SECOND_BRAIN_CONFIG"] = args.config;
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
  // `env.vault` is already {@link resolveInstallVault}'s answer, and that
  // chain ends on the same `vault` config key this used to re-read as a
  // fallback. Keeping the second read would mean an empty `env.vault`
  // could still produce a payload built against a key the canonical
  // resolver had just declined - a third precedence, in one function.
  const vault = env.vault;
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

/**
 * The data-ownership close, for a run that established something.
 *
 * Built here rather than inside a renderer so BOTH surfaces consume one
 * value: the human block and the `data_ownership` JSON field are two views
 * of this record, which is what stops them being added separately - the
 * failure mode the install verb already had, where the human `--check`
 * table is pinned byte-for-byte against the install documents and the JSON
 * twin was pinned by nothing.
 *
 * Every measurement the statement needs is taken by
 * {@link measureDataOwnership}, which the onboarding checklist calls too -
 * the two surfaces cannot disagree about where the index landed or which
 * outbound integrations are configured, because they ask the same
 * function. This verb supplies only what it alone owns: the resolved vault
 * and the live adapter registry.
 */
function ownershipFor(env: InstallEnv, configPath: string): DataOwnership {
  return measureDataOwnership({
    vault: env.vault,
    configPath,
    adapterTargets: defaultRegistry.targets(),
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

  // `--friction` is a report over the registry rather than an operation
  // on one target, so it is settled before `--target` is read as "act on
  // this runtime".
  if (args.friction) return runFriction(args);

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

/**
 * Refuse a runtime nobody registered, by name and with the spelling.
 *
 * One function because three flags now accept a target, and an operator
 * who mistyped one is owed the same answer whichever they mistyped.
 */
function refuseUnknownTarget(flag: string, value: string): number {
  process.stderr.write(
    `error: unknown ${flag}: ${value}. Available: ${defaultRegistry.targets().join(", ")}\n`,
  );
  return INSTALL_EXIT.usage;
}

/**
 * The registered target `value` names, or `null`.
 *
 * Both halves are required: the registry answers whether an adapter
 * exists, the guard answers whether the id is a member of the closed
 * vocabulary the fact table is keyed by. A value that passes one and not
 * the other is the contradiction
 * `tests/core/architecture/host-facts-census.test.ts` exists to prevent,
 * and it is refused here rather than indexed into the table.
 */
function resolveTarget(value: string): InstallTargetId | null {
  if (defaultRegistry.get(value) === undefined) return null;
  return isInstallTargetId(value) ? value : null;
}

/**
 * `o2b install --friction` - what each host costs, side by side.
 *
 * A report, so it never returns a non-zero code for what it FOUND: the
 * matrix has no notion of a bad answer, only of an honest one. The only
 * refusals are usage refusals, and each one names the flag and the
 * spelling it wanted.
 */
function runFriction(args: ParsedInstallArgs): number {
  const wantsDiff = args.base !== null || args.compare !== null;
  if (wantsDiff && args.target !== null) {
    process.stderr.write(
      "error: --friction takes either --target <t> or --base <a> --compare <b>, not both\n",
    );
    return INSTALL_EXIT.usage;
  }
  if (wantsDiff && (args.base === null || args.compare === null)) {
    const missing = args.base === null ? "--base" : "--compare";
    process.stderr.write(
      `error: --friction diff needs both --base and --compare; ${missing} is missing\n`,
    );
    return INSTALL_EXIT.usage;
  }
  for (const [flag, value] of [
    ["--target", args.target],
    ["--base", args.base],
    ["--compare", args.compare],
  ] as const) {
    if (value !== null && resolveTarget(value) === null) return refuseUnknownTarget(flag, value);
  }

  const env = buildInstallEnv(args);
  let payload;
  try {
    payload = loadPayload(args, env);
  } catch (e) {
    if (e instanceof UsageError || e instanceof PayloadError) {
      process.stderr.write(`error: ${e.message}\n`);
      return INSTALL_EXIT.usage;
    }
    throw e;
  }
  const input: FrictionInput = { env, payload, adapters: defaultRegistry.list() };

  if (wantsDiff) {
    const diff = diffFrictionRows(
      frictionRowFor(resolveTarget(args.base!)!, input),
      frictionRowFor(resolveTarget(args.compare!)!, input),
    );
    process.stdout.write(args.json ? renderFrictionDiffJson(diff) : renderFrictionDiff(diff));
    return INSTALL_EXIT.ok;
  }

  const matrix =
    args.target === null
      ? buildFrictionMatrix(input)
      : {
          dimensions: FRICTION_DIMENSIONS,
          rows: [frictionRowFor(resolveTarget(args.target)!, input)],
        };
  process.stdout.write(args.json ? renderFrictionJson(matrix) : renderFrictionTable(matrix));
  return INSTALL_EXIT.ok;
}

function runTarget(args: ParsedInstallArgs): number {
  const adapter = defaultRegistry.get(args.target!);
  if (!adapter) return refuseUnknownTarget("--target", args.target!);
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
      process.stdout.write(renderPlanJson(plan));
    } else {
      process.stdout.write(renderPlan(plan));
    }
    return INSTALL_EXIT.ok;
  }

  try {
    const result = adapter.apply(plan, payload, env, opts);
    // An apply that returned changed the machine, so the close fires
    // unconditionally here - unlike verify, where exit 0 also covers a
    // runtime nobody installed.
    const ownership = ownershipFor(env, args.config);
    if (args.json) {
      process.stdout.write(renderApplyJson(result, ownership));
    } else {
      process.stdout.write(renderApplyResult(result));
      process.stdout.write(renderDataOwnership(ownership));
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
  // Exit 0 is NOT the trigger. `not-installed` is also 0, deliberately -
  // the operator never asked for that runtime - so a close fired on the
  // code would be the entire output of a run where the install did
  // nothing, congratulating an operator on a brain nothing points at.
  const ownership = results.some((r) => r.status === "ok") ? ownershipFor(env, args.config) : null;
  if (args.json) {
    process.stdout.write(renderVerifyJson(results, ownership));
  } else {
    process.stdout.write(renderVerifyTable(results));
    if (ownership !== null) process.stdout.write(renderDataOwnership(ownership));
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
