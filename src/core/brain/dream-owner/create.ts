/**
 * The dream owner claim of a newly created brain (design D5): the
 * installation that creates the brain becomes its owner. Shared by the
 * two creating paths, `ensureBrainStore` (`o2b init`, `o2b brain init`)
 * and `o2b store init`. Attaching to an existing store, initialising
 * again and another agent's plugin never call it; the store migration
 * claims the role on the first migrating machine itself (`migrate.ts`).
 */

import { resolveDeviceId } from "../../config.ts";
import { openStore } from "../../store/store-open.ts";
import { DREAM_OWNER_HERE_COMMAND } from "./constants.ts";
import { claimDreamOwner } from "./owner.ts";
import { configuredAgentName } from "./status.ts";

export interface DreamOwnerCreateClaim {
  readonly claimed: boolean;
  readonly message: string;
}

/** The line a brain created with no owner prints. */
export const NO_OWNER_ON_CREATE =
  "No dream owner was bound: no agent name is configured on this machine. Choose one with " +
  `\`${DREAM_OWNER_HERE_COMMAND} --agent <name>\` on the device that should run dream.`;

/**
 * Claim the role for this device and the configured agent on a store just
 * created at `root`. With no agent name it claims nothing and says how to
 * choose; with no usable device id likewise.
 */
export function claimDreamOwnerOnCreate(
  root: string,
  configPath: string | undefined,
): DreamOwnerCreateClaim {
  const agent = configuredAgentName(configPath);
  if (agent === null) return { claimed: false, message: NO_OWNER_ON_CREATE };
  let device: string;
  try {
    device = resolveDeviceId(configPath);
    const claim = claimDreamOwner(openStore({ root, device }), agent, {
      writer: agent,
      authority: "human",
    });
    return claim.claimed
      ? {
          claimed: true,
          message: `This machine (${device}) and its agent ${agent} own dream on this brain.`,
        }
      : {
          claimed: false,
          message: `The dream owner is ${claim.owner.device} (agent ${claim.owner.agent}).`,
        };
  } catch (err) {
    // The store already exists; a failed claim is a warning, not a failed
    // creation. Bind it later with the command in the message.
    return {
      claimed: false,
      message:
        `No dream owner was bound (${err instanceof Error ? err.message : String(err)}); ` +
        `run \`${DREAM_OWNER_HERE_COMMAND} --agent <name>\` on the device that should run dream.`,
    };
  }
}
