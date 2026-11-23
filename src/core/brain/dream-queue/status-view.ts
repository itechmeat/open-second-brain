/**
 * The dream work queue as the surfaces show it (design D8): the doctor
 * check, the dream owner status (CLI and MCP) and `o2b dream queue`.
 *
 * Importing this module registers the production operations, so a
 * surface never reports this build's own work as an unknown operation.
 */

import "./rollup-work.ts";
import { discoverConfig, resolveVault } from "../../config.ts";
import { decisionModelModeFor, resolveDecisionModelConfig } from "../../decision-model/config.ts";
import type { ResolvedDecisionModelConfig } from "../../decision-model/config-types.ts";
import { mayShareRecord } from "../../decision-model/egress-guard.ts";
import { useOfOperation, type ClosedUse } from "../../topics/decide-operations.ts";
import { DREAM_QUEUE_COMMAND } from "./constants.ts";
import { RELEASE_COST_GATE, RELEASE_EGRESS_REFUSED, RELEASE_SHADOW } from "./decision-executor.ts";
import { queueStatus, type DreamQueueListing, type DreamQueueStatus } from "./queue.ts";

export { queueStatus, type DreamQueueStatus };

/**
 * Why a waiting item waits (change `dream-closed-questions`, design D7),
 * derived from its records and this machine's decision model settings:
 *
 *  - `no-model`: no decision model is in force for its use (none is
 *    configured, or the use is off);
 *  - `shadow`: the use is in shadow and the item was asked for its input;
 *  - `needs-local-executor`: its evidence is private and the chain may
 *    not receive it;
 *  - `retry-at`: a failed attempt, retried at its time;
 *  - `cost-gate`: the daily model cost gate has been reached;
 *  - `not-reached`: ready and answerable, not taken within a pass's budget;
 *  - `no-executor`: an operation nothing in this version answers.
 */
export type DreamWaitingReason =
  | "no-model"
  | "shadow"
  | "needs-local-executor"
  | "retry-at"
  | "cost-gate"
  | "not-reached"
  | "no-executor";

/** The waiting items of one operation. */
export interface DreamWaitingGroup {
  readonly operation: string;
  /** The decision model use of a closed question, else `null`. */
  readonly use: ClosedUse | null;
  readonly count: number;
  readonly oldest_age_ms: number;
  readonly reasons: Readonly<Partial<Record<DreamWaitingReason, number>>>;
}

function waitingReason(
  item: DreamQueueListing,
  cfg: ResolvedDecisionModelConfig,
  now: number,
): DreamWaitingReason {
  const use = useOfOperation(item.operation);
  if (use === null) return "no-executor";
  const mode = decisionModelModeFor(cfg, use);
  if (mode === "off") return "no-model";
  if (item.release === RELEASE_SHADOW && mode === "shadow") return "shadow";
  if (item.release === RELEASE_EGRESS_REFUSED && !mayShareRecord(cfg, use, true)) {
    return "needs-local-executor";
  }
  if (item.release === RELEASE_COST_GATE) return "cost-gate";
  if (item.retry_at !== null && Date.parse(item.retry_at) > now) return "retry-at";
  return "not-reached";
}

/**
 * The waiting items of `status` per operation, each with its reasons;
 * the decision model settings are this machine's (`configPath`, `env`).
 */
export function waitingByOperation(
  status: DreamQueueStatus,
  options: {
    readonly configPath?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly now?: number;
  } = {},
): DreamWaitingGroup[] {
  if (!status.available) return [];
  const now = options.now ?? Date.now();
  const cfg = resolveDecisionModelConfig({
    env: options.env ?? process.env,
    config: discoverConfig(options.configPath).data,
    vault: resolveVault(options.configPath),
  });
  const groups = new Map<
    string,
    { count: number; oldest: number; reasons: Partial<Record<DreamWaitingReason, number>> }
  >();
  for (const item of status.items) {
    if (item.state !== "waiting") continue;
    const reason = waitingReason(item, cfg, now);
    const group = groups.get(item.operation) ?? { count: 0, oldest: 0, reasons: {} };
    group.count += 1;
    group.oldest = Math.max(group.oldest, item.age_ms);
    group.reasons[reason] = (group.reasons[reason] ?? 0) + 1;
    groups.set(item.operation, group);
  }
  return [...groups.entries()]
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([operation, g]) => ({
      operation,
      use: useOfOperation(operation),
      count: g.count,
      oldest_age_ms: g.oldest,
      reasons: g.reasons,
    }));
}

/** What changes a reason, for a person. */
export function waitingAction(reason: DreamWaitingReason, use: ClosedUse | null): string {
  switch (reason) {
    case "no-model":
      return `configure a decision model and set \`decision_model_uses\` to include \`${use}:enforce\``;
    case "shadow":
      return `the use is in shadow; set \`${use}:enforce\` in \`decision_model_uses\` once its thresholds are tuned`;
    case "needs-local-executor":
      return `the evidence is private: add a local entry to the decision model chain, or allow private records for \`${use}\` in \`decision_model_private_uses\``;
    case "retry-at":
      return "a failed attempt; it is retried at its retry time";
    case "cost-gate":
      return "the daily decision model cost gate has been reached; raise or disable `decision_model_cost_gate_usd`";
    case "not-reached":
      return "not reached within the pass's budget; a later pass answers it (`dream.model_budget_ms`)";
    case "no-executor":
      return "nothing in this version answers this work; it is kept";
  }
}

/** One line per reason of `group`: the count, the reason and its action. */
export function describeWaitingGroup(group: DreamWaitingGroup): string {
  const reasons = Object.entries(group.reasons)
    .map(
      ([reason, n]) => `${n} ${reason} (${waitingAction(reason as DreamWaitingReason, group.use)})`,
    )
    .join("; ");
  return `${group.count} ${group.operation} item(s) wait, the oldest ${hours(group.oldest_age_ms)}: ${reasons}`;
}

function hours(ms: number): string {
  const h = ms / 3_600_000;
  return h < 1 ? `${Math.round(ms / 60_000)} min` : `${h.toFixed(1)} h`;
}

/** The status without the item list: the section the owner status carries. */
export function queueSummaryJson(
  status: DreamQueueStatus,
  waiting: ReadonlyArray<DreamWaitingGroup> = [],
): Record<string, unknown> {
  if (!status.available)
    return { available: false, reason: status.reason, message: status.message };
  return {
    available: true,
    counts: status.counts,
    ready: status.ready,
    oldest_ready_age_ms: status.oldest_ready?.age_ms ?? null,
    backlog: status.backlog,
    parked: status.parked.map((p) => ({
      id: p.id,
      operation: p.operation,
      reason: p.reason,
      retry_command: p.retry_command,
    })),
    unknown_operations: status.unknown_operations,
    rejected: status.rejected,
    private: status.private,
    executor: status.executor,
    waiting: waiting.map((g) => ({
      operation: g.operation,
      count: g.count,
      oldest_age_ms: g.oldest_age_ms,
      reasons: g.reasons,
    })),
  };
}

/** Lines for a person: counts, the oldest ready item, parked items, and what waiting means. */
export function describeQueueStatus(
  status: DreamQueueStatus,
  waiting: ReadonlyArray<DreamWaitingGroup> = [],
): string[] {
  if (!status.available) return [`Dream work queue: ${status.message}.`];
  const c = status.counts;
  const lines = [
    `Dream work queue: ${c.waiting} waiting (${status.ready} ready), ${c.leased} leased, ` +
      `${c.accepted} accepted, ${c.parked} parked, ${c.finished} finished, ${c.closed} closed.`,
  ];
  if (status.oldest_ready !== null) {
    lines.push(`  The oldest ready item has waited ${hours(status.oldest_ready.age_ms)}.`);
  }
  for (const p of status.parked) {
    lines.push(
      `  Parked ${p.id} (${p.operation}): ${p.reason}; retry with \`${p.retry_command}\`.`,
    );
  }
  if (status.unknown_operations.length > 0) {
    lines.push(`  Operations this version does not know: ${status.unknown_operations.join(", ")}.`);
  }
  if (status.private === "unknown") {
    lines.push("  Private work is unknown: this device lost the private partition it held.");
  }
  for (const group of waiting) lines.push(`  ${describeWaitingGroup(group)}.`);
  if (c.waiting + c.leased + c.accepted + c.parked > 0) {
    lines.push(
      "  Queued work waits until it is answered; no fixed rule decides it and no surface counts " +
        `it as done. List it with \`${DREAM_QUEUE_COMMAND}\`.`,
    );
  }
  return lines;
}
