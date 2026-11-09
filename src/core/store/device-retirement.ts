/**
 * The one "retired, then wrote again" rule (design D11a): a device a human
 * retired with a `device-retire` record is back on the roster, and back in
 * the migration cohort, once it writes any record after its latest
 * retirement (a machine brought back, a reused id).
 *
 * A pure leaf over records already read, so `device-roster.ts` (device
 * list, doctor), `store-migration/migration-records.ts` (the removal
 * gate) and the digest roster (`state-digest-compare.ts`) share it
 * without importing each other.
 */

import { isValidDeviceId } from "../config.ts";
import { compareCodeUnits } from "./compare.ts";
import { AUTHORITY_FIELD, DEVICE_RETIRE_KIND } from "./constants.ts";
import { compareRecords, type StoreRecord } from "./envelope.ts";

function isRetire(record: StoreRecord): boolean {
  const device = record.body["device"];
  return (
    record.kind === DEVICE_RETIRE_KIND &&
    record.body[AUTHORITY_FIELD] === "human" &&
    typeof device === "string" &&
    isValidDeviceId(device)
  );
}

/** The latest human retirement of each device, in fold order. */
export function latestRetirements(records: ReadonlyArray<StoreRecord>): Map<string, StoreRecord> {
  const out = new Map<string, StoreRecord>();
  for (const record of records.filter(isRetire).toSorted(compareRecords)) {
    out.set(record.body["device"] as string, record);
  }
  return out;
}

/** The last record each device wrote, in fold order. */
export function lastRecords(records: ReadonlyArray<StoreRecord>): Map<string, StoreRecord> {
  const out = new Map<string, StoreRecord>();
  for (const record of [...records].toSorted(compareRecords)) out.set(record.device, record);
  return out;
}

/** Whether `last` (the device's last record) came after its retirement. */
export function wroteAfter(last: StoreRecord | undefined, retire: StoreRecord): boolean {
  return last !== undefined && compareRecords(last, retire) > 0;
}

/**
 * Retired devices that wrote a record after their latest retirement, with
 * that retirement and their last record, sorted by device id. `records`
 * are the records of the partitions to look at, retirements included.
 */
export function returnedAfterRetirement(
  records: Iterable<StoreRecord>,
): Array<{ device: string; retire: StoreRecord; last: StoreRecord }> {
  const all = [...records];
  const last = lastRecords(all);
  const out: Array<{ device: string; retire: StoreRecord; last: StoreRecord }> = [];
  for (const [device, retire] of [...latestRetirements(all)].toSorted(([a], [b]) =>
    compareCodeUnits(a, b),
  )) {
    const own = last.get(device);
    if (own !== undefined && wroteAfter(own, retire)) out.push({ device, retire, last: own });
  }
  return out;
}
