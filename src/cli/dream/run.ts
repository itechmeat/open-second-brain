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
  busyLockPassIncomplete,
  holdDreamRunClaim,
  recordDreamOutcomeResult,
  type DreamOutcomeRecording,
  type DreamWorkKept,
} from "../../core/brain/dream-trigger/outcome.ts";
import { isLockContention, withBackgroundLockWait } from "../../core/store/local-lock.ts";
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
  "usage: o2b dream run [--claim <token>] [--catch-up <minutes>] [--vault <path> | --no-vault] [--config <file>] [--json]";

/** Below this, what is left of a catch-up budget starts no further pass. */
export const DREAM_CATCH_UP_NEXT_MIN_MS = 120_000;

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

function refuse(
  json: boolean,
  message: string,
  extra: Record<string, unknown> = {},
  quiet = false,
): number {
  if (json && !quiet) writeJson({ ok: false, ...extra, error: message });
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
    "catch-up": { type: "string" },
  });
  if (positional.length > 0) throw new CliError(`unexpected argument: ${positional[0]}`);
  const catchUpRaw = flags["catch-up"] as string | undefined;
  const catchUpMinutes = catchUpRaw === undefined ? undefined : Number(catchUpRaw);
  if (
    catchUpMinutes !== undefined &&
    (!Number.isFinite(catchUpMinutes) || catchUpMinutes <= 0 || catchUpMinutes > 24 * 60)
  ) {
    throw new CliError("--catch-up needs a number of minutes, above 0 and at most 1440");
  }
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
    const target = noVault
      ? null
      : ((flags["vault"] as string | undefined) ?? resolveVault(configPath));
    const by = token !== undefined ? "worker" : "cli";
    const ran =
      catchUpMinutes !== undefined
        ? await runCatchUp(target, configOpt, json, by, Math.round(catchUpMinutes * 60_000))
        : await runPass(target, configOpt, json, by);
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

/**
 * A catch-up run (`--catch-up <minutes>`): passes one after another, each
 * giving the launched agent what is left of the catch-up budget (its
 * sessions follow one another while ready work lasts), while the budget
 * lasts and the previous pass's agent answered something. For a backlog
 * (the first passes after a migration) instead of one session a day.
 */
async function runCatchUp(
  vault: string | null,
  configOpt: { readonly configPath?: string },
  json: boolean,
  by: "worker" | "cli",
  budgetMs: number,
): Promise<PassRun> {
  const until = Date.now() + budgetMs;
  const passes: Array<Record<string, unknown>> = [];
  let last: PassRun = done(EXIT.ok);
  for (;;) {
    const left = until - Date.now();
    const started = Date.now();
    // oxlint-disable-next-line no-await-in-loop -- passes run one after another
    const pass = await runOnePass(vault, configOpt, json, by, left);
    last = pass.run;
    passes.push({ ms: Date.now() - started, ...pass.report });
    if (pass.run.code !== EXIT.ok) break;
    if (until - Date.now() < DREAM_CATCH_UP_NEXT_MIN_MS) break;
    if (pass.agentAnswered === 0) break;
  }
  if (json) {
    writeJson({ ok: last.code === EXIT.ok, catch_up: { budget_ms: budgetMs, passes } });
  } else {
    const answered = passes.reduce((n, p) => n + Number(p["agent_answered"] ?? 0), 0);
    process.stdout.write(
      `catch-up: ${passes.length} pass(es), ${answered} item(s) answered by the dream agent\n`,
    );
  }
  return last;
}

async function runPass(
  vault: string | null,
  configOpt: { readonly configPath?: string },
  json: boolean,
  by: "worker" | "cli",
): Promise<PassRun> {
  return (await runOnePass(vault, configOpt, json, by, undefined)).run;
}

/** One pass; with `catchUpLeftMs`, the model work gets that much (a catch-up pass). */
async function runOnePass(
  vault: string | null,
  configOpt: { readonly configPath?: string },
  json: boolean,
  by: "worker" | "cli",
  catchUpLeftMs: number | undefined,
): Promise<{ run: PassRun; agentAnswered: number; report: Record<string, unknown> }> {
  const out = (run: PassRun, agentAnswered = 0, report: Record<string, unknown> = {}) => ({
    run,
    agentAnswered,
    report,
  });
  // A catch-up run writes one JSON document, the aggregate of its passes:
  // the refusal of a pass is in that pass's report, not a document of its
  // own before the aggregate.
  const quiet = catchUpLeftMs !== undefined;
  const refusal = (
    message: string,
    extra: Record<string, unknown>,
  ): { readonly code: number; readonly report: Record<string, unknown> } => ({
    code: refuse(json, message, extra, quiet),
    report: { error: message, ...extra },
  });
  const startedAt = new Date();
  try {
    assertDreamOwner(vault, { live: true, ...configOpt });
  } catch (err) {
    if (err instanceof DreamNotOwnerError) {
      const r = refusal(err.message, { code: err.code, reason: err.reason });
      return out(done(r.code), 0, r.report);
    }
    throw err;
  }
  // One deadline for the whole run: the safeguard starts before the
  // model work, which spends the deadline first, never more than its own
  // budget, and the pass gets what is left. A catch-up pass gives the
  // model work what is left of the catch-up budget instead, and the pass
  // its own safeguard after it.
  const timeoutMs = resolveSafeguardTimeoutMs(OPERATION.dream, configOpt.configPath);
  const runSafeguard =
    catchUpLeftMs === undefined ? createSafeguard({ operation: OPERATION.dream, timeoutMs }) : null;
  const deadlineMs = catchUpLeftMs !== undefined ? catchUpLeftMs : decideBudgetWithin(timeoutMs, 0);
  const closedQuestions =
    deadlineMs === 0
      ? undefined
      : await prepareClosedQuestions(vault, {
          ...configOpt,
          background: true,
          ...(deadlineMs !== undefined ? { deadlineMs } : {}),
          ...(catchUpLeftMs !== undefined ? { agentBudgetMs: catchUpLeftMs } : {}),
        });
  const safeguard = runSafeguard ?? createSafeguard({ operation: OPERATION.dream, timeoutMs });
  const agentAnswered = closedQuestions?.agent?.answered ?? 0;
  const report = {
    produced: closedQuestions?.produced ?? 0,
    left: closedQuestions?.left ?? 0,
    agent_answered: agentAnswered,
  };
  // What the front door left in the work queue before the pass: produced
  // items and the answers of the decision model and the launched agent,
  // each a store append made when it happened.
  const kept: DreamWorkKept = {
    produced: report.produced,
    answered: (closedQuestions?.answered ?? 0) + agentAnswered,
  };
  let summary: ReturnType<typeof dream>;
  try {
    // The pass's own store work is a long background operation: its
    // store locks wait up to two minutes for a busy holder (a live
    // session's hook or tool), not the five seconds a person waits on.
    // Scoped to this synchronous call, so no other lock inherits it.
    summary = withBackgroundLockWait(() =>
      dream(vault, {
        ...configOpt,
        ...(closedQuestions !== undefined ? { closedQuestions } : {}),
        safeguard,
      }),
    );
  } catch (err) {
    const recording = recordDreamOutcomeResult(vault, {
      ...configOpt,
      startedAt,
      result: { threw: err },
      by,
      kept,
    });
    const day = recorded(recording);
    if (err instanceof DreamNotOwnerError) {
      const r = refusal(err.message, { code: err.code, reason: err.reason });
      return out(done(r.code, recording), agentAnswered, { ...report, ...r.report });
    }
    // A store lock that stayed busy past the wait, after the front door
    // left work in the queue: an incomplete pass, recorded as one; the
    // next pass applies the answers. Met before any work was left, in the
    // next pass again (the record says failed), or with a recording that
    // failed (the previous ending is unknown), it is a failure.
    if (busyLockPassIncomplete(err, recording, kept)) {
      const message =
        `dream incomplete: ${kept.produced} item(s) produced and ${kept.answered} answer(s) ` +
        `recorded stay in the work queue for the next pass: ${describeErrorChain(err)}`;
      process.stderr.write(`warning: dream-store-lock-busy: ${message}\n`);
      const passJson = { ok: true, incomplete: message, day: dayJson(day) };
      if (catchUpLeftMs !== undefined) {
        // The report counts the agent's answers (`agent_answered`); the
        // zero only ends the catch-up here, so no further pass meets the
        // same busy lock and turns this incomplete day into a failure.
        return out(done(EXIT.ok, recording), 0, { ...report, ...passJson });
      }
      if (json) writeJson(passJson);
      else process.stdout.write(`${[message, dayLine(day)].join("\n")}\n`);
      return out(done(EXIT.ok, recording), agentAnswered, { ...report, incomplete: message });
    }
    const message = `dream failed: ${describeErrorChain(err)}`;
    const r = refusal(message, { day: dayJson(day) });
    return out(done(r.code, recording), agentAnswered, { ...report, ...r.report });
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
  const passJson = {
    ok: true,
    run_id: summary.run_id,
    changed: summary.changed,
    ...(summary.model_work !== undefined ? { model_work: summary.model_work } : {}),
    day: dayJson(day),
  };
  // A catch-up pass is reported in the catch-up's own output.
  if (catchUpLeftMs !== undefined) {
    return out(done(EXIT.ok, recording), agentAnswered, { ...report, ...passJson });
  }
  if (json) {
    writeJson(passJson);
  } else {
    process.stdout.write(
      [`run_id: ${summary.run_id}`, `changed: ${summary.changed}`, dayLine(day)].join("\n") + "\n",
    );
  }
  return out(done(EXIT.ok, recording), agentAnswered, { ...report, run_id: summary.run_id });
}
