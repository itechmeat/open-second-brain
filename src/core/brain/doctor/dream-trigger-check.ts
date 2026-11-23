/**
 * The dream day section of the doctor (change `dream-session-trigger`,
 * design D7 item 2), read without writing anything:
 *
 *  - `dream-auto-off` (info): automatic dream is off, by the shared
 *    setting `dream.auto` or by this machine's switch, so no session
 *    starts a pass.
 *  - `dream-day-open` (advice, on the owner's device): the day has been
 *    open for more than one day, with the reason and the retry time.
 *  - `dream-worker-lost` (warning, on the owner's device): the last
 *    worker the trigger started ended without recording an outcome.
 *  - `dream-work-unanswerable` (advice, on the owner's device): the last
 *    pass closed the day with ready work nothing on this machine
 *    answers, and what would answer it.
 *
 * Silent where there is no dream owner, and on a machine that is not the
 * owner (its sessions start nothing). Below local reach the reason and
 * the note, which count private work too, are not shown.
 */

import { DREAM_AUTO_ENV } from "../dream-trigger/constants.ts";
import { dreamDayStatus } from "../dream-trigger/status.ts";
import type { DoctorFindings, StoreSideCheckContext, StoreSideDoctorCheck } from "./check.ts";

export const DREAM_AUTO_OFF_CODE = "dream-auto-off";
export const DREAM_DAY_OPEN_CODE = "dream-day-open";
export const DREAM_WORKER_LOST_CODE = "dream-worker-lost";
export const DREAM_WORK_UNANSWERABLE_CODE = "dream-work-unanswerable";

const DAY_MS = 86_400_000;

export const dreamTriggerCheck: StoreSideDoctorCheck = {
  failSoft: true,
  run(ctx: StoreSideCheckContext, out: DoctorFindings): void {
    const status = dreamDayStatus(ctx.vault, {
      ...(ctx.configPath !== undefined ? { configPath: ctx.configPath } : {}),
      now: ctx.now.getTime(),
    });
    if (status.owner === null) return;
    if (!status.auto.on) {
      out.uncertain.push({
        code: DREAM_AUTO_OFF_CODE,
        message: status.auto.machineOff
          ? `automatic dream is off on this machine (${DREAM_AUTO_ENV}); no session here starts a dream pass`
          : "automatic dream is off (the shared setting dream.auto is false); no session starts a dream pass, so run one with `o2b dream run` or turn it on",
      });
    }
    if (!status.isOwner) return;
    const r = status.record;
    if (r === null) return;
    if (r.last_run?.outcome === "lost") {
      out.issues.push({
        severity: "warning",
        code: DREAM_WORKER_LOST_CODE,
        message:
          `the dream worker started ${r.last_run.started_at ?? "at an unknown time"} ended ` +
          `without recording an outcome (found ${r.lost_worker_at ?? "lost"}); its log is the ` +
          "dream worker log in the store's device-local state, and the next attempt starts after " +
          `${r.retry_at ?? "its retry time"}`,
      });
    }
    // The reason and the note count work of every partition this device
    // holds, private included: below local reach only that they exist is said.
    const withheld = ctx.withholdsPrivate === true;
    if (!r.closed && r.open_since !== null) {
      const since = Date.parse(r.open_since);
      if (!Number.isNaN(since) && ctx.now.getTime() - since > DAY_MS) {
        out.uncertain.push({
          code: DREAM_DAY_OPEN_CODE,
          message:
            `the dream day has been open since ${r.open_since}` +
            (withheld ? "; " : `: ${r.reason ?? "the last pass did not complete"}; `) +
            `${r.failures} failed or incomplete pass(es) in a row, the next attempt after ` +
            `${r.retry_at ?? "the next session"}`,
        });
      }
    }
    if (r.closed && r.note !== null) {
      out.uncertain.push({
        code: DREAM_WORK_UNANSWERABLE_CODE,
        message: withheld
          ? "dream closed the day with work nothing on this machine answers; `o2b dream status` on this machine names it"
          : r.note,
      });
    }
  },
};
