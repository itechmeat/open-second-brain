/**
 * `o2b dream queue` (change `dream-work-queue`, design D8 item 3): the
 * queue of dream work that needs a model.
 *
 *  - `queue [--state <state>] [--json]`: counts by state, the oldest ready
 *    item, parked items with their reasons, and the items. Readable on
 *    any device; it shows only the partitions this device holds.
 *  - `queue retry <id>`: offer a parked item again, its attempts counted
 *    from zero.
 *  - `queue cancel <id> --reason <text>`: close an item.
 *
 * Retry and cancel are a person's moves and pass the dream owner gate:
 * refused on a device that is not the owner.
 */

import { resolveVault } from "../../core/config.ts";
import { DreamNotOwnerError, openDreamOwnerStore } from "../../core/brain/dream-owner/gate.ts";
import { DREAM_WORK_STATES } from "../../core/brain/dream-queue/constants.ts";
import {
  cancelWork,
  DreamQueueItemError,
  DreamQueueUnboundError,
  dreamQueueOn,
  retryWork,
} from "../../core/brain/dream-queue/queue.ts";
import {
  describeQueueStatus,
  queueStatus,
  waitingByOperation,
} from "../../core/brain/dream-queue/status-view.ts";
import { CliError, parseFlags } from "../argparse.ts";
import { sortedReplacer } from "../helpers.ts";

export const DREAM_QUEUE_USAGE = [
  "usage: o2b dream queue [--state <state>] [--vault <path>] [--config <file>] [--json]",
  "       o2b dream queue retry <id> [--vault <path>] [--config <file>] [--json]",
  "       o2b dream queue cancel <id> --reason <text> [--vault <path>] [--config <file>] [--json]",
].join("\n");

const EXIT = Object.freeze({ ok: 0, refused: 1 } as const);

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, sortedReplacer, 2)}\n`);
}

export function cmdQueue(argv: ReadonlyArray<string>): number {
  const { flags, positional } = parseFlags(argv, {
    state: { type: "string" },
    reason: { type: "string" },
    vault: { type: "string" },
    config: { type: "string" },
    json: { type: "boolean" },
  });
  const configPath = flags["config"] as string | undefined;
  const json = flags["json"] === true;
  const vault = (flags["vault"] as string | undefined) ?? resolveVault(configPath);
  const verb = positional[0];
  if (verb === undefined) {
    if (flags["reason"] !== undefined) throw new CliError("--reason belongs to `queue cancel`");
    return list(vault, configPath, flags["state"] as string | undefined, json);
  }
  if (verb !== "retry" && verb !== "cancel") throw new CliError(`unknown queue verb: ${verb}`);
  const id = positional[1];
  if (id === undefined) throw new CliError(`queue ${verb} needs an item id`);
  if (positional.length > 2) throw new CliError(`unexpected argument: ${positional[2]}`);
  const reason = (flags["reason"] as string | undefined)?.trim();
  if (verb === "cancel" && (reason === undefined || reason === "")) {
    throw new CliError("queue cancel needs --reason <text>");
  }
  if (verb === "retry" && reason !== undefined)
    throw new CliError("--reason belongs to `queue cancel`");
  return change(vault, configPath, verb, id, reason ?? "", json);
}

function list(
  vault: string | null,
  configPath: string | undefined,
  state: string | undefined,
  json: boolean,
): number {
  if (state !== undefined && !(DREAM_WORK_STATES as ReadonlyArray<string>).includes(state)) {
    throw new CliError(`--state must be one of ${DREAM_WORK_STATES.join(", ")}`);
  }
  const configOpt = configPath !== undefined ? { configPath } : {};
  const status = queueStatus(vault, configOpt);
  const waiting = waitingByOperation(status, configOpt);
  if (json) {
    if (!status.available) writeJson(status);
    else
      writeJson({
        ...status,
        waiting,
        items: status.items.filter((i) => state === undefined || i.state === state),
      });
    return EXIT.ok;
  }
  const lines = describeQueueStatus(status, waiting);
  if (status.available) {
    for (const item of status.items) {
      if (state !== undefined && item.state !== state) continue;
      lines.push(
        `${item.id}  ${item.state}${item.ready ? " (ready)" : ""}  ${item.operation}  ` +
          `${item.subject}  attempts ${item.attempts}${item.reason !== null ? `  ${item.reason}` : ""}`,
      );
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
  return EXIT.ok;
}

function refuse(message: string, json: boolean, code?: string): number {
  if (json) writeJson({ ok: false, error: message, ...(code !== undefined ? { code } : {}) });
  process.stderr.write(`error: ${message}\n`);
  return EXIT.refused;
}

function change(
  vault: string | null,
  configPath: string | undefined,
  verb: "retry" | "cancel",
  id: string,
  reason: string,
  json: boolean,
): number {
  const opened = openDreamOwnerStore(vault, configPath);
  if (opened.store === null) {
    return refuse(`there is no dream work queue here (${opened.reason})`, json);
  }
  const queue = dreamQueueOn(opened.store, {
    vault,
    writer: "o2b",
    ...(configPath !== undefined ? { configPath } : {}),
  });
  try {
    if (verb === "retry") retryWork(queue, id);
    else cancelWork(queue, id, reason);
  } catch (err) {
    if (
      err instanceof DreamNotOwnerError ||
      err instanceof DreamQueueUnboundError ||
      err instanceof DreamQueueItemError
    ) {
      const code =
        err instanceof DreamNotOwnerError || err instanceof DreamQueueUnboundError
          ? err.code
          : undefined;
      return refuse(err.message, json, code);
    }
    throw err;
  }
  if (json) writeJson({ ok: true, status: verb === "retry" ? "retried" : "cancelled", id });
  else {
    process.stdout.write(
      verb === "retry"
        ? `Dream work ${id} is offered again.\n`
        : `Dream work ${id} is cancelled.\n`,
    );
  }
  return EXIT.ok;
}
