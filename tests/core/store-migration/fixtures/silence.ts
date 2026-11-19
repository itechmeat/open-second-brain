/**
 * Set the shared silence threshold (`migration.silent_device_days`, change
 * stale-device-retirement) on one fleet machine, as the operator would.
 */
import { appendRecord } from "../../../../src/core/store/appender.ts";
import { SETTING_SILENT_DEVICE_DAYS } from "../../../../src/core/store/constants.ts";
import type { Machine } from "./fleet.ts";

export function setSilenceDays(machine: Machine, days: number): void {
  appendRecord(machine.store(), {
    partition: "shared",
    stream: "settings",
    kind: "setting-set",
    agent: "t",
    body: { authority: "human", key: SETTING_SILENT_DEVICE_DAYS, value: days },
  });
}
