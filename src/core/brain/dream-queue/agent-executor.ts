/**
 * The launched agent as an executor of the dream work queue (change
 * `dream-launched-agent`, design D4): after the decision model executor,
 * in a live pass on the dream owner's device, when ready work is left
 * that only an agent may do, the worker starts the user's own agent in a
 * short session that sees nothing but the queue, waits within a budget,
 * and ends it.
 *
 *  1. The session may take every text operation, and a closed operation
 *     when the decision model is not active or its use is off.
 *  2. Only a verified command is started (`agent-verified.ts`).
 *  3. The run's budget is the setting, clamped to what the caller has
 *     left less a reserve for the pass; under the minimum no session
 *     starts (`no-time`).
 *  4. The program is started without a shell, with the run's id and token
 *     in its environment; at the deadline it is ended.
 *  5. Every lease the run still holds is released, the run record and
 *     the server's config file are removed.
 *  6. A session that ended badly or answered nothing: the next fallback,
 *     once, with a fresh run.
 *  7. A session that answered and stopped at its item budget: another
 *     session of the same command, while ready work and the run's time
 *     budget last (at least {@link DREAM_AGENT_NEXT_MIN_MS}).
 */

import { renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { discoverConfig, resolveVault } from "../../config.ts";
import { decisionModelModeFor, resolveDecisionModelConfig } from "../../decision-model/config.ts";
import { o2bCommand } from "../../maintenance/o2b-command.ts";
import { findProgram, runProgram, type RunProgramResult } from "../../process/run-program.ts";
import type { StoreHandle } from "../../store/store-open.ts";
import { CLOSED_OPERATIONS, useOfOperation } from "../../topics/decide-operations.ts";
import type { DreamOwner } from "../dream-owner/fold.ts";
import {
  DREAM_EXECUTOR_SERVER_NAME,
  DREAM_RUN_ENV,
  DREAM_TOKEN_ENV,
  DREAM_WORK_TAKE,
  dreamSessionTask,
  insideDreamSession,
} from "./dream-session.ts";
import { resolveDreamAgentConfig, type DreamAgentCommand } from "./agent-config.ts";
import {
  dreamAgentStateDir,
  dreamAgentVerification,
  recordDreamAgentLastRun,
} from "./agent-verified.ts";
import { textOperationNames } from "./operations.ts";
import { readDreamWork, releaseRunWork, type DreamQueue } from "./queue.ts";
import {
  createDreamRun,
  dreamRunsDir,
  readDreamRunCalls,
  removeDreamRunUnderLock,
  withDreamRunLock,
  type DreamRunCall,
} from "./run-record.ts";

/** Time kept back from the caller's deadline for the pass that follows. */
export const DREAM_AGENT_RESERVE_MS = 90_000;
/** Below this, no session starts in this pass. */
export const DREAM_AGENT_MIN_MS = 30_000;
/** Below this, what is left of a run's budget starts no fallback. */
export const DREAM_AGENT_FALLBACK_MIN_MS = 10_000;
/** Below this, what is left of a run's budget starts no next session after one that met its item budget. */
export const DREAM_AGENT_NEXT_MIN_MS = 20_000;

export interface AgentExecutorOptions {
  readonly configPath?: string;
  /** Environment of the settings and of the started program (default `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** What is left of the caller's own deadline, in ms; absent for the dream verb. */
  readonly callerRemainingMs?: number;
  /** Only these commands (the check); default: the configured ones that are verified. */
  readonly commands?: ReadonlyArray<DreamAgentCommand>;
  /** Only these operations (the check); default: what the decision model does not answer. */
  readonly operations?: ReadonlyArray<string>;
  /** Overrides of the run's bounds (the check). */
  readonly budgetMs?: number;
  readonly items?: number;
  readonly batch?: number;
}

export interface AgentSessionRun {
  readonly agent: string;
  readonly run: string;
  readonly ended: string;
  readonly answered: number;
  readonly models: ReadonlyArray<string>;
  readonly calls: ReadonlyArray<DreamRunCall>;
  readonly failed: boolean;
  /** Why the leases the session still held could not be released at its end (they expire). */
  readonly release_error?: string;
}

export type AgentExecutorResult =
  | {
      readonly status: "skipped";
      readonly reason: "no-work" | "no-command" | "unverified" | "no-time" | "inside-session";
    }
  | {
      readonly status: "ran";
      readonly runs: ReadonlyArray<AgentSessionRun>;
      readonly answered: number;
    };

/** The operations the session may take now: text always, closed when the decision model does not answer them. */
export function agentOperations(
  configPath: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const cfg = resolveDecisionModelConfig({
    env,
    config: discoverConfig(configPath).data,
    vault: resolveVault(configPath),
  });
  const closed = CLOSED_OPERATIONS.filter((op) => {
    if (cfg.status !== "active") return true;
    return decisionModelModeFor(cfg, useOfOperation(op)!) === "off";
  });
  return [...textOperationNames(), ...closed];
}

function fill(arg: string, values: Readonly<Record<string, string>>): string {
  let out = arg;
  for (const [key, value] of Object.entries(values)) out = out.split(key).join(value);
  return out;
}

function endedOf(result: RunProgramResult): string {
  if (result.status === "exited") {
    return result.signal !== null ? `exited by ${result.signal}` : `exited ${result.code}`;
  }
  if (result.status === "timed-out") return "timed-out";
  return `not-started: ${result.error}`;
}

/** Start one session of `command` on `store` and await it. */
export async function runAgentSession(
  queue: DreamQueue,
  owner: DreamOwner,
  command: DreamAgentCommand,
  input: {
    readonly budgetMs: number;
    readonly operations: ReadonlyArray<string>;
    readonly privateAllowed: boolean;
    readonly items: number;
    /** Items per take and per answer call (default 1, the one-item protocol). */
    readonly batch?: number;
    readonly configPath?: string;
    readonly env: Readonly<Record<string, string | undefined>>;
  },
): Promise<AgentSessionRun> {
  const store: StoreHandle = queue.store;
  const dsd = store.deviceStateDir;
  const { record, token } = createDreamRun(dsd, {
    ownerRevision: owner.revision,
    budgetMs: input.budgetMs,
    operations: input.operations,
    privateAllowed: input.privateAllowed,
    itemBudget: input.items,
    ...(input.batch !== undefined ? { batch: input.batch } : {}),
    agent: command.label,
  });
  const run = record.run;
  const runsDir = dreamRunsDir(dsd);
  const mcpConfigPath = join(runsDir, `${run}.mcp.json`);
  const logPath = join(runsDir, `${run}.log`);
  const [serverProgram, ...serverPrefix] = o2bCommand();
  const serverArgs = [
    ...serverPrefix,
    "mcp",
    "--tool-profile",
    "dream-executor",
    ...(input.configPath !== undefined ? ["--config", input.configPath] : []),
    ...(queue.vault !== null ? ["--vault", queue.vault] : []),
  ];
  const sessionEnv: Record<string, string> = {
    [DREAM_RUN_ENV]: run,
    [DREAM_TOKEN_ENV]: token,
    O2B_DEVICE_ID: store.device,
    OPEN_SECOND_BRAIN_STORE_ROOT: store.root,
  };
  writeFileSync(
    mcpConfigPath,
    JSON.stringify(
      {
        mcpServers: {
          [DREAM_EXECUTOR_SERVER_NAME]: {
            command: serverProgram,
            args: serverArgs,
            env: sessionEnv,
          },
        },
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  const values = {
    "{prompt}": dreamSessionTask(run, record.batch),
    "{mcp_config}": mcpConfigPath,
    "{mcp_command}": serverProgram!,
    "{mcp_args_json}": JSON.stringify(serverArgs),
  };
  const program = findProgram(command.program, input.env);
  let result: RunProgramResult;
  let calls: DreamRunCall[] = [];
  let releaseError: string | null = null;
  try {
    result =
      program === null
        ? { status: "not-started", error: `${command.program} is not installed` }
        : await runProgram({
            program,
            args: command.args.map((a) => fill(a, values)),
            env: { ...input.env, ...sessionEnv },
            deadline: Date.now() + input.budgetMs,
            logPath,
          });
  } finally {
    // The cleanup never throws past here: a release that cannot be made
    // leaves the leases to expire, and the session is still reported (and
    // the last run recorded) with what it did.
    try {
      withDreamRunLock(dsd, run, () => {
        calls = readDreamRunCalls(dsd, run);
        try {
          releaseRunWork(queue, run);
        } catch (err) {
          releaseError = err instanceof Error ? err.message : String(err);
        } finally {
          removeDreamRunUnderLock(dsd, run);
        }
      });
    } catch (err) {
      releaseError ??= err instanceof Error ? err.message : String(err);
    } finally {
      rmSync(mcpConfigPath, { force: true });
    }
  }
  try {
    renameSync(logPath, join(runsDir, "last-session.log"));
  } catch {
    // No output was written.
  }
  const answered = calls.filter((c) => c.tool === "dream_work_answer" && c.outcome === "accepted");
  const models = [...new Set(answered.map((c) => c.model).filter((m): m is string => !!m))];
  const ended = endedOf(result);
  return {
    agent: command.label,
    run,
    ended,
    answered: answered.length,
    models,
    calls,
    failed: !(result.status === "exited" && result.code === 0) || answered.length === 0,
    ...(releaseError !== null ? { release_error: releaseError } : {}),
  };
}

/** Whether `session` stopped because a take met its item budget (work may be left). */
function endedAtItemBudget(session: AgentSessionRun): boolean {
  return session.calls.some((c) => c.tool === DREAM_WORK_TAKE && c.outcome === "item-budget");
}

/** Answer what only an agent may answer, within the bounds of this pass. */
export async function runAgentExecutor(
  queue: DreamQueue,
  owner: DreamOwner,
  options: AgentExecutorOptions = {},
): Promise<AgentExecutorResult> {
  const env = options.env ?? process.env;
  // No recursion: a dream session never starts another one.
  if (insideDreamSession(process.env) || insideDreamSession(env)) {
    return { status: "skipped", reason: "inside-session" };
  }
  const cfg = resolveDreamAgentConfig({ config: discoverConfig(options.configPath).data, env });
  const stateDir = dreamAgentStateDir();
  const skip = (
    reason: "no-work" | "no-command" | "unverified" | "no-time",
  ): AgentExecutorResult => {
    if (reason !== "no-work") {
      recordDreamAgentLastRun(
        {
          at: new Date().toISOString(),
          status: reason,
          agent: null,
          model: null,
          answered: 0,
          ended: null,
          failed: false,
        },
        stateDir,
      );
    }
    return { status: "skipped", reason };
  };
  const configured =
    options.commands ?? (cfg.command === null ? [] : [cfg.command, ...cfg.fallbacks]);
  const operations = options.operations ?? agentOperations(options.configPath, env);
  const allowed = new Set(operations);
  const readyWork = (): boolean => {
    const state = readDreamWork(queue.store);
    const now = Date.now();
    return [...state.items.values()].some(
      (item) =>
        item.ready &&
        allowed.has(item.body.operation) &&
        (cfg.privateAllowed || item.partition !== "private") &&
        (item.retry_at === null || Date.parse(item.retry_at) <= now),
    );
  };
  if (!readyWork()) return { status: "skipped", reason: "no-work" };
  if (configured.length === 0) return skip("no-command");
  const commands =
    options.commands ?? configured.filter((c) => dreamAgentVerification(c, stateDir) !== null);
  if (commands.length === 0) return skip("unverified");
  let budget = options.budgetMs ?? cfg.budgetMs;
  if (options.callerRemainingMs !== undefined) {
    budget = Math.min(budget, options.callerRemainingMs - DREAM_AGENT_RESERVE_MS);
  }
  if (budget < DREAM_AGENT_MIN_MS) return skip("no-time");
  const started = Date.now();
  const runs: AgentSessionRun[] = [];
  // The first command, then one fallback at most. A session that answered
  // and ended at its item budget is followed by another of the same
  // command while ready work and the time budget last: the item budget
  // bounds one session (its context), the time budget the whole run.
  let index = 0;
  for (;;) {
    const command = commands[index]!;
    const left = budget - (Date.now() - started);
    // oxlint-disable-next-line no-await-in-loop -- sessions run one after another
    const session = await runAgentSession(queue, owner, command, {
      budgetMs: left,
      operations,
      privateAllowed: cfg.privateAllowed,
      items: options.items ?? cfg.items,
      batch: options.batch ?? cfg.batch,
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      env,
    });
    runs.push(session);
    const leftAfter = budget - (Date.now() - started);
    if (session.failed) {
      if (index > 0 || commands.length < 2 || leftAfter < DREAM_AGENT_FALLBACK_MIN_MS) break;
      index = 1;
      continue;
    }
    if (!endedAtItemBudget(session) || leftAfter < DREAM_AGENT_NEXT_MIN_MS || !readyWork()) break;
  }
  const last = runs[runs.length - 1]!;
  recordDreamAgentLastRun(
    {
      at: new Date().toISOString(),
      status: "ran",
      agent: last.agent,
      model: last.models[0] ?? null,
      answered: runs.reduce((n, r) => n + r.answered, 0),
      ended: last.ended,
      failed: last.failed,
    },
    stateDir,
  );
  return { status: "ran", runs, answered: runs.reduce((n, r) => n + r.answered, 0) };
}
