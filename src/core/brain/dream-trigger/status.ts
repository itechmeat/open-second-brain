/**
 * The state of the dream day on this machine (change
 * `dream-session-trigger`, design D7, spec "The state of the day is
 * visible"): whether automatic dream is on, whether this device is the
 * owner, today's UTC day, whether it is closed and why not, the last run
 * with its outcome and the retry time. Read-only: it writes nothing,
 * looks at the role without settling a claim, and starts nothing. Shared
 * by `o2b dream status` and doctor.
 */

import { discoverConfig } from "../../config.ts";
import { dreamOwnerStatus } from "../dream-owner/status.ts";
import { openDreamOwnerStore } from "../dream-owner/gate.ts";
import { isoDate } from "../time.ts";
import { DREAM_AUTO_ENV, dreamAutoOffByEnv } from "./constants.ts";
import { readDreamAuto } from "./auto.ts";
import {
  dreamDayClosed,
  dreamTriggerLocation,
  readDreamTriggerRecord,
  type DreamTriggerRecord,
} from "./record.ts";

export interface DreamDayStatus {
  /** Whether a session here may start a pass: the machine switch and the shared setting. */
  readonly auto: {
    readonly on: boolean;
    /** The shared setting `dream.auto`; `null` when it cannot be read here. */
    readonly setting: boolean | null;
    /** The machine switch `OPEN_SECOND_BRAIN_DREAM_AUTO` turns it off here. */
    readonly machineOff: boolean;
  };
  readonly device: string | null;
  readonly owner: { readonly device: string; readonly agent: string } | null;
  readonly isOwner: boolean;
  /** Today's UTC day. */
  readonly today: string;
  /** The day record of this machine, `null` when none was written yet. */
  readonly record: DreamTriggerRecord | null;
  /** Whether today is closed. */
  readonly closedToday: boolean;
}

/** The state of the day for `vault` on this machine. */
export function dreamDayStatus(
  vault: string | null,
  options: {
    readonly configPath?: string;
    readonly now?: number;
    readonly env?: Readonly<Record<string, string | undefined>>;
  } = {},
): DreamDayStatus {
  const env = options.env ?? process.env;
  const today = isoDate(new Date(options.now ?? Date.now()));
  const configOpt = options.configPath !== undefined ? { configPath: options.configPath } : {};
  const owner = dreamOwnerStatus(vault, { ...configOpt, look: false });
  let setting: boolean | null = null;
  const opened = openDreamOwnerStore(vault, options.configPath);
  if (opened.store !== null && opened.store.partitions.has("shared")) {
    setting = readDreamAuto(opened.store.root);
  }
  const machineOff = dreamAutoOffByEnv(env);
  const { storeRoot, recordPath } = dreamTriggerLocation(discoverConfig(options.configPath), env);
  const record = readDreamTriggerRecord(recordPath, storeRoot);
  return {
    auto: { on: !machineOff && setting !== false, setting, machineOff },
    device: owner.device,
    owner: owner.owner === null ? null : { device: owner.owner.device, agent: owner.owner.agent },
    isOwner: owner.isOwner,
    today,
    record,
    // The trigger's own rule: a day closed ahead of the clock counts as closed.
    closedToday: record !== null && dreamDayClosed(record, today),
  };
}

/** The status as JSON. */
export function dreamDayStatusJson(status: DreamDayStatus): Record<string, unknown> {
  const r = status.record;
  return {
    auto: {
      on: status.auto.on,
      setting: status.auto.setting,
      machine_off: status.auto.machineOff,
    },
    device: status.device,
    owner: status.owner,
    is_owner: status.isOwner,
    today: status.today,
    closed_today: status.closedToday,
    day:
      r === null
        ? null
        : {
            day: r.day,
            closed: r.closed,
            reason: r.reason,
            note: r.note,
            failures: r.failures,
            retry_at: r.retry_at,
            last_run: r.last_run,
            lost_worker_at: r.lost_worker_at,
          },
  };
}

/** Lines for a person. */
export function describeDreamDay(status: DreamDayStatus): string[] {
  const lines: string[] = [];
  if (status.auto.machineOff) {
    lines.push(`Automatic dream: off on this machine (${DREAM_AUTO_ENV}).`);
  } else if (status.auto.setting === false) {
    lines.push("Automatic dream: off (the shared setting dream.auto is false).");
  } else if (status.auto.setting === null) {
    lines.push(
      "Automatic dream: on, unless the shared setting says otherwise; it cannot be read here.",
    );
  } else {
    lines.push(
      "Automatic dream: on; the first session of a day on the owner's machine starts the pass.",
    );
  }
  if (status.owner === null) {
    lines.push("Dream owner: none, so no session starts a pass.");
  } else {
    const here = status.device ?? "no device id";
    lines.push(
      status.isOwner
        ? `Dream owner: ${status.owner.device} (${status.owner.agent}); this device is the owner.`
        : `Dream owner: ${status.owner.device} (${status.owner.agent}); this device (${here}) is not, and starts no pass.`,
    );
  }
  const r = status.record;
  lines.push(`Today (UTC): ${status.today}.`);
  if (r === null || r.day === null) {
    lines.push("No dream pass has recorded a day on this machine yet.");
  } else if (r.closed) {
    lines.push(
      status.closedToday
        ? r.day === status.today
          ? `The day is closed${r.reason !== null ? ` (${r.reason})` : ""}.`
          : `The day is closed: the record closed ${r.day}, ahead of this machine's clock.`
        : `The last closed day is ${r.day}; today is open until a pass completes.`,
    );
  } else {
    lines.push(`The day of ${r.day} is open: ${r.reason ?? "the last pass did not complete"}.`);
    if (r.retry_at !== null) {
      lines.push(
        `Next attempt after ${r.retry_at} (${r.failures} failed or incomplete pass(es) in a row).`,
      );
    }
  }
  const run = r?.last_run ?? null;
  if (run !== null && run.started_at !== null) {
    lines.push(
      `Last run: started ${run.started_at}` +
        (run.ended_at !== null ? `, ended ${run.ended_at}` : ", not ended") +
        (run.outcome !== null ? `, ${run.outcome}` : "") +
        (run.by !== null ? `, by ${run.by}` : "") +
        ".",
    );
  }
  if (r?.note) lines.push(r.note);
  return lines;
}
