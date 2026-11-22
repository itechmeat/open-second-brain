/**
 * What a live dream pass records about the dream owner (design D7 item 2,
 * spec "Another agent on the owner's device"): the summary and the run's
 * log event name the owner's device and agent and the agent that started
 * the pass. Kept here so `dream.ts` carries only the gate call and the
 * pass lock.
 */

import type { DreamOptions, DreamRunSummary } from "../dream-types.ts";
import type { DreamOwnerGateOptions } from "./gate.ts";

/** The owner a pass ran under. */
export interface DreamOwnerTag {
  readonly device: string;
  readonly agent: string;
}

/**
 * The gate options of a pass: live unless a dry run, with the pass's
 * config. The run date (`opts.now`) is not the clock of a release the
 * gate writes: records take the wall clock, as the view writer's do.
 */
export function dreamOwnerGateOptions(opts: DreamOptions): DreamOwnerGateOptions {
  return {
    live: opts.dryRun !== true,
    ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
  };
}

/** `summary` naming the owner it ran under and the agent that started it. */
export function withOwnerTag(
  summary: DreamRunSummary,
  owner: DreamOwnerTag,
  caller: string | undefined,
): DreamRunSummary {
  const agent = caller?.trim() ?? "";
  return {
    ...summary,
    owner: { device: owner.device, agent: owner.agent },
    ...(agent.length > 0 ? { caller: agent } : {}),
  };
}
