/**
 * The front door of the decide pass (design D10, D20): the asynchronous
 * callers of a live dream pass (the CLI dream verb, the MCP dream tool,
 * the maintenance lane's dream task) await this right before
 * `dream()` and hand the verdicts in as `DreamOptions.topicVerdicts`.
 * A synchronous dream caller, a dry run and a preview never call it and
 * get the deterministic result.
 *
 * Fail-open: every error answers `undefined`, which the dream reads as
 * "no verdicts" - the deterministic plan. The pass itself never throws.
 */

import { readDeviceId } from "../config.ts";
import { inspectStore, openStore, type StoreHandle } from "../store/store-open.ts";
import { resolveConfiguredStoreRoot } from "../store/store-paths.ts";
import type { DecisionProvider } from "../decision-model/contract.ts";
import { decideTopicPlan } from "./decide.ts";
import { DECIDE_PASS_BUDGET_MS, type DecideTopicPlanOptions } from "./decide-shared.ts";
import type { TopicVerdicts } from "./verdicts.ts";

export interface PrepareTopicVerdictsOptions {
  /** The machine config naming the store (absent: the process's own). */
  readonly configPath?: string;
  /** Wall clock (default `Date.now`): the pass's budget runs on it. */
  readonly now?: () => number;
  /** The date the dream run is for (its `now`), when it has one. */
  readonly runAt?: Date;
  /** Injected provider (tests): replaces the whole chain. */
  readonly provider?: DecisionProvider;
  /** Config environment override (tests). */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** The pass's whole budget in ms. */
  readonly deadlineMs?: number;
}

/**
 * The pass's budget when the caller's whole call runs under one deadline
 * of `timeoutMs` (null: none) and `elapsedMs` of it are spent: what is
 * left, never more than {@link DECIDE_PASS_BUDGET_MS}, so the dream pass
 * after it keeps the rest. `undefined` leaves the pass its own budget.
 */
export function decideBudgetWithin(
  timeoutMs: number | null,
  elapsedMs: number,
): number | undefined {
  if (timeoutMs === null) return undefined;
  return Math.max(0, Math.min(DECIDE_PASS_BUDGET_MS, timeoutMs - elapsedMs));
}

/**
 * The verdicts for the dream pass about to run, or `undefined` when
 * this machine uses no brain store, has no device id, the decide pass
 * decided nothing (all uses off, not the view writer, ...) or anything
 * threw. `undefined` means the deterministic plan.
 */
export async function prepareTopicVerdicts(
  options: PrepareTopicVerdictsOptions = {},
): Promise<TopicVerdicts | undefined> {
  try {
    const { root } = resolveConfiguredStoreRoot(options.configPath);
    if (inspectStore(root) === null) return undefined;
    const device = readDeviceId(options.configPath);
    if (device === null) return undefined;
    const store: StoreHandle = openStore({ root, device });
    const decideOptions: DecideTopicPlanOptions = {
      ...(options.configPath !== undefined ? { configPath: options.configPath } : {}),
      ...(options.now !== undefined ? { now: options.now } : {}),
      ...(options.runAt !== undefined ? { runAt: options.runAt } : {}),
      ...(options.provider !== undefined ? { provider: options.provider } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      ...(options.deadlineMs !== undefined ? { deadlineMs: options.deadlineMs } : {}),
    };
    const verdicts = await decideTopicPlan(store, decideOptions);
    // A pass that decided nothing stays undefined, so the dream reads
    // exactly as without the feature.
    const isEmpty =
      verdicts.routes.size === 0 &&
      verdicts.kinds.size === 0 &&
      verdicts.vetoes.size === 0 &&
      verdicts.sameTopics.length === 0 &&
      verdicts.resolutions.size === 0 &&
      verdicts.completions.length === 0 &&
      verdicts.hidden.size === 0 &&
      verdicts.kept.size === 0;
    return isEmpty ? undefined : verdicts;
  } catch {
    return undefined;
  }
}
