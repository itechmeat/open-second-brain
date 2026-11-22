/**
 * The dream owner status (design D4, D6, D7): what `o2b dream owner`,
 * `brain_dream_owner` `status` and doctor say about the role. Reading the
 * status is a look: on the owner's device it hands a pending request over
 * (design D3) and counts as the catch-up of the claim settle rule.
 */

import { UNCONFIGURED_AGENT_NAME, resolveAgentName } from "../../config.ts";
import { loadBrainConfig } from "../policy/load.ts";
import { lookAtDreamOwner, openDreamOwnerStore } from "./gate.ts";
import type { DreamOwnerRequestOutcome } from "./fold.ts";
import { claimSeen, readDreamOwner } from "./owner.ts";
import { DreamOwnerSettingsUnreadableError } from "./owner.ts";

export interface DreamOwnerStatus {
  /**
   * Whether the role can be held here: `false` for a brain whose records
   * still live in the legacy tree, a machine with no store or no device
   * id. Live passes then run as before this capability.
   */
  readonly enforced: boolean;
  /** Why the role is not enforced, when it is not. */
  readonly reason: "legacy-tree" | "no-store" | "no-device" | "unreadable-settings" | null;
  readonly unreadableState?: string;
  /** This device, when it has one. */
  readonly device: string | null;
  readonly owner: {
    readonly device: string;
    readonly agent: string;
    readonly revision: string;
  } | null;
  readonly isOwner: boolean;
  /** A move the owner's device has not released yet. */
  readonly pending: { readonly device: string; readonly agent: string; readonly at: string } | null;
  /** What became of this device's latest request, if it made one. */
  readonly ownRequest: DreamOwnerRequestOutcome | null;
  /** The device this look handed the role to, when it did. */
  readonly releasedTo: string | null;
  /** On the owner's device: its own claim still waits one catch-up. */
  readonly unsettled: boolean;
  /** The declared `primary_agent`, when one is set. */
  readonly declaredPrimaryAgent: string | null;
}

function declaredPrimaryAgent(vault: string | null): string | null {
  try {
    return loadBrainConfig(vault).primary_agent;
  } catch {
    return null;
  }
}

/**
 * The status of the role for `vault` on this machine. `look: false` reads
 * without writing anything (doctor); `look: true` is the status command,
 * which also releases a pending request on the owner's device.
 */
export function dreamOwnerStatus(
  vault: string | null,
  options: { readonly configPath?: string; readonly look: boolean },
): DreamOwnerStatus {
  const declared = declaredPrimaryAgent(vault);
  const opened = openDreamOwnerStore(vault, options.configPath);
  if (opened.store === null) {
    return {
      enforced: false,
      reason: opened.reason,
      device: null,
      owner: null,
      isOwner: false,
      pending: null,
      ownRequest: null,
      releasedTo: null,
      unsettled: false,
      declaredPrimaryAgent: declared,
    };
  }
  const store = opened.store;
  let state;
  let releasedTo: string | null = null;
  let unsettled = false;
  try {
    if (options.look) {
      const look = lookAtDreamOwner(
        store,
        options.configPath !== undefined ? { configPath: options.configPath } : {},
      );
      state = look.state;
      releasedTo = look.released;
      unsettled = !look.settled;
    } else {
      state = readDreamOwner(store);
      unsettled = state.owner?.device === store.device && !claimSeen(store, state);
    }
  } catch (err) {
    if (!(err instanceof DreamOwnerSettingsUnreadableError)) throw err;
    return {
      enforced: false,
      reason: "unreadable-settings",
      unreadableState: err.state,
      device: store.device,
      owner: null,
      isOwner: false,
      pending: null,
      ownRequest: null,
      releasedTo: null,
      unsettled: false,
      declaredPrimaryAgent: declared,
    };
  }
  const own = state.requests.get(store.device);
  return {
    enforced: true,
    reason: null,
    device: store.device,
    owner: state.owner,
    isOwner: state.owner?.device === store.device,
    pending:
      state.pending === null
        ? null
        : { device: state.pending.device, agent: state.pending.agent, at: state.pending.at },
    ownRequest: own?.outcome ?? null,
    releasedTo,
    unsettled,
    declaredPrimaryAgent: declared,
  };
}

/** The agent name this machine runs as, or `null` when none is configured. */
export function configuredAgentName(configPath: string | undefined): string | null {
  const name = resolveAgentName(configPath).trim();
  return name.length === 0 || name === UNCONFIGURED_AGENT_NAME ? null : name;
}

/** The status in a few plain sentences, for the command line. */
export function describeDreamOwnerStatus(status: DreamOwnerStatus): string[] {
  if (!status.enforced) {
    const why =
      status.reason === "unreadable-settings"
        ? `the settings state needed to read the dream owner is unreadable (${status.unreadableState}); live passes are refused`
        : status.reason === "legacy-tree"
          ? "this brain's records still live in the legacy tree; the dream owner is enforced once the brain moves to the store"
          : status.reason === "no-device"
            ? "this machine has no device id, so it cannot hold the dream owner role"
            : "this machine has no brain store, so no dream owner is bound";
    return [
      status.reason === "unreadable-settings"
        ? `Cannot determine the dream owner: ${why}.`
        : `No dream owner is enforced here: ${why}.`,
      ...requested(status),
    ];
  }
  const lines: string[] = [];
  if (status.owner === null) {
    lines.push(
      "No dream owner is bound: a live dream pass runs from any device. Bind one with " +
        "`o2b dream owner --here --agent <name>` on the device that should run dream.",
    );
    lines.push(...requested(status));
  } else {
    lines.push(
      `The dream owner is ${status.owner.device} (agent ${status.owner.agent}), revision ` +
        `${status.owner.revision}; this device (${status.device}) ` +
        (status.isOwner ? "is the owner." : "is not the owner."),
    );
    if (status.isOwner && status.unsettled) {
      lines.push("This device's claim waits one catch-up before its first live pass.");
    }
    if (
      status.declaredPrimaryAgent !== null &&
      status.declaredPrimaryAgent !== status.owner.agent
    ) {
      lines.push(
        `The declared primary_agent (${status.declaredPrimaryAgent}) differs from the owner's agent.`,
      );
    }
  }
  if (status.releasedTo !== null) {
    lines.push(`This device handed the role to ${status.releasedTo}, as it was asked.`);
  }
  if (status.pending !== null) {
    lines.push(
      `A transfer to ${status.pending.device} (agent ${status.pending.agent}) is pending until ` +
        "the owner's device releases the role.",
    );
  }
  if (status.ownRequest === "lost" && !status.isOwner) {
    lines.push(
      "This device's request for the role lost: " +
        (status.owner === null
          ? "the role was given up before it was granted."
          : `the role went to ${status.owner.device}.`),
    );
  }
  return lines;
}

function requested(status: DreamOwnerStatus): string[] {
  return status.declaredPrimaryAgent === null
    ? []
    : [
        `The declared primary_agent (${status.declaredPrimaryAgent}) is the requested owner; ` +
          "it is not bound until `o2b dream owner --here` runs on its device.",
      ];
}
