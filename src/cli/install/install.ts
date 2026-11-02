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
 *   6  apply refused for want of consent in non-interactive mode (use --yes)
 *
 * Code 5 exists because 0 was wrong. `--check` used to exit 0 for both
 * `not-installed` and `mcp-unreachable`, so `o2b install --check` reported
 * success for a runtime whose own adapter had just failed to reach it -
 * the one verify state backed by a live query rather than a file read.
 * The two are not the same answer and no longer share a code.
 */

import { parseFlags } from "../argparse.ts";
import { ok } from "../output.ts";
import { readSingleLine } from "../brain/helpers.ts";
import type { LaneConsentVerdict } from "../../core/brain/diagnostics.ts";
import { defaultConfigPath, discoverConfig, resolveVault } from "../../core/config.ts";
import { defaultRegistry } from "../../core/install/registry.ts";
import { VAULT_NOT_CONFIGURED_REASON, buildInstallEnv } from "../../core/install/env.ts";
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
import { InstallError, type InstallPlan, type InstallStep } from "../../core/install/types.ts";
import type { ApplyOpts, InstallEnv, VerifyResult } from "../../core/install/types.ts";
import {
  applyInstructionBlock,
  instructionBlockTargetFor,
  planInstructionBlock,
} from "../../core/install/instruction-block.ts";
import type { InstructionBlockPlan } from "../../core/install/instruction-block.ts";
import { RULES_BLOCK_ERROR_KIND, RulesBlockError } from "../../core/install/rules-block.ts";
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
  consentRefused: 6,
} as const);

interface ParsedInstallArgs {
  readonly target: string | null;
  readonly apply: boolean;
  readonly yes: boolean;
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
    yes: { type: "boolean" },
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
    yes: Boolean(flags["yes"]),
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
 * The `InstallEnv` this run's adapters see.
 *
 * The construction itself lives in `core/install/env.ts`, shared with
 * the MCP `second_brain_wiring` hosts view so the two surfaces cannot
 * describe different machines. This wrapper is the CLI's argument
 * resolution: `--vault` then the canonical resolver, and the `--config`
 * the whole run is parameterised by.
 */
function installEnvForArgs(args: ParsedInstallArgs): InstallEnv {
  return buildInstallEnv({
    vault: resolveInstallVault(args.vault, args.config),
    configPath: args.config,
  });
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
  return await runTarget(args);
}

function runDetect(args: ParsedInstallArgs): number {
  const env = installEnvForArgs(args);
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

  const env = installEnvForArgs(args);
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

/**
 * The instruction step a target's plan gains, or null when the target
 * installs no agent-instruction file (a named skip renders as a
 * postNote instead, see {@link augmentPlanWithInstructionStep}).
 *
 * The step rides the same `runTarget` lane the adapter writes do - one
 * plan render, ONE consent verdict above both writes, one apply - so
 * there is nothing new to consent to twice (t_ba41a78a B3). The kind is
 * the existing `managed-block` member; no new step vocabulary.
 */
function instructionStepFor(
  env: InstallEnv,
  target: InstallTargetId,
): { step: InstallStep; plan: InstructionBlockPlan } | null {
  if (instructionBlockTargetFor(target) === null) return null;
  const plan = planInstructionBlock(env, target);
  const preview =
    plan.changed === true
      ? `install the Open Second Brain write-gate managed block in ${plan.path}` +
        (plan.note === null ? "" : ` (${plan.note})`)
      : `${plan.path} already carries the current write-gate managed block (no change)`;
  const step: InstallStep = {
    kind: "managed-block",
    path: plan.path,
    preview,
    ...(plan.diff !== "" ? { diff: plan.diff } : {}),
  };
  return { step, plan };
}

/**
 * Append the instruction step (or its named skip) to a rendered plan.
 * Pure over the given plan: the original plan still goes to the adapter,
 * and the augmented copy is what the operator consents to.
 */
function augmentPlanWithInstructionStep(
  plan: InstallPlan,
  target: InstallTargetId,
  step: InstallStep | null,
): InstallPlan {
  if (step === null) {
    return {
      ...plan,
      postNotes: [
        ...plan.postNotes,
        `instruction block: skipped for ${target} - the host reads no agent-instruction file in HOST_INSTRUCTION_PRECEDENCE`,
      ],
    };
  }
  return { ...plan, steps: [...plan.steps, step] };
}

async function runTarget(args: ParsedInstallArgs): Promise<number> {
  const adapter = defaultRegistry.get(args.target!);
  if (!adapter) return refuseUnknownTarget("--target", args.target!);
  const env = installEnvForArgs(args);
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

  // t_ba41a78a B3: the instruction step rides this lane. The pure plan
  // computes now (reads only); the apply below re-derives it from the
  // live disk and refuses if the bytes moved since this render, so what
  // the operator consents to is exactly what gets written. A refusal at
  // plan time (a symbolic link, malformed markers, an unreadable file)
  // must be the named error, never an unhandled rejection: nothing has
  // been consented to or written yet, so the run ends here with the
  // named message and the runtime exit.
  let instruction: ReturnType<typeof instructionStepFor>;
  try {
    instruction = instructionStepFor(env, args.target as InstallTargetId);
  } catch (e) {
    if (e instanceof RulesBlockError) {
      process.stderr.write(`error: ${e.message}\n`);
      return INSTALL_EXIT.runtimeError;
    }
    throw e;
  }
  const renderedPlan =
    instruction === null
      ? augmentPlanWithInstructionStep(plan, args.target as InstallTargetId, null)
      : augmentPlanWithInstructionStep(plan, args.target as InstallTargetId, instruction.step);

  // Plan-only (no --apply, no --check) — print and return.
  if (!args.apply) {
    if (args.json) {
      process.stdout.write(renderPlanJson(renderedPlan));
    } else {
      process.stdout.write(renderPlan(renderedPlan));
    }
    return INSTALL_EXIT.ok;
  }

  // t_b6bcd984: fail-closed consent above the write lane, the canonical
  // ladder of `brain upgrade --apply`. Without --yes, a --json or
  // non-TTY run refuses before anything is written (the drift guard
  // below still fires on an explicit yes); an interactive run sees the
  // plan with the file diff and is asked once. A consent gate sits
  // above the write guard and never gates dry runs - this path only
  // runs with --apply.
  if (!args.yes) {
    if (args.json || !process.stdin.isTTY) {
      const refusal =
        `error: o2b install --target ${args.target} --apply requires --yes in ` +
        "non-interactive mode (--json or non-TTY stdin); nothing was written";
      // M4: under --json the refusal is a JSON envelope on the payload
      // stream carrying the reserved `headless-refused` verdict, so a
      // headless consumer reads the answer from the channel it parses.
      if (args.json) {
        process.stdout.write(
          JSON.stringify(
            { consent: "headless-refused", written: false, error: refusal.replace(/^error: /, "") },
            null,
            2,
          ) + "\n",
        );
      } else {
        process.stderr.write(refusal + "\n");
      }
      return INSTALL_EXIT.consentRefused;
    }
    // M15: the consent-time plan renders to stderr, where the prompt
    // already rides - stdout is the payload stream, and for
    // `--target generic --out -` the plan prefixed the snippet made it
    // unparsable. The header drops the dry-run wording: this render is
    // asking for apply consent, not previewing a dry run. The plain
    // print-only plan (no --apply) keeps its stdout dry-run render
    // below.
    process.stderr.write(renderPlan(renderedPlan, { consent: true }));
    process.stderr.write("Proceed? [y/N] ");
    const ans = await readSingleLine();
    if (ans.toLowerCase() !== "y" && ans.toLowerCase() !== "yes") {
      ok("install cancelled");
      return INSTALL_EXIT.ok;
    }
  }

  // M3: the verdict is derived from what happened, not hard-coded - a
  // `--yes` consent and an interactive yes stay distinguishable, in the
  // same vocabulary protect/unprotect/doctor record.
  const consent: LaneConsentVerdict = args.yes ? "yes-flag" : "interactive-yes";

  let instructionWrote = false;
  try {
    const result = adapter.apply(plan, payload, env, opts);
    // t_ba41a78a B3: the instruction write runs after the adapter apply,
    // under the SAME consent verdict - the prompt above covered both
    // writes. A refusal here (hand-edited block, preview drift, symlink)
    // leaves the adapter write in place and exits non-zero; a re-run
    // converges because the step is idempotent and bound to a fresh
    // plan. The approved binding is the plan this run rendered.
    if (instruction !== null) {
      const instructionResult = applyInstructionBlock(env, {
        dryRun: opts.dryRun,
        force: opts.force,
        approved: instruction.plan,
      });
      instructionWrote = instructionResult.backupPath !== null;
    }
    // An apply that returned changed the machine, so the close fires
    // unconditionally here - unlike verify, where exit 0 also covers a
    // runtime nobody installed.
    const ownership = ownershipFor(env, args.config);
    if (args.json) {
      process.stdout.write(renderApplyJson(result, ownership, consent));
    } else {
      process.stdout.write(renderApplyResult(result, consent));
      // The instruction write is invisible in the adapter's own summary
      // (its step count is the adapter's), so one line says what this
      // lane did with the operator's consent.
      if (instruction !== null && !opts.dryRun) {
        process.stdout.write(
          instructionWrote
            ? `instruction block: ${instruction.plan.path} now carries the write-gate block\n`
            : `instruction block: ${instruction.plan.path} already carries the current write-gate block\n`,
        );
      }
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
    // The instruction step's refusals ride the same exit vocabulary: a
    // hand-edited block IS a user-modified-block (exit 4, --force is the
    // documented override); every other kind is a named runtime error.
    if (e instanceof RulesBlockError) {
      process.stderr.write(`error: ${e.message}\n`);
      return e.kind === RULES_BLOCK_ERROR_KIND.userModifiedBlock
        ? INSTALL_EXIT.userModifiedBlock
        : INSTALL_EXIT.runtimeError;
    }
    process.stderr.write(`error: ${(e as Error).message}\n`);
    return INSTALL_EXIT.runtimeError;
  }
}

function runCheck(args: ParsedInstallArgs): number {
  const env = installEnvForArgs(args);
  // `verify()` reads the per-vault sidecar manifest. With an unset vault,
  // every adapter would silently report "not-installed" off a bogus path
  // and the operator gets no signal that the vault is unconfigured.
  if (!env.vault) {
    process.stderr.write(`error: ${VAULT_NOT_CONFIGURED_REASON}\n`);
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
