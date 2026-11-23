/**
 * `o2b dream run [--claim <token>] [--vault <path> | --no-vault]
 * [--config <file>] [--json]` (change `dream-session-trigger`, design
 * D3): the one command that runs a whole live dream pass and records its
 * day. The owner gate, the front door (the closed questions produced and
 * asked, the decision model executor, the dream agent executor), the pass
 * itself, then the outcome (`dream-trigger/outcome.ts`), all under one
 * deadline: the dream safeguard's, as the maintenance lane's dream task
 * spends it.
 *
 * With `--claim` it is the worker the dream day check started: it runs
 * only when the trigger's claim file holds that token, writes its pid
 * into the claim, takes the pass lock itself (as every pass does), and
 * removes the claim once the outcome is recorded (and keeps it when the
 * pass ran and its outcome could not be recorded, so the next check finds
 * a lost worker). Without it, it is the same pass run by hand, and it
 * holds the trigger's claim itself for the whole run: a claim another
 * run holds refuses it before the front door, naming the running pass.
 *
 * Exit codes: 0 when the pass ran, 1 when it failed or was refused (a
 * device that is not the owner, a claim this run does not hold, another
 * pass running), 2 on a usage error (the dispatcher's).
 *
 * `--no-vault` runs the pass on no vault, as a day check that served none
 * (an MCP server serving no vault) asks; without `--vault` or it, the
 * vault the machine config resolves to.
 */

import { discoverConfig, resolveVault } from "../../core/config.ts";
import { dream } from "../../core/brain/dream.ts";
import { assertDreamOwner, DreamNotOwnerError } from "../../core/brain/dream-owner/gate.ts";
import { adoptClaim, releaseClaim } from "../../core/brain/dream-trigger/claim.ts";
import {
  holdDreamRunClaim,
  recordDreamOutcomeResult,
  type DreamOutcomeRecording,
} from "../../core/brain/dream-trigger/outcome.ts";
import { isLockContention } from "../../core/store/local-lock.ts";
import {
  configuredTriggerStoreRoot,
  dreamTriggerClaimPath,
  dreamTriggerRecordPath,
  type DreamTriggerRecord,
} from "../../core/brain/dream-trigger/record.ts";
import {
  createSafeguard,
  OPERATION,
  resolveSafeguardTimeoutMs,
} from "../../core/brain/safeguard.ts";
import { decideBudgetWithin, prepareClosedQuestions } from "../../core/topics/decide-auto.ts";
import { CliError, parseFlags } from "../argparse.ts";
import { describeErrorChain } from "../brain/helpers.ts";
import { sortedReplacer } from "../helpers.ts";

export const DREAM_RUN_USAGE =
  "usage: o2b dream run [--claim <token>] [--vault <path> | --no-vault] [--config <file>] [--json]";

const EXIT = Object.freeze({ ok: 0, failed: 1 } as const);

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, sortedReplacer, 2)}\n`);
}

/** The day as a run reports it. */
function dayJson(record: DreamTriggerRecord | null): Record<string, unknown> | null {
  if (record === null) return null;
  return {
    day: record.day,
    closed: record.closed,
    reason: record.reason,
    retry_at: record.retry_at,
    failures: record.failures,
  };
}

function dayLine(record: DreamTriggerRecord | null): string {
  if (record === null) return "day: not recorded (this device does not keep the dream day)";
  if (record.closed) {
    return `day: ${record.day} closed${record.reason !== null ? ` (${record.reason})` : ""}`;
  }
  return `day: ${record.day} open (${record.reason}); next attempt after ${record.retry_at}`;
}

function refuse(json: boolean, message: string, extra: Record<string, unknown> = {}): number {
  if (json) writeJson({ ok: false, ...extra, error: message });
  process.stderr.write(`error: ${message}\n`);
  return EXIT.failed;
}

export async function cmdRun(argv: ReadonlyArray<string>): Promise<number> {
  const { flags, positional } = parseFlags(argv, {
    claim: { type: "string" },
    vault: { type: "string" },
    "no-vault": { type: "boolean" },
    config: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length > 0) throw new CliError(`unexpected argument: ${positional[0]}`);
  const configPath = flags["config"] as string | undefined;
  const json = flags["json"] === true;
  const token = flags["claim"] as string | undefined;
  if (token !== undefined && token.trim() === "") throw new CliError("--claim needs a token");
  const noVault = flags["no-vault"] === true;
  if (noVault && flags["vault"] !== undefined) {
    throw new CliError("--vault and --no-vault cannot be given together");
  }
  const configOpt = configPath !== undefined ? { configPath } : {};

  // The worker proves its claim before anything else and writes its pid
  // into it, so no check judges it lost while it lives: a stale or
  // foreign token runs nothing and leaves the claim to its holder.
  let claimPath: string | null = null;
  if (token !== undefined) {
    const storeRoot = configuredTriggerStoreRoot(discoverConfig(configPath));
    claimPath = dreamTriggerClaimPath(dreamTriggerRecordPath(storeRoot));
    if (!adoptClaim(claimPath, token)) {
      return refuse(json, "the dream trigger's claim does not hold this token; nothing was run", {
        reason: "claim-not-held",
      });
    }
  }
  // Run by hand, it holds the trigger's claim itself for the whole run,
  // so a session's day check does not start a worker beside it; a claim
  // another run holds refuses this one before anything of it runs.
  let releaseRunClaim = NO_RELEASE;
  if (token === undefined) {
    try {
      releaseRunClaim = holdDreamRunClaim(configPath);
    } catch (err) {
      if (!isLockContention(err)) throw err;
      return refuse(json, `dream failed: ${describeErrorChain(err)}`, { reason: "pass-running" });
    }
  }
  // The worker keeps its claim when the pass ran and its day could not be
  // recorded: the next day check finds it lost and backs off.
  let keepClaim = false;
  try {
    const ran = await runPass(
      noVault ? null : ((flags["vault"] as string | undefined) ?? resolveVault(configPath)),
      configOpt,
      json,
      token !== undefined ? "worker" : "cli",
    );
    keepClaim = ran.unrecorded;
    return ran.code;
  } finally {
    if (claimPath !== null && token !== undefined && !keepClaim) releaseClaim(claimPath, token);
    releaseRunClaim();
  }
}

const NO_RELEASE = (): void => {};

/** How a pass run ended: its exit code, and whether its day went unrecorded. */
function done(code: number, recording?: DreamOutcomeRecording): PassRun {
  return { code, unrecorded: recording?.kind === "failed" };
}

interface PassRun {
  readonly code: number;
  /** The pass ran and its day could not be recorded. */
  readonly unrecorded: boolean;
}

/** The record of a recording, and the failure named on the error stream. */
function recorded(recording: DreamOutcomeRecording): DreamTriggerRecord | null {
  if (recording.kind === "failed") {
    process.stderr.write(
      `warning: dream-day-unrecorded: the day of this pass could not be recorded: ${recording.message}\n`,
    );
  }
  return recording.kind === "recorded" ? recording.record : null;
}

async function runPass(
  vault: string | null,
  configOpt: { readonly configPath?: string },
  json: boolean,
  by: "worker" | "cli",
): Promise<PassRun> {
  const startedAt = new Date();
  try {
    assertDreamOwner(vault, { live: true, ...configOpt });
  } catch (err) {
    if (err instanceof DreamNotOwnerError) {
      return done(refuse(json, err.message, { code: err.code, reason: err.reason }));
    }
    throw err;
  }
  // One deadline for the whole run: the model work spends it first,
  // never more than its own budget, and the pass gets what is left.
  const safeguard = createSafeguard({
    operation: OPERATION.dream,
    timeoutMs: resolveSafeguardTimeoutMs(OPERATION.dream, configOpt.configPath),
  });
  const deadlineMs = decideBudgetWithin(safeguard.timeoutMs, 0);
  const closedQuestions =
    deadlineMs === 0
      ? undefined
      : await prepareClosedQuestions(vault, {
          ...configOpt,
          ...(deadlineMs !== undefined ? { deadlineMs } : {}),
        });
  let summary: ReturnType<typeof dream>;
  try {
    summary = dream(vault, {
      ...configOpt,
      ...(closedQuestions !== undefined ? { closedQuestions } : {}),
      safeguard,
    });
  } catch (err) {
    const recording = recordDreamOutcomeResult(vault, {
      ...configOpt,
      startedAt,
      result: { threw: err },
      by,
    });
    const day = recorded(recording);
    if (err instanceof DreamNotOwnerError) {
      return done(refuse(json, err.message, { code: err.code, reason: err.reason }), recording);
    }
    const message = `dream failed: ${describeErrorChain(err)}`;
    return done(refuse(json, message, { day: dayJson(day) }), recording);
  }
  const recording = recordDreamOutcomeResult(vault, {
    ...configOpt,
    startedAt,
    result: { returned: true },
    by,
  });
  const day = recorded(recording);
  for (const w of summary.warnings ?? []) {
    process.stderr.write(`warning: ${w.code}: ${w.message}\n`);
  }
  if (json) {
    writeJson({
      ok: true,
      run_id: summary.run_id,
      changed: summary.changed,
      ...(summary.model_work !== undefined ? { model_work: summary.model_work } : {}),
      day: dayJson(day),
    });
  } else {
    process.stdout.write(
      [`run_id: ${summary.run_id}`, `changed: ${summary.changed}`, dayLine(day)].join("\n") + "\n",
    );
  }
  return done(EXIT.ok, recording);
}
