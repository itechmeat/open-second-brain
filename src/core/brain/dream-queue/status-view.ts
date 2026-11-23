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
import {
  queueStatus as readQueueStatus,
  type DreamQueueListing,
  type DreamQueueStatus,
} from "./queue.ts";
import { isTextOperation } from "./operations.ts";
import { resolveDreamAgentConfig } from "./agent-config.ts";
import {
  dreamAgentVerification,
  readDreamAgentLastRun,
  type DreamAgentLastRun,
} from "./agent-verified.ts";

/** Whether this machine has a verified dream agent command (design D5 of `dream-launched-agent`). */
export function dreamAgentReady(
  configPath: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): boolean {
  return agentReach(configPath, env).ready;
}

export type { DreamQueueStatus };

/**
 * The queue status of `vault` with its per-operation `executor` filled
 * from this machine's settings: the decision model, the dream agent.
 */
export function queueStatus(
  vault: string | null,
  options: Parameters<typeof readQueueStatus>[1] = {},
): DreamQueueStatus {
  const status = readQueueStatus(vault, options);
  if (!status.available) return status;
  const opts = options.configPath !== undefined ? { configPath: options.configPath } : {};
  return {
    ...status,
    executor: Object.fromEntries(
      Object.keys(status.executor).map((op) => [op, executorFor(op, opts)]),
    ),
  };
}

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
  | "no-agent"
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

/** This machine's dream agent: whether one is verified, and whether it may take private work. */
interface AgentReach {
  readonly ready: boolean;
  readonly privateAllowed: boolean;
}

function agentReach(
  configPath: string | undefined,
  env: Readonly<Record<string, string | undefined>>,
): AgentReach {
  const cfg = resolveDreamAgentConfig({ config: discoverConfig(configPath).data, env });
  return {
    ready: [cfg.command, ...cfg.fallbacks].some(
      (c) => c !== null && dreamAgentVerification(c) !== null,
    ),
    privateAllowed: cfg.privateAllowed,
  };
}

function waitingReason(
  item: DreamQueueListing,
  cfg: ResolvedDecisionModelConfig,
  now: number,
  agent: AgentReach,
): DreamWaitingReason {
  // The agent never takes private work it is not allowed (agent-executor).
  const agentReady = agent.ready && (agent.privateAllowed || item.partition !== "private");
  const use = useOfOperation(item.operation);
  if (use === null) {
    // A text operation: only the launched agent answers it.
    if (!isTextOperation(item.operation)) return "no-executor";
    if (!agentReady) return "no-agent";
    if (item.retry_at !== null && Date.parse(item.retry_at) > now) return "retry-at";
    return "not-reached";
  }
  const mode = cfg.status === "active" ? decisionModelModeFor(cfg, use) : "off";
  if (mode === "off") {
    // Closed questions nobody else answers go to the launched agent.
    if (!agentReady) return "no-model";
    if (item.retry_at !== null && Date.parse(item.retry_at) > now) return "retry-at";
    return "not-reached";
  }
  if (item.release === RELEASE_SHADOW && mode === "shadow") return "shadow";
  if (item.release === RELEASE_EGRESS_REFUSED && !mayShareRecord(cfg, use, true)) {
    return "needs-local-executor";
  }
  if (item.release === RELEASE_COST_GATE) return "cost-gate";
  if (item.retry_at !== null && Date.parse(item.retry_at) > now) return "retry-at";
  return "not-reached";
}

type WaitingOptions = {
  readonly configPath?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: number;
};

/** The reason of one waiting item under this machine's settings, resolved once. */
function waitingReasons(options: WaitingOptions): (item: DreamQueueListing) => DreamWaitingReason {
  const now = options.now ?? Date.now();
  const env = options.env ?? process.env;
  const cfg = resolveDecisionModelConfig({
    env,
    config: discoverConfig(options.configPath).data,
    vault: resolveVault(options.configPath),
  });
  const agent = agentReach(options.configPath, env);
  return (item) => waitingReason(item, cfg, now, agent);
}

/**
 * The reasons a later pass on this machine still answers: the item was
 * not reached, the cost gate lifts, a retry falls due. Every other
 * reason waits for a change of settings (change `dream-session-trigger`,
 * spec "Work that no executor on this machine can answer SHALL not keep
 * the day open").
 */
const ANSWERABLE_REASONS: ReadonlySet<DreamWaitingReason> = new Set([
  "not-reached",
  "cost-gate",
  "retry-at",
]);

/**
 * The ready items of `status` split by operation into what this machine
 * answers and what it does not, each item by its own waiting reason.
 */
export function readyByAnswerability(
  status: DreamQueueStatus,
  options: WaitingOptions = {},
): {
  readonly answerable: Readonly<Record<string, number>>;
  readonly unanswerable: Readonly<Record<string, number>>;
} {
  const answerable: Record<string, number> = {};
  const unanswerable: Record<string, number> = {};
  if (!status.available) return { answerable, unanswerable };
  const reasonOf = waitingReasons(options);
  for (const item of status.items) {
    if (!item.ready) continue;
    const into = ANSWERABLE_REASONS.has(reasonOf(item)) ? answerable : unanswerable;
    into[item.operation] = (into[item.operation] ?? 0) + 1;
  }
  return { answerable, unanswerable };
}

/**
 * The waiting items of `status` per operation, each with its reasons;
 * the decision model settings are this machine's (`configPath`, `env`).
 */
export function waitingByOperation(
  status: DreamQueueStatus,
  options: WaitingOptions = {},
): DreamWaitingGroup[] {
  if (!status.available) return [];
  const reasonOf = waitingReasons(options);
  const groups = new Map<
    string,
    { count: number; oldest: number; reasons: Partial<Record<DreamWaitingReason, number>> }
  >();
  for (const item of status.items) {
    if (item.state !== "waiting") continue;
    const reason = reasonOf(item);
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
      return (
        `configure a decision model and set \`decision_model_uses\` to include \`${use}:enforce\`, ` +
        "or set and check a dream agent (`o2b dream agent set`, `o2b dream agent check`)"
      );
    case "no-agent":
      return "only the dream agent answers this work: set it with `o2b dream agent set` and verify it with `o2b dream agent check`";
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
  if (c["awaiting-review"] > 0) {
    lines.push(
      `  ${c["awaiting-review"]} text answer(s) await review: \`${DREAM_QUEUE_COMMAND} --state awaiting-review\`, ` +
        `then \`${DREAM_QUEUE_COMMAND} approve <id>\` or \`reject <id> --reason <text>\`.`,
    );
  }
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

/** The dream agent as the dream status shows it (change `dream-launched-agent`, design D8). */
export interface DreamAgentStatus {
  /** The preset name or `custom`; `null` when none is set. */
  readonly command: string | null;
  readonly verified_at: string | null;
  readonly last_run: DreamAgentLastRun | null;
}

export function dreamAgentStatus(
  configPath: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): DreamAgentStatus {
  const cfg = resolveDreamAgentConfig({ config: discoverConfig(configPath).data, env });
  return {
    command: cfg.command?.label ?? null,
    verified_at:
      cfg.command === null ? null : (dreamAgentVerification(cfg.command)?.verified_at ?? null),
    last_run: readDreamAgentLastRun(),
  };
}

/** The dream agent lines of the dream status. */
export function describeDreamAgent(agent: DreamAgentStatus): string[] {
  const lines = [
    agent.command === null
      ? "Dream agent: not set (`o2b dream agent set`)."
      : `Dream agent: ${agent.command}, ` +
        (agent.verified_at === null
          ? "not verified (`o2b dream agent check`)."
          : `verified ${agent.verified_at}.`),
  ];
  const last = agent.last_run;
  if (last !== null) {
    lines.push(
      last.status === "ran"
        ? `  Last run ${last.at}: ${last.agent} (${last.model ?? "no model named"}), ${last.answered} answered, ${last.ended}.`
        : `  Last pass ${last.at}: no session started (${last.status}).`,
    );
  }
  return lines;
}

/**
 * Whether something on this machine answers `operation` now (the queue's
 * per-operation `executor`, change `dream-launched-agent` design D8): the
 * decision model for a closed question whose use it answers, the verified
 * dream agent for a text operation and for a closed question nobody else
 * answers.
 */
export function executorFor(
  operation: string,
  options: {
    readonly configPath?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): boolean {
  const env = options.env ?? process.env;
  const use = useOfOperation(operation);
  if (use !== null) {
    const cfg = resolveDecisionModelConfig({
      env,
      config: discoverConfig(options.configPath).data,
      vault: resolveVault(options.configPath),
    });
    if (cfg.status === "active" && decisionModelModeFor(cfg, use) !== "off") return true;
  } else if (!isTextOperation(operation)) {
    return false;
  }
  return dreamAgentReady(options.configPath, env);
}
