/**
 * The dream owner section of the doctor (change `agent-neutral-dream`,
 * design D7 item 1): who runs live dream passes on this brain, read
 * without writing anything. Every finding is advice on the non-counting
 * channel (`uncertain`), never a warning:
 *
 *  - `dream-owner-unbound`: the brain has no owner, so a live pass runs
 *    from any device; names a declared `primary_agent` as the requested
 *    owner.
 *  - `dream-owner-elsewhere`: this device is not the owner although the
 *    declared `primary_agent` is the agent this machine runs as, so the
 *    person likely expects dream here; live passes run on the owner's
 *    device and the lane's dream task is skipped here. Not reported on
 *    every other device: being one of the devices that preview is the
 *    normal state of all but one machine, and a finding there would keep
 *    every second machine's doctor from ever being clean.
 *  - `dream-owner-pending`: a transfer waits for the owner's device; on
 *    the owner's device it says this device must release it.
 *  - `dream-owner-agent-differs`: the declared `primary_agent` is not the
 *    owner's agent.
 *
 * Silent where the role is not enforced: a brain whose records still live
 * in the legacy tree, a machine with no store or no device id.
 */

import { DREAM_OWNER_COMMAND, DREAM_OWNER_HERE_COMMAND } from "../dream-owner/constants.ts";
import { configuredAgentName, dreamOwnerStatus } from "../dream-owner/status.ts";
import type { DoctorFindings, StoreSideCheckContext, StoreSideDoctorCheck } from "./check.ts";

export const DREAM_OWNER_UNBOUND_CODE = "dream-owner-unbound";
export const DREAM_OWNER_ELSEWHERE_CODE = "dream-owner-elsewhere";
export const DREAM_OWNER_PENDING_CODE = "dream-owner-pending";
export const DREAM_OWNER_AGENT_DIFFERS_CODE = "dream-owner-agent-differs";

export const dreamOwnerCheck: StoreSideDoctorCheck = {
  failSoft: true,
  run(ctx: StoreSideCheckContext, out: DoctorFindings): void {
    const status = dreamOwnerStatus(ctx.vault, {
      ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
      look: false,
    });
    if (!status.enforced) return;
    const owner = status.owner;
    if (owner === null) {
      out.uncertain.push({
        code: DREAM_OWNER_UNBOUND_CODE,
        message:
          "No dream owner is bound: a live dream pass runs from any device. " +
          (status.declaredPrimaryAgent !== null
            ? `The declared primary_agent (${status.declaredPrimaryAgent}) is the requested owner; `
            : "") +
          `bind one with \`${DREAM_OWNER_HERE_COMMAND} --agent <name>\` on the device that should run dream.`,
      });
      return;
    }
    const here = configuredAgentName(ctx.configPath);
    if (!status.isOwner && here !== null && status.declaredPrimaryAgent === here) {
      out.uncertain.push({
        code: DREAM_OWNER_ELSEWHERE_CODE,
        message:
          `The dream owner is ${owner.device} (agent ${owner.agent}); this device ` +
          `(${status.device}) runs no live dream pass and its maintenance lane skips dream. ` +
          `Move the role here with \`${DREAM_OWNER_HERE_COMMAND}\`.`,
      });
    }
    if (status.pending !== null) {
      out.uncertain.push({
        code: DREAM_OWNER_PENDING_CODE,
        message:
          `A transfer of the dream owner role to ${status.pending.device} (agent ` +
          `${status.pending.agent}) is pending. ` +
          (status.isOwner
            ? `This device must release it: run \`${DREAM_OWNER_COMMAND}\` here, or start a session.`
            : `It completes when ${owner.device} next looks at the role.`),
      });
    }
    if (status.declaredPrimaryAgent !== null && status.declaredPrimaryAgent !== owner.agent) {
      out.uncertain.push({
        code: DREAM_OWNER_AGENT_DIFFERS_CODE,
        message:
          `The declared primary_agent (${status.declaredPrimaryAgent}) differs from the dream ` +
          `owner's agent (${owner.agent}); the owner decides who runs dream. Change the owner's ` +
          `agent with \`${DREAM_OWNER_HERE_COMMAND} --agent <name>\` on ${owner.device}.`,
      });
    }
  },
};
