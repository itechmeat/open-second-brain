/**
 * `o2b dream owner` (change `agent-neutral-dream`, design D4): show the
 * dream owner, or move it.
 *
 *  - `owner`: the owner's device and agent, whether this device is the
 *    owner, the revision and a pending transfer. On the owner's device it
 *    also hands a pending request over.
 *  - `owner --here [--agent <name>]`: take the role on this device. On an
 *    unbound brain this adopts it; on the owner's device it changes the
 *    agent at once; on another device it asks the owner's device, which
 *    releases the role at its next look.
 *  - `owner --here --force`: take the role at once, without a release, for
 *    an owner device that is lost. The old owner keeps passing its own
 *    gate until the forced claim reaches it.
 *  - `owner --release`: give the role up with no successor.
 *
 * `o2b brain dream` is unchanged; this group holds the role's own verbs.
 */

import {
  describeReplayStatus,
  replayStatus,
  replayStatusJson,
} from "../../core/brain/dream-replay/status-view.ts";
import { cmdAgent, DREAM_AGENT_USAGE } from "./agent.ts";
import { ConfigReadError, resolveVault } from "../../core/config.ts";
import {
  releaseDreamOwner,
  takeDreamOwner,
  type DreamOwnerTakeResult,
} from "../../core/brain/dream-owner/owner.ts";
import { openDreamOwnerStore } from "../../core/brain/dream-owner/gate.ts";
import {
  configuredAgentName,
  describeDreamOwnerStatus,
  dreamOwnerStatus,
  type DreamOwnerStatus,
} from "../../core/brain/dream-owner/status.ts";
import { StoreOpenError } from "../../core/store/store-open.ts";
import { isLockContention } from "../../core/store/local-lock.ts";
import { CliError, parseFlags } from "../argparse.ts";
import { sortedReplacer } from "../helpers.ts";
import { cmdQueue, DREAM_QUEUE_USAGE } from "./queue.ts";
import {
  describeDreamAgent,
  describeQueueStatus,
  dreamAgentStatus,
  queueStatus,
  queueSummaryJson,
  waitingByOperation,
} from "../../core/brain/dream-queue/status-view.ts";

const USAGE = [
  "usage: o2b dream owner [--vault <path>] [--config <file>] [--json]",
  "       o2b dream owner --here [--agent <name>] [--force] [--vault <path>] [--config <file>] [--json]",
  "       o2b dream owner --release [--vault <path>] [--config <file>] [--json]",
  DREAM_QUEUE_USAGE.replace(/^usage: /, "       "),
  DREAM_AGENT_USAGE.replace(/^usage: /, "       "),
].join("\n");

const DREAM_EXIT = Object.freeze({ ok: 0, refused: 1, usage: 2 } as const);

export async function handleDreamSubcommand(argv: ReadonlyArray<string>): Promise<number> {
  const verb = argv[0];
  if (verb === undefined || verb === "-h" || verb === "--help") {
    process.stdout.write(`${USAGE}\n`);
    return verb === undefined ? DREAM_EXIT.usage : DREAM_EXIT.ok;
  }
  const rest = argv.slice(1);
  try {
    switch (verb) {
      case "owner":
        return cmdOwner(rest);
      case "queue":
        return cmdQueue(rest);
      case "agent":
        return await cmdAgent(rest);
      default:
        process.stderr.write(`error: unknown dream verb: ${verb}\n${USAGE}\n`);
        return DREAM_EXIT.usage;
    }
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`error: ${err.message}\n${USAGE}\n`);
      return DREAM_EXIT.usage;
    }
    if (!(err instanceof StoreOpenError || err instanceof ConfigReadError || isLockContention(err)))
      throw err;
    return refuse(err instanceof Error ? err.message : String(err), rest.includes("--json"));
  }
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, sortedReplacer, 2)}\n`);
}

function refuse(message: string, json: boolean, extra: Record<string, unknown> = {}): number {
  if (json) writeJson({ ok: false, ...extra, error: message });
  process.stderr.write(`error: ${message}\n`);
  return DREAM_EXIT.refused;
}

/** The status as the `--json` answer spells it. */
export function dreamOwnerStatusJson(status: DreamOwnerStatus): Record<string, unknown> {
  return {
    enforced: status.enforced,
    reason: status.reason,
    device: status.device,
    owner: status.owner,
    is_owner: status.isOwner,
    pending: status.pending,
    own_request: status.ownRequest,
    released_to: status.releasedTo,
    unsettled: status.unsettled,
    declared_primary_agent: status.declaredPrimaryAgent,
  };
}

function cmdOwner(argv: ReadonlyArray<string>): number {
  const { flags, positional } = parseFlags(argv, {
    here: { type: "boolean" },
    agent: { type: "string" },
    force: { type: "boolean" },
    release: { type: "boolean" },
    vault: { type: "string" },
    config: { type: "string" },
    json: { type: "boolean" },
  });
  if (positional.length > 0) throw new CliError(`unexpected argument: ${positional[0]}`);
  const here = flags["here"] === true;
  const release = flags["release"] === true;
  if (here && release) throw new CliError("--here and --release are opposite moves; pass one");
  if (flags["force"] === true && !here) {
    throw new CliError("--force takes the role here, so it needs --here");
  }
  if (flags["agent"] !== undefined && !here) {
    throw new CliError("--agent names the owner's agent, so it needs --here");
  }
  const configPath = flags["config"] as string | undefined;
  const json = flags["json"] === true;
  const vault = (flags["vault"] as string | undefined) ?? resolveVault(configPath);
  const configOpt = configPath !== undefined ? { configPath } : {};

  if (!here && !release) {
    const status = dreamOwnerStatus(vault, { ...configOpt, look: true });
    const queue = queueStatus(vault, configOpt);
    const waiting = waitingByOperation(queue, configOpt);
    const replay = replayStatus(vault, { ...configOpt, queue });
    if (json)
      writeJson({
        ok: true,
        ...dreamOwnerStatusJson(status),
        queue: queueSummaryJson(queue, waiting),
        replay: replayStatusJson(replay),
        agent: dreamAgentStatus(configPath),
      });
    else {
      const lines = [
        ...describeDreamOwnerStatus(status),
        ...describeQueueStatus(queue, waiting),
        ...describeReplayStatus(replay),
        ...describeDreamAgent(dreamAgentStatus(configPath)),
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
    }
    return DREAM_EXIT.ok;
  }

  const opened = openDreamOwnerStore(vault, configPath);
  if (opened.store === null) {
    const status = dreamOwnerStatus(vault, { ...configOpt, look: false });
    return refuse(describeDreamOwnerStatus(status)[0]!, json, { reason: opened.reason });
  }
  const store = opened.store;
  const writer = { writer: "o2b", authority: "human" as const };

  if (release) {
    let result;
    try {
      result = releaseDreamOwner(store, writer);
    } catch (err) {
      if (!isLockContention(err)) throw err;
      return refuse(err instanceof Error ? err.message : String(err), json, {
        reason: "lock-busy",
      });
    }
    if (result.status === "not-owner") {
      const who =
        result.owner === null
          ? "no device holds the dream owner role"
          : `the dream owner is ${result.owner.device} (agent ${result.owner.agent})`;
      return refuse(`this device (${store.device}) is not the dream owner; ${who}`, json, {
        reason: "not-owner",
      });
    }
    if (json) writeJson({ ok: true, status: "released", device: store.device });
    else {
      process.stdout.write(
        `This device (${store.device}) gave the dream owner role up; no device holds it now.\n`,
      );
    }
    return DREAM_EXIT.ok;
  }

  const agentFlag = (flags["agent"] as string | undefined)?.trim();
  const agent =
    agentFlag !== undefined && agentFlag.length > 0 ? agentFlag : configuredAgentName(configPath);
  if (agent === null) {
    return refuse(
      "no agent name is configured on this machine; name the owner's agent with --agent <name>",
      json,
      { reason: "no-agent" },
    );
  }
  const result = takeDreamOwner(store, agent, { ...writer, force: flags["force"] === true });
  if (json) {
    writeJson({ ok: true, ...describeTake(result), device: store.device, agent });
  } else {
    process.stdout.write(`${takeMessage(result, store.device, agent)}\n`);
  }
  if (result.status === "forced" && result.warning !== null) {
    process.stderr.write(`warning: ${result.warning}\n`);
  }
  return DREAM_EXIT.ok;
}

function describeTake(result: DreamOwnerTakeResult): Record<string, unknown> {
  if (result.status === "already-owner") return { status: result.status };
  return {
    status: result.status,
    previous: result.previous,
    ...(result.warning !== null ? { warning: result.warning } : {}),
  };
}

function takeMessage(result: DreamOwnerTakeResult, device: string, agent: string): string {
  switch (result.status) {
    case "already-owner":
      return `This device (${device}) is already the dream owner, with agent ${agent}.`;
    case "taken":
      return (
        `This device (${device}) is the dream owner now, with agent ${agent}. Its first live ` +
        "pass waits one catch-up, so a rival claim still in transit can arrive."
      );
    case "agent-changed":
      return `The dream owner's agent on this device (${device}) is ${agent} now.`;
    case "forced":
      return `This device (${device}) is the dream owner now, with agent ${agent}, without a release.`;
    case "requested":
      return (
        `Asked ${result.previous!.device} to hand the dream owner role to this device (${device}). ` +
        "It releases the role the next time it looks at it (a dream pass, its status, or a " +
        "session start); until then this device previews only. The request is pending."
      );
  }
}
