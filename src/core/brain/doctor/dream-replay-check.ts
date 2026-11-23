/**
 * The dream replay section of the doctor (change `dream-replay`, design
 * D10 item 2), read without writing anything:
 *
 *  - `dream-replay-behind` (advice, when more than one window is behind):
 *    the count, and the command that replays them.
 *  - `dream-replay-gap` (warning): a source whose read was incomplete at
 *    the newest admission, by name; the window waits for it, or was
 *    admitted without it after three days. Also the `dream-replay` stream
 *    itself, when it cannot be read completely here: the windows are then
 *    unknown, and no count is given.
 *  - `dream-replay-rebased` (warning, once per rebase): a replaced or
 *    rewritten shard, and how many records were taken as seen.
 *  - `dream-replay-waiting-sync` (advice): this device became the owner
 *    through a release whose last covered window has not arrived here.
 *  - `dream-replay-unrecoverable` (advice, once): signals archived before
 *    the replay existed that may have qualified for a promotion.
 *  - `dream-replay-policy-changed` (advice): windows were planned under
 *    settings that have changed since.
 *
 * Silent where there is no replay: a brain still in the legacy tree, a
 * machine with no store or without the `shared` partition.
 */

import { loadBrainConfig } from "../policy.ts";
import { daysBehind, DREAM_REPLAY_COMMAND, readConfiguredReplay } from "../dream-replay/behind.ts";
import { DreamReplayUnreadableError } from "../dream-replay/pass.ts";
import { policyDigest } from "../dream-replay/plan.ts";
import { replayWaitsForSync } from "../dream-replay/transfer.ts";
import type { DoctorFindings, StoreSideCheckContext, StoreSideDoctorCheck } from "./check.ts";

export const DREAM_REPLAY_BEHIND_CODE = "dream-replay-behind";
export const DREAM_REPLAY_GAP_CODE = "dream-replay-gap";
export const DREAM_REPLAY_REBASED_CODE = "dream-replay-rebased";
export const DREAM_REPLAY_WAITING_SYNC_CODE = "dream-replay-waiting-sync";
export const DREAM_REPLAY_UNRECOVERABLE_CODE = "dream-replay-unrecoverable";
export const DREAM_REPLAY_POLICY_CHANGED_CODE = "dream-replay-policy-changed";

export const dreamReplayCheck: StoreSideDoctorCheck = {
  failSoft: true,
  run(ctx: StoreSideCheckContext, out: DoctorFindings): void {
    let state: ReturnType<typeof readConfiguredReplay>;
    try {
      state = readConfiguredReplay(ctx.vault, ctx.configPath);
    } catch (error) {
      if (!(error instanceof DreamReplayUnreadableError)) throw error;
      // A count from part of the stream would be wrong: say it is unknown.
      out.issues.push({
        severity: "warning",
        code: DREAM_REPLAY_GAP_CODE,
        message: `the dream replay's windows are unknown here: ${error.message}`,
      });
      return;
    }
    if (state === null) return;
    const behind = daysBehind(state, ctx.now);
    if (behind.length > 1) {
      out.uncertain.push({
        code: DREAM_REPLAY_BEHIND_CODE,
        message:
          `${behind.length} dream windows are behind (${behind[0]} to ${behind.at(-1)}); ` +
          `the next live pass replays them, or run \`${DREAM_REPLAY_COMMAND}\``,
      });
    }
    const latest = state.latestAdmission?.body ?? null;
    for (const gap of latest?.gaps ?? []) {
      out.issues.push({
        severity: "warning",
        code: DREAM_REPLAY_GAP_CODE,
        message:
          `the dream window of ${latest!.day} waits for ${gap.partition}/${gap.shard}, ` +
          `which could not be read completely since ${gap.since}: ${gap.reason}`,
      });
    }
    for (const left of latest?.left_out ?? []) {
      out.issues.push({
        severity: "warning",
        code: DREAM_REPLAY_GAP_CODE,
        message:
          `the dream window of ${latest!.day} went on without ${left.partition}/${left.shard}, ` +
          `incomplete since ${left.since}; its records are admitted as late once it reads`,
      });
    }
    for (const admission of state.admissions.values()) {
      if (admission.body.rebased === null) continue;
      out.issues.push({
        severity: "warning",
        code: DREAM_REPLAY_REBASED_CODE,
        message:
          `the dream window of ${admission.body.day} was admitted after shards were replaced or ` +
          `rewritten (${admission.body.rebased.shards.join(", ")}); ` +
          `${admission.body.rebased.seen} record(s) could not be told apart and were taken as seen`,
      });
    }
    const waiting = replayWaitsForSync(ctx.vault, state, ctx.configPath);
    if (waiting !== null) {
      out.uncertain.push({ code: DREAM_REPLAY_WAITING_SYNC_CODE, message: waiting });
    }
    if (state.bootstrap !== null && state.bootstrap.unrecoverable > 0) {
      out.uncertain.push({
        code: DREAM_REPLAY_UNRECOVERABLE_CODE,
        message:
          `${state.bootstrap.unrecoverable} signal(s) were archived before the dream replay ` +
          "existed and may have qualified for a promotion that never happened; they are counted, " +
          "not reopened",
      });
    }
    let current: string | null = null;
    try {
      current = policyDigest(loadBrainConfig(ctx.vault));
    } catch {
      current = null;
    }
    const changed = [...state.plans.values()].filter(
      (plan) =>
        current !== null &&
        typeof plan.body["policy_digest"] === "string" &&
        plan.body["policy_digest"] !== current,
    ).length;
    if (changed > 0) {
      out.uncertain.push({
        code: DREAM_REPLAY_POLICY_CHANGED_CODE,
        message:
          `${changed} dream window(s) were planned under settings that have changed since; ` +
          "their outcomes stand",
      });
    }
  },
};
