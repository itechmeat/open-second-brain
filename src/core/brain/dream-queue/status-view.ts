/**
 * The dream work queue as the surfaces show it (design D8): the doctor
 * check, the dream owner status (CLI and MCP) and `o2b dream queue`.
 *
 * Importing this module registers the production operations, so a
 * surface never reports this build's own work as an unknown operation.
 */

import "./rollup-work.ts";
import { DREAM_QUEUE_COMMAND } from "./constants.ts";
import { queueStatus, type DreamQueueStatus } from "./queue.ts";

export { queueStatus, type DreamQueueStatus };

function hours(ms: number): string {
  const h = ms / 3_600_000;
  return h < 1 ? `${Math.round(ms / 60_000)} min` : `${h.toFixed(1)} h`;
}

/** The status without the item list: the section the owner status carries. */
export function queueSummaryJson(status: DreamQueueStatus): Record<string, unknown> {
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
  };
}

/** Lines for a person: counts, the oldest ready item, parked items, and what waiting means. */
export function describeQueueStatus(status: DreamQueueStatus): string[] {
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
  if (c.waiting + c.leased + c.accepted + c.parked > 0) {
    lines.push(
      "  Nothing in this version answers queued work; it waits, and no surface counts it as done. " +
        `List it with \`${DREAM_QUEUE_COMMAND}\`.`,
    );
  }
  return lines;
}
