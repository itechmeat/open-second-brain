/**
 * `brain_dream_owner` (change `agent-neutral-dream`, design D4): the MCP
 * twin of `o2b dream owner`. One tool, three operations:
 *
 *  - `status`: the owner's device and agent, whether this device is the
 *    owner, the revision and a pending transfer. Served at every reach;
 *    it names devices and agents, never a host path. At local reach the
 *    owner's device also hands a pending request over, as the command
 *    does; at remote reach it only reads.
 *  - `take`: take the role on this device for the calling agent (adopt an
 *    unbound brain, change the agent on the owner's device, or ask the
 *    owner's device for it). Local reach only.
 *  - `release`: give the role up with no successor. Local reach only.
 *
 * There is no forced transfer here: that is a person's decision on the
 * command line (`o2b dream owner --here --force`). The move carries agent
 * authority and goes through no settings write, so a transfer a person
 * made earlier does not block it.
 */

import { TRANSPORT_REACH } from "../../core/graph/transport-reach.ts";
import { openDreamOwnerStore } from "../../core/brain/dream-owner/gate.ts";
import { releaseDreamOwner, takeDreamOwner } from "../../core/brain/dream-owner/owner.ts";
import {
  configuredAgentName,
  describeDreamOwnerStatus,
  dreamOwnerStatus,
} from "../../core/brain/dream-owner/status.ts";
import {
  queueStatus,
  queueSummaryJson,
  waitingByOperation,
} from "../../core/brain/dream-queue/status-view.ts";
import { coerceStr, unknownOperationError } from "../coerce.ts";
import { INVALID_PARAMS, MCPError } from "../protocol.ts";
import {
  contextReach,
  contextVault,
  type ServerContext,
  type ToolDefinition,
} from "../tool-contract.ts";

const OPERATIONS = ["status", "take", "release"] as const;
type DreamOwnerOperation = (typeof OPERATIONS)[number];

/** The one answer a caller below local reach gets for a move. */
const LOCAL_REACH_ONLY =
  "brain_dream_owner: take and release move the dream owner role and run at local reach only";

async function toolBrainDreamOwner(
  ctx: ServerContext,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const operation = (coerceStr(args, "operation", false) ?? "status") as DreamOwnerOperation;
  if (!(OPERATIONS as ReadonlyArray<string>).includes(operation)) {
    throw unknownOperationError(
      `brain_dream_owner: 'operation' must be one of ${OPERATIONS.join(", ")}`,
    );
  }
  const local = contextReach(ctx) === TRANSPORT_REACH.local;
  if (operation !== "status" && !local) throw new MCPError(INVALID_PARAMS, LOCAL_REACH_ONLY);
  const vault = contextVault(ctx);
  const configOpt = ctx.configPath ? { configPath: ctx.configPath } : {};

  if (operation === "status") {
    const status = dreamOwnerStatus(vault, { ...configOpt, look: local });
    return {
      operation,
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
      summary: describeDreamOwnerStatus(status).join(" "),
      // Below local reach the private partition's work is withheld.
      queue: ((queue) => queueSummaryJson(queue, waitingByOperation(queue, configOpt)))(
        queueStatus(vault, { ...configOpt, withholdPrivate: !local }),
      ),
    };
  }

  const opened = openDreamOwnerStore(vault, ctx.configPath ?? undefined);
  if (opened.store === null) {
    const status = dreamOwnerStatus(vault, { ...configOpt, look: false });
    throw new MCPError(
      INVALID_PARAMS,
      `brain_dream_owner: ${describeDreamOwnerStatus(status)[0]!}`,
    );
  }
  const store = opened.store;
  // The agent the transport minted for this request (a per-agent token),
  // else the configured one.
  const caller =
    ctx.requestIdentity?.agent ?? configuredAgentName(ctx.configPath ?? undefined) ?? null;
  const writer = { writer: caller ?? "agent", authority: "agent" as const };

  if (operation === "release") {
    const result = releaseDreamOwner(store, writer);
    if (result.status === "not-owner") {
      throw new MCPError(
        INVALID_PARAMS,
        `brain_dream_owner: this device (${store.device}) is not the dream owner`,
        { owner: result.owner },
      );
    }
    return { operation, status: "released", device: store.device };
  }

  // A plain name: generic agent names (`codex`, `claude`) are exactly the
  // installations that own dream, so no placeholder filter applies here.
  const named = coerceStr(args, "owner_agent", false)?.trim().replace(/^@+/, "") ?? "";
  const agent = named.length > 0 ? named : caller;
  if (agent === null) {
    throw new MCPError(
      INVALID_PARAMS,
      "brain_dream_owner: no agent name is configured on this server; pass owner_agent",
    );
  }
  const result = takeDreamOwner(store, agent, { ...writer, force: false });
  return {
    operation,
    status: result.status,
    device: store.device,
    agent,
    ...(result.status !== "already-owner" ? { previous: result.previous } : {}),
  };
}

export const DREAM_OWNER_TOOLS: ReadonlyArray<ToolDefinition> = Object.freeze([
  {
    name: "brain_dream_owner",
    kind: "write",
    description:
      "The dream owner: the one device (and agent) that runs live dream passes. status shows it and a pending transfer; take moves the role to this device (adopt, change agent, or ask the owner's device); release gives it up. Moves at local reach only.",
    inputSchema: {
      type: "object",
      properties: {
        operation: {
          type: "string",
          enum: [...OPERATIONS],
          description: "status (default), take, or release.",
        },
        owner_agent: {
          type: "string",
          maxLength: 128,
          description: "operation=take: the owner's agent; default the calling agent.",
        },
      },
      additionalProperties: false,
    },
    handler: toolBrainDreamOwner,
  },
]);
