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
import {
  lastRecords,
  latestRetirements,
  returnedAfterRetirement,
  wroteAfter,
} from "./device-retirement.ts";
import type { StoreRecord } from "./envelope.ts";
import { parseHlc } from "./hlc.ts";
import { callerInput, opaqueFields, operationPrivacy } from "./operation-privacy.ts";
import { readPartition } from "./state-digest.ts";
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

/** Every shard of every partition this machine holds; an unreadable shard is skipped. */
function heldShards(store: Pick<StoreHandle, "root" | "partitions">) {
  return STORE_PARTITIONS.filter((p) => store.partitions.has(p)).flatMap((partition) =>
    readPartition(partitionDir(store.root, partition), { onUnreadable: () => {} }).map((shard) => ({
      partition,
      shard,
    })),
  );
}

/** Every record of every partition this machine holds; an unreadable shard is skipped. */
function heldRecords(store: Pick<StoreHandle, "root" | "partitions">): StoreRecord[] {
  return heldShards(store).flatMap(({ shard }) => shard.all);
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
  const shards = heldShards(store);
  const records = shards.flatMap(({ shard }) => shard.all);
  const last = lastRecords(records);
  const retirements = latestRetirements(records);
  const devices = new Set<string>([...last.keys(), ...retirements.keys()]);
  // The cohort devices still on the legacy layout, store records or not.
  for (const device of legacyDevices(store, [])) devices.add(device);
  // One pass over the shards already read, not a re-read per device, and
  // over the shared settings stream alone, the source the store-only write
  // path and the removal gate read (`isDeviceSwitched`), so a switch record
  // that landed anywhere else counts in neither.
  const switched = switchedDevices(
    shards
      .filter(({ partition, shard }) => partition === "shared" && shard.stream === "settings")
      .flatMap(({ shard }) => shard.records),
  );
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
  const records = heldRecords(store);
  const own = lastRecords(records).get(device);
  const retire = latestRetirements(records).get(device);
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
