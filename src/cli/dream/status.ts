/**
 * `o2b dream status [--vault <path>] [--config <file>] [--json]` (change
 * `dream-session-trigger`, design D7): the state of the dream day in one
 * place: whether automatic dream is on, whether this device is the owner,
 * today, whether the day is closed and why not, the last run with its
 * outcome and the retry time, then the replay and the queue summary.
 * Read-only: it writes nothing and starts nothing.
 */

import { resolveVault } from "../../core/config.ts";
import {
  describeReplayStatus,
  replayStatus,
  replayStatusJson,
} from "../../core/brain/dream-replay/status-view.ts";
import {
  describeQueueStatus,
  queueStatus,
  queueSummaryJson,
  waitingByOperation,
} from "../../core/brain/dream-queue/status-view.ts";
import {
  describeDreamDay,
  dreamDayStatus,
  dreamDayStatusJson,
} from "../../core/brain/dream-trigger/status.ts";
import { CliError, parseFlags } from "../argparse.ts";
import { sortedReplacer } from "../helpers.ts";

export const DREAM_STATUS_USAGE =
  "usage: o2b dream status [--vault <path>] [--config <file>] [--json]";

export function cmdStatus(argv: ReadonlyArray<string>): number {
  const { flags, positional } = parseFlags(argv, {
    vault: { type: "string" },
    config: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length > 0) throw new CliError(`unexpected argument: ${positional[0]}`);
  const configPath = flags["config"] as string | undefined;
  const configOpt = configPath !== undefined ? { configPath } : {};
  const vault = (flags["vault"] as string | undefined) ?? resolveVault(configPath);
  const day = dreamDayStatus(vault, configOpt);
  const queue = queueStatus(vault, configOpt);
  const waiting = waitingByOperation(queue, configOpt);
  const replay = replayStatus(vault, { ...configOpt, queue });
  if (flags["json"] === true) {
    process.stdout.write(
      `${JSON.stringify(
        {
          ok: true,
          ...dreamDayStatusJson(day),
          replay: replayStatusJson(replay),
          queue: queueSummaryJson(queue, waiting),
        },
        sortedReplacer,
        2,
      )}\n`,
    );
    return 0;
  }
  const lines = [
    ...describeDreamDay(day),
    ...describeReplayStatus(replay),
    ...describeQueueStatus(queue, waiting),
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  return 0;
}
