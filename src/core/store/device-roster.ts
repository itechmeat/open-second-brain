/**
 * The devices a store knows, and retiring one (design D6, D11a; FORMAT.md
 * "State digests" and "Record kinds"): what `o2b store device list` and
 * `o2b store device retire` call.
 *
 *  - {@link listDevices}: every device with a record in a partition this
 *    machine holds, every device of the migration cohort and every device
 *    a retirement names, with its last record, its state (`switched`: it
 *    recorded its switch to the store; `legacy`: it did not; `retired`: a
 *    human retired it and it has written nothing since) and whether it is
 *    on the digest roster (a record in the last 30 days, not retired).
 *  - {@link retireDevice}: appends one `device-retire` record with
 *    `authority` `human` to the `settings` stream of `shared`, where the
 *    digest roster (`state-digest-compare.ts`) and the removal gate
 *    (`legacyDevices` in `store-migration/migration-records.ts`) read it.
 *    This machine's own id is refused, and so is a reason that would
 *    route the record to `private` (every machine must read it).
 *  - {@link returnedRetiredDevices}: retired devices that wrote a record
 *    after their retirement (a machine brought back, a reused id). They
 *    are on the roster again; doctor names them.
 */

import { isValidDeviceId } from "../config.ts";
import { legacyDevices, switchedDevices } from "../store-migration/migration-records.ts";
import { observeClock, type WallClock } from "./clock-store.ts";
import {
  AUTHORITY_FIELD,
  DAY_MS,
  DEVICE_RETIRE_KIND,
  DIGEST_ROSTER_WINDOW_DAYS,
  STORE_PARTITIONS,
} from "./constants.ts";
import { appendRecord } from "./appender.ts";
import { latestRetirements, returnedAfterRetirement, wroteAfter } from "./device-retirement.ts";
import { compareRecords, type StoreRecord } from "./envelope.ts";
import { parseHlc } from "./hlc.ts";
import { callerInput, opaqueFields, operationPrivacy } from "./operation-privacy.ts";
import { forEachPartitionRecord } from "./state-digest.ts";
import type { StoreHandle } from "./store-open.ts";
import { partitionDir } from "./store-paths.ts";

/** The stream retirements are written to, in `shared`. */
const RETIRE_STREAM = "settings";

export type DeviceState = "switched" | "legacy" | "retired";

export interface DeviceEntry {
  readonly device: string;
  /** Physical time of its last record in a held partition, `null` when it has none. */
  readonly lastSeenMs: number | null;
  readonly state: DeviceState;
  /** On the digest roster: a record in the roster window and not retired. */
  readonly onRoster: boolean;
  readonly thisMachine: boolean;
  /** A human retired it and it wrote a record after that. */
  readonly returnedAfterRetire: boolean;
}

export type DeviceRetireRefusalReason =
  | "own-device"
  | "invalid-device"
  | "private-reason"
  | "no-shared";

/** A retirement that was refused before anything was written. */
export class DeviceRetireRefusal extends Error {
  readonly reason: DeviceRetireRefusalReason;
  constructor(reason: DeviceRetireRefusalReason, message: string) {
    super(message);
    this.name = "DeviceRetireRefusal";
    this.reason = reason;
  }
}

const physical = (record: StoreRecord): number => parseHlc(record.hlc)!.physical;

/** What the roster needs of the partitions this machine holds. */
interface HeldFacts {
  /** The last record of each device, in fold order (`lastRecords`). */
  readonly last: Map<string, StoreRecord>;
  /** Every `device-retire` record, wherever it was written. */
  readonly retirements: StoreRecord[];
  /** The records of the `settings` stream of `shared` whose body is known. */
  readonly sharedSettings: StoreRecord[];
}

/**
 * Read the partitions this machine holds record by record and keep only
 * what the roster needs: a device's newest record, the retirements and
 * the shared settings. A store's busiest shard can hold every record a
 * migration imported; the read holds none of them past its visit. A
 * shard that cannot be read is skipped, as before; one that fails part
 * way counts the records read before the failure.
 */
function heldFacts(store: Pick<StoreHandle, "root" | "partitions">): HeldFacts {
  const last = new Map<string, StoreRecord>();
  const retirements: StoreRecord[] = [];
  const sharedSettings: StoreRecord[] = [];
  for (const partition of STORE_PARTITIONS) {
    if (!store.partitions.has(partition)) continue;
    forEachPartitionRecord(
      partitionDir(store.root, partition),
      { onUnreadable: () => {} },
      {
        record: (shard, record, pending) => {
          const prior = last.get(record.device);
          if (prior === undefined || compareRecords(record, prior) >= 0) {
            last.set(record.device, record);
          }
          if (record.kind === DEVICE_RETIRE_KIND) retirements.push(record);
          if (partition === "shared" && shard.stream === "settings" && !pending) {
            sharedSettings.push(record);
          }
        },
      },
    );
  }
  return { last, retirements, sharedSettings };
}

/**
 * Retired devices that wrote a record after their latest retirement, with
 * that retirement and the time of their last record. Pure: `records` are
 * the records of the partitions to look at, retirements included.
 */
export function returnedRetiredDevices(
  records: Iterable<StoreRecord>,
): Array<{ device: string; retire: StoreRecord; lastRecordMs: number }> {
  return returnedAfterRetirement(records).map(({ device, retire, last }) => ({
    device,
    retire,
    lastRecordMs: physical(last),
  }));
}

/** Every device this store knows, sorted by id; see the module docblock. */
export function listDevices(
  store: StoreHandle,
  options: { readonly nowMs?: number } = {},
): DeviceEntry[] {
  const nowMs = options.nowMs ?? Date.now();
  const facts = heldFacts(store);
  const last = facts.last;
  const retirements = latestRetirements(facts.retirements);
  const devices = new Set<string>([...last.keys(), ...retirements.keys()]);
  // The cohort devices still on the legacy layout, store records or not.
  for (const device of legacyDevices(store, [])) devices.add(device);
  // One pass over the shards already read, not a re-read per device, and
  // over the shared settings stream alone, the source the store-only write
  // path and the removal gate read (`isDeviceSwitched`), so a switch record
  // that landed anywhere else counts in neither.
  const switched = switchedDevices(facts.sharedSettings);
  const since = nowMs - DIGEST_ROSTER_WINDOW_DAYS * DAY_MS;
  return [...devices].toSorted().map((device): DeviceEntry => {
    const own = last.get(device);
    const retire = retirements.get(device);
    const returned = retire !== undefined && wroteAfter(own, retire);
    const retired = retire !== undefined && !returned;
    const lastSeenMs = own !== undefined ? physical(own) : null;
    let state: DeviceState = "legacy";
    if (retired) state = "retired";
    else if (switched.has(device)) state = "switched";
    return {
      device,
      lastSeenMs,
      state,
      onRoster: !retired && lastSeenMs !== null && lastSeenMs >= since,
      thisMachine: device === store.device,
      returnedAfterRetire: returned,
    };
  });
}

export interface RetireDeviceInput {
  readonly device: string;
  readonly reason?: string;
  /** The writing agent's name, stamped on the record. */
  readonly agent: string;
  /** The vault private pages are judged against; `null` for none. */
  readonly vault: string | null;
  readonly now?: WallClock;
}

export type RetireDeviceResult =
  | { readonly status: "retired"; readonly record: StoreRecord }
  | { readonly status: "already-retired"; readonly record: StoreRecord };

/** Retire `input.device`; see the module docblock. Throws {@link DeviceRetireRefusal}. */
export function retireDevice(store: StoreHandle, input: RetireDeviceInput): RetireDeviceResult {
  const { device } = input;
  if (!isValidDeviceId(device)) {
    throw new DeviceRetireRefusal(
      "invalid-device",
      `"${device}" is not a device id: lowercase letters, digits and hyphens`,
    );
  }
  if (device === store.device) {
    throw new DeviceRetireRefusal(
      "own-device",
      `${device} is this machine; retire a device from another machine that shares the store`,
    );
  }
  if (!store.partitions.has("shared")) {
    throw new DeviceRetireRefusal(
      "no-shared",
      "this machine does not hold the shared partition, where retirements are recorded; " +
        "run the command on a machine that does",
    );
  }
  const reason = input.reason?.trim();
  const body: Record<string, unknown> = {
    [AUTHORITY_FIELD]: "human",
    device,
    ...(reason ? { reason } : {}),
  };
  // Every machine reads retirements from `shared`, so a reason that would
  // route the record to `private` is refused rather than written where the
  // roster never looks (one verdict over the caller input, fail closed).
  const verdict = operationPrivacy(input.vault, {
    content: [callerInput({ reason: reason ?? "" }, opaqueFields())],
  });
  if (verdict()) {
    throw new DeviceRetireRefusal(
      "private-reason",
      "the reason names a private page or carries a <private> region; a retirement is read " +
        "by every machine, so give a reason without them",
    );
  }
  const facts = heldFacts(store);
  const own = facts.last.get(device);
  const retire = latestRetirements(facts.retirements).get(device);
  if (retire !== undefined && !wroteAfter(own, retire)) {
    return { status: "already-retired", record: retire };
  }
  // The retirement must sort after every record of the device this machine
  // has seen, or a record in the same millisecond from a device id that
  // sorts later would read as written after it: raise the clock past it.
  if (own !== undefined) {
    observeClock(store.deviceStateDir, store.device, parseHlc(own.hlc)!, input.now);
  }
  const { record } = appendRecord(
    store,
    {
      partition: "shared",
      stream: RETIRE_STREAM,
      kind: DEVICE_RETIRE_KIND,
      agent: input.agent,
      body,
    },
    input.now !== undefined ? { now: input.now } : {},
  );
  return { status: "retired", record };
}
