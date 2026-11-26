/**
 * The front door of a live dream pass's model work (change
 * `dream-closed-questions`, design D1): the asynchronous callers of a
 * live pass (the CLI dream verb, the MCP dream tool, the maintenance
 * lane's dream task) await this right before `dream()`. On the dream
 * owner's device of a brain served from the store it
 *
 *  1. produces every closed question as a dream work item, whether or not
 *     the pass will find anything else to change, and
 *  2. lets the decision model executor answer what it may,
 *
 * both within the model budget (`dream.model_budget_ms`, default
 * {@link DREAM_MODEL_BUDGET_MS}), production first. The answers take
 * effect in topic planning, at the tail of the pass. A synchronous dream
 * caller, a dry run and a preview never call it: they produce nothing
 * and ask nothing.
 *
 * Fail-open: every error answers `undefined`, and the pass runs as it
 * would with nothing produced.
 */

import { readDeviceId, resolveAgentName } from "../config.ts";
import { runAgentExecutor } from "../brain/dream-queue/agent-executor.ts";
import { runDecisionExecutor } from "../brain/dream-queue/decision-executor.ts";
import { assertDreamOwner } from "../brain/dream-owner/gate.ts";
import { dreamQueueOn } from "../brain/dream-queue/queue.ts";
import type { ClosedQuestionsRun } from "../brain/dream-types.ts";
import { loadBrainConfig } from "../brain/policy.ts";
import type { DecisionProvider } from "../decision-model/contract.ts";
import { readTopicQuestionState } from "./decide-operations.ts";
import { withBackgroundLockWait } from "../store/local-lock.ts";
import { produceTopicQuestions } from "./decide-produce.ts";

/** The model budget of a live pass when `dream.model_budget_ms` is unset. */
export const DREAM_MODEL_BUDGET_MS = 20_000;

export interface PrepareClosedQuestionsOptions {
  /** The machine config naming the store (absent: the process's own). */
  readonly configPath?: string;
  /** Wall clock (default `Date.now`): the budget runs on it. */
  readonly now?: () => number;
  /** The date the dream run is for (its `now`), when it has one. */
  readonly runAt?: Date;
  /** Injected provider (tests): replaces the whole chain. */
  readonly provider?: DecisionProvider;
  /** Config environment override (tests). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** What is left of the caller's own deadline, in ms: the budget is clamped to it. */
  readonly deadlineMs?: number;
  /** The agent the queue records name (default: the configured agent). */
  readonly agent?: string;
  /**
   * The launched agent's time budget for this pass, instead of
   * `dream_agent_budget_ms` (a catch-up run's: what is left of its own
   * budget); still clamped to the caller's deadline less the reserve.
   */
  readonly agentBudgetMs?: number;
  /**
   * The caller is a background pass (`o2b dream run`): production's store
   * locks wait as the pass's own do ({@link withBackgroundLockWait}), not
   * the five seconds of a command a person waits on.
   */
  readonly background?: boolean;
}

/**
 * What is left of a caller's deadline of `timeoutMs` (null: none) after
 * `elapsedMs`: the front door clamps its budget to it. `undefined` leaves
 * the front door its own budget.
 */
export function decideBudgetWithin(
  timeoutMs: number | null,
  elapsedMs: number,
): number | undefined {
  if (timeoutMs === null) return undefined;
  return Math.max(0, timeoutMs - elapsedMs);
}

/** The model budget of `vault`'s live passes, in ms. */
export function dreamModelBudgetMs(vault: string | null): number {
  try {
    return loadBrainConfig(vault).dream.model_budget_ms ?? DREAM_MODEL_BUDGET_MS;
  } catch {
    return DREAM_MODEL_BUDGET_MS;
  }
}

/**
 * Produce the closed questions of the pass about to run and have the
 * decision model answer them, on the dream owner's device. `undefined`
 * when this device is not the owner's, the brain has no store, a shard
 * could not be read, or anything threw.
 */
export async function prepareClosedQuestions(
  vault: string | null,
  options: PrepareClosedQuestionsOptions = {},
): Promise<ClosedQuestionsRun | undefined> {
  try {
    const configOpt = options.configPath !== undefined ? { configPath: options.configPath } : {};
    const gate = assertDreamOwner(vault, { live: true, ...configOpt });
    if (gate.status !== "owner") return undefined;
    if (readDeviceId(options.configPath) === null) return undefined;
    const clock = options.now ?? Date.now;
    const startedAt = Date.now();
    const budget = Math.min(
      dreamModelBudgetMs(vault),
      options.deadlineMs ?? Number.POSITIVE_INFINITY,
    );
    const until = clock() + budget;
    const queue = dreamQueueOn(gate.store, {
      vault,
      writer: options.agent ?? resolveAgentName(options.configPath),
      ...configOpt,
    });
    const at = options.runAt?.getTime() ?? clock();
    const state = readTopicQuestionState(gate.store, at);
    if (state === null) return undefined;
    // Production is unconditional (design D1): a quiet brain's backlog is
    // never stuck behind a pass that finds nothing else to change.
    const produce = () => produceTopicQuestions(queue, state, { until, clock });
    const produced = options.background === true ? withBackgroundLockWait(produce) : produce();
    const executed = await runDecisionExecutor(queue, {
      until,
      clock,
      ...configOpt,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
    });
    // The launched agent (change `dream-launched-agent`, design D4): what
    // only an agent may answer, under its own budget, clamped to what the
    // caller has left.
    const agent = await runAgentExecutor(queue, gate.owner, {
      ...configOpt,
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.agentBudgetMs !== undefined ? { budgetMs: options.agentBudgetMs } : {}),
      ...(options.deadlineMs !== undefined
        ? { callerRemainingMs: options.deadlineMs - (Date.now() - startedAt) }
        : {}),
    });
    return {
      produced: produced.produced,
      left: produced.left,
      asked: executed.status === "ran" ? executed.asked : {},
      answered: executed.status === "ran" ? executed.answered : 0,
      agent:
        agent.status === "ran"
          ? { status: "ran", answered: agent.answered }
          : { status: "skipped", reason: agent.reason, answered: 0 },
    };
  } catch {
    return undefined;
  }
}
