/**
 * The dream work queue section of the doctor (change `dream-work-queue`,
 * design D8 item 1), read without writing anything:
 *
 *  - `dream-queue-parked` (error, one per parked item): its operation,
 *    the reason of its last failure and the command that retries it.
 *  - `dream-queue-backlog` (warning): ready work older than the reporting
 *    threshold, with the count and the oldest age.
 *  - `dream-queue-no-executor` (advice, per operation): items of an
 *    operation wait and nothing on this machine answers them; for a
 *    closed question it names the setting that does
 *    (`decision_model_uses` with the use and `enforce`).
 *  - `dream-questions-waiting` (advice, per closed question): how many
 *    wait, the oldest age, and why, each reason with the action that
 *    changes it (change `dream-closed-questions`, design D7).
 *  - `dream-queue-unknown-operation` (warning): items of an operation
 *    this build does not know (a newer release produced them).
 *  - `dream-queue-rejected` (warning): records the fold rejected, by kind.
 *  - `dream-agent-unset` (advice): work waits that only the dream agent
 *    may do and no dream agent command is set (change
 *    `dream-launched-agent`, design D8).
 *  - `dream-agent-unverified` (warning): a command is set and was never
 *    verified, or it changed since.
 *  - `dream-agent-failed` (warning): the last run of the dream agent failed.
 *  - `dream-drafts-waiting` (advice): text answers await review.
 *
 * Silent where there is no queue: a brain still in the legacy tree, a
 * machine with no store. Below local reach the private partition is
 * withheld, as everywhere.
 */

import { DREAM_QUEUE_COMMAND, DREAM_WORK_BACKLOG_MS } from "../dream-queue/constants.ts";
import {
  describeWaitingGroup,
  queueStatus,
  waitingByOperation,
} from "../dream-queue/status-view.ts";
import type { DoctorFindings, StoreSideCheckContext, StoreSideDoctorCheck } from "./check.ts";
import { discoverConfig } from "../../config.ts";
import { resolveDreamAgentConfig } from "../dream-queue/agent-config.ts";
import { dreamAgentVerification, readDreamAgentLastRun } from "../dream-queue/agent-verified.ts";

export const DREAM_QUEUE_PARKED_CODE = "dream-queue-parked";
export const DREAM_QUEUE_BACKLOG_CODE = "dream-queue-backlog";
export const DREAM_QUEUE_NO_EXECUTOR_CODE = "dream-queue-no-executor";
export const DREAM_QUEUE_UNKNOWN_OPERATION_CODE = "dream-queue-unknown-operation";
export const DREAM_QUEUE_REJECTED_CODE = "dream-queue-rejected";
export const DREAM_QUESTIONS_WAITING_CODE = "dream-questions-waiting";
export const DREAM_AGENT_UNSET_CODE = "dream-agent-unset";
export const DREAM_AGENT_UNVERIFIED_CODE = "dream-agent-unverified";
export const DREAM_AGENT_FAILED_CODE = "dream-agent-failed";
export const DREAM_DRAFTS_WAITING_CODE = "dream-drafts-waiting";

export const dreamQueueCheck: StoreSideDoctorCheck = {
  failSoft: true,
  run(ctx: StoreSideCheckContext, out: DoctorFindings): void {
    const status = queueStatus(ctx.vault, {
      ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
      now: ctx.now.getTime(),
      withholdPrivate: ctx.withholdsPrivate === true,
    });
    if (!status.available) return;
    for (const parked of status.parked) {
      out.issues.push({
        severity: "error",
        code: DREAM_QUEUE_PARKED_CODE,
        message:
          `dream work ${parked.id} (${parked.operation}) is parked after repeated failures: ` +
          `${parked.reason}; the work behind it waits. Retry it with \`${parked.retry_command}\``,
      });
    }
    if (status.backlog && status.oldest_ready !== null) {
      const hours = Math.floor(status.oldest_ready.age_ms / 3_600_000);
      out.issues.push({
        severity: "warning",
        code: DREAM_QUEUE_BACKLOG_CODE,
        message:
          `${status.ready} dream work item(s) are ready and the oldest has waited ${hours} h ` +
          `(more than ${DREAM_WORK_BACKLOG_MS / 3_600_000} h); list them with \`${DREAM_QUEUE_COMMAND}\``,
      });
    }
    const waiting = waitingByOperation(status, {
      ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
      now: ctx.now.getTime(),
    });
    let agentWork = 0;
    for (const group of waiting) {
      agentWork += (group.reasons["no-agent"] ?? 0) + (group.reasons["no-model"] ?? 0);
      const unanswered =
        (group.reasons["no-model"] ?? 0) +
        (group.reasons["no-executor"] ?? 0) +
        (group.reasons["no-agent"] ?? 0);
      if (unanswered > 0) {
        out.uncertain.push({
          code: DREAM_QUEUE_NO_EXECUTOR_CODE,
          message:
            group.use === null && (group.reasons["no-agent"] ?? 0) > 0
              ? `${unanswered} ${group.operation} dream work item(s) wait, and only the dream ` +
                "agent answers them: set it with `o2b dream agent set` and verify it with " +
                "`o2b dream agent check`; until then they are kept, never written by a fixed rule"
              : group.use === null
                ? `${unanswered} ${group.operation} dream work item(s) wait for a model, and this ` +
                  "version has nothing that answers them; they are kept, never decided by a fixed " +
                  "rule, and not counted as done"
                : `${unanswered} ${group.operation} item(s) wait and neither a decision model nor ` +
                  `the dream agent answers ${group.use}: configure a decision model and set ` +
                  `\`decision_model_uses\` to include \`${group.use}:enforce\`, or set and check a ` +
                  "dream agent; until then they are kept, never decided by a fixed rule",
        });
      }
      if (group.use !== null) {
        out.uncertain.push({
          code: DREAM_QUESTIONS_WAITING_CODE,
          message: `closed questions: ${describeWaitingGroup(group)}`,
        });
      }
    }
    const env = process.env;
    const agentCfg = resolveDreamAgentConfig({
      config: discoverConfig(ctx.configPath).data,
      env,
    });
    if (agentCfg.command === null) {
      if (agentWork > 0) {
        out.uncertain.push({
          code: DREAM_AGENT_UNSET_CODE,
          message:
            `${agentWork} dream work item(s) wait that only the dream agent may do (text, or ` +
            "closed questions no decision model answers), and no dream agent is set: set one " +
            "with `o2b dream agent set <preset | JSON array>` and verify it with " +
            "`o2b dream agent check`",
        });
      }
    } else if (dreamAgentVerification(agentCfg.command) === null) {
      out.issues.push({
        severity: "warning",
        code: DREAM_AGENT_UNVERIFIED_CODE,
        message:
          "the dream agent command was never verified, or it changed since it was; it is not " +
          "used for real work until `o2b dream agent check` passes",
      });
    }
    const last = readDreamAgentLastRun();
    if (last !== null && last.status === "ran" && last.failed) {
      out.issues.push({
        severity: "warning",
        code: DREAM_AGENT_FAILED_CODE,
        message:
          `the last dream agent run (${last.agent}, ${last.at}) failed: ${last.ended}, ` +
          `${last.answered} answered; check the command with \`o2b dream agent check\``,
      });
    }
    const drafts = status.counts["awaiting-review"];
    if (drafts > 0) {
      out.uncertain.push({
        code: DREAM_DRAFTS_WAITING_CODE,
        message:
          `${drafts} text answer(s) of the dream agent await review: list them with ` +
          `\`${DREAM_QUEUE_COMMAND} --state awaiting-review\`, then approve or reject each`,
      });
    }
    for (const operation of status.unknown_operations) {
      out.issues.push({
        severity: "warning",
        code: DREAM_QUEUE_UNKNOWN_OPERATION_CODE,
        message:
          `dream work of the operation ${operation} waits, and this version does not know that ` +
          "operation (a newer release produced it); update Open Second Brain on this machine",
      });
    }
    const rejected = Object.entries(status.rejected);
    if (rejected.length > 0) {
      out.issues.push({
        severity: "warning",
        code: DREAM_QUEUE_REJECTED_CODE,
        message:
          "the dream work queue holds records that break its rules and are ignored: " +
          rejected.map(([kind, n]) => `${n} ${kind}`).join(", "),
      });
    }
  },
};
