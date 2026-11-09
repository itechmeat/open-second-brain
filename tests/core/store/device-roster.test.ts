/**
 * The device roster and `device-retire` (design D6, D11a; FORMAT.md
 * "State digests"): `o2b store device list` shows every device the store
 * knows with its last record and whether it switched, is still on the
 * legacy layout or was retired; `o2b store device retire` writes the human
 * `device-retire` record the digest roster and the removal gate read. A
 * retired device that writes again is back, and doctor names it.
 */
import { afterEach, describe, expect, test } from "bun:test";

import { legacyDevices } from "../../../src/core/store-migration/migration-records.ts";
import {
  DEVICE_RETIRE_KIND,
  DIGEST_ROSTER_WINDOW_DAYS,
  DAY_MS,
} from "../../../src/core/store/constants.ts";
import {
  DeviceRetireRefusal,
  listDevices,
  retireDevice,
  returnedRetiredDevices,
} from "../../../src/core/store/device-roster.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { computeRoster } from "../../../src/core/store/state-digest-compare.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { partitionDir } from "../../../src/core/store/store-paths.ts";
import { makeTempStore, type TempStore } from "./fixtures/temp-store.ts";

let temp: TempStore | null = null;
afterEach(() => {
  temp?.cleanup();
  temp = null;
});

const NOW = Date.UTC(2026, 10, 7, 12);
const clock = (ms: number) => () => ms;

function note(t: TempStore, device: string, ms: number, kind = "log-event"): void {
  appendRecord(
    t.open(device),
    { partition: "shared", stream: "log", kind, agent: "t", body: { text: "x" } },
    { now: clock(ms) },
  );
}

function switched(t: TempStore, device: string, ms: number): void {
  appendRecord(
    t.open(device),
    {
      partition: "shared",
      stream: "settings",
      kind: "device-switched",
      agent: "t",
      body: { authority: "human", vault_id: null, device },
    },
    { now: clock(ms) },
  );
}

function cohort(t: TempStore, devices: string[], ms: number): void {
  appendRecord(
    t.open("dev-a"),
    {
      partition: "shared",
      stream: "settings",
      kind: "migration-cohort",
      agent: "t",
      body: { authority: "human", vault_id: null, devices },
    },
    { now: clock(ms) },
  );
}

function sharedRecords(t: TempStore) {
  return readPartition(partitionDir(t.root, "shared")).flatMap((s) => s.records);
}

function refusal(fn: () => unknown): DeviceRetireRefusal {
  try {
    fn();
  } catch (err) {
    if (err instanceof DeviceRetireRefusal) return err;
    throw err;
  }
  throw new Error("expected a DeviceRetireRefusal");
}

describe("listDevices", () => {
  test("names each device with its last record, its state and whether it is this machine", () => {
    temp = makeTempStore("osb-roster-list-");
    switched(temp, "dev-a", NOW - 2 * DAY_MS);
    note(temp, "dev-b", NOW - DAY_MS);
    cohort(temp, ["dev-a", "dev-b", "dev-c"], NOW - 2 * DAY_MS);
    const devices = listDevices(temp.open("dev-a"), { nowMs: NOW });
    expect(devices.map((d) => [d.device, d.state, d.thisMachine])).toEqual([
      ["dev-a", "switched", true],
      ["dev-b", "legacy", false],
      // In the migration cohort, with no store record of its own.
      ["dev-c", "legacy", false],
    ]);
    expect(devices[1]!.lastSeenMs).toBe(NOW - DAY_MS);
    expect(devices[2]!.lastSeenMs).toBeNull();
    expect(devices[1]!.onRoster).toBe(true);
    expect(devices[2]!.onRoster).toBe(false);
  });

  test("a device silent for longer than the roster window is listed but off the roster", () => {
    temp = makeTempStore("osb-roster-window-");
    note(temp, "dev-old", NOW - (DIGEST_ROSTER_WINDOW_DAYS + 1) * DAY_MS);
    const old = listDevices(temp.open("dev-a"), { nowMs: NOW }).find((d) => d.device === "dev-old");
    expect(old).toMatchObject({ state: "legacy", onRoster: false });
  });

  test("a switch record outside the shared settings stream switches nothing, as for store-only mode", () => {
    temp = makeTempStore("osb-roster-stray-switch-");
    appendRecord(
      temp.open("dev-b"),
      {
        partition: "private",
        stream: "settings",
        kind: "device-switched",
        agent: "t",
        body: { authority: "human", vault_id: null, device: "dev-b" },
      },
      { now: clock(NOW - DAY_MS) },
    );
    const b = listDevices(temp.open("dev-a"), { nowMs: NOW }).find((d) => d.device === "dev-b");
    expect(b?.state).toBe("legacy");
  });
});

describe("retireDevice", () => {
  test("writes one human device-retire record in shared settings, with the reason", () => {
    temp = makeTempStore("osb-roster-retire-");
    note(temp, "dev-b", NOW - DAY_MS);
    const store = temp.open("dev-a");
    const result = retireDevice(store, {
      device: "dev-b",
      reason: "laptop sold",
      agent: "o2b",
      vault: null,
      now: clock(NOW),
    });
    expect(result.status).toBe("retired");
    const records = sharedRecords(temp).filter((r) => r.kind === DEVICE_RETIRE_KIND);
    expect(records).toHaveLength(1);
    expect(records[0]!.body).toEqual({
      authority: "human",
      device: "dev-b",
      reason: "laptop sold",
    });
    expect(records[0]!.device).toBe("dev-a");
    const listed = listDevices(store, { nowMs: NOW }).find((d) => d.device === "dev-b");
    expect(listed).toMatchObject({ state: "retired", onRoster: false, returnedAfterRetire: false });
  });

  test("a retirement in the same millisecond as the device's last record still sorts after it", () => {
    temp = makeTempStore("osb-roster-tie-");
    // dev-z sorts after dev-a, so an equal clock would put its record last.
    note(temp, "dev-z", NOW);
    const store = temp.open("dev-a");
    retireDevice(store, { device: "dev-z", agent: "o2b", vault: null, now: clock(NOW) });
    expect(listDevices(store, { nowMs: NOW }).find((d) => d.device === "dev-z")).toMatchObject({
      state: "retired",
      returnedAfterRetire: false,
    });
    expect(returnedRetiredDevices(sharedRecords(temp))).toEqual([]);
  });

  test("the digest roster and the removal gate both drop the retired device", () => {
    temp = makeTempStore("osb-roster-gate-");
    switched(temp, "dev-a", NOW - DAY_MS);
    note(temp, "dev-c", NOW - DAY_MS);
    cohort(temp, ["dev-a", "dev-c"], NOW - DAY_MS);
    const store = temp.open("dev-a");
    expect(legacyDevices(store, [])).toEqual(["dev-c"]);
    retireDevice(store, { device: "dev-c", agent: "o2b", vault: null, now: clock(NOW) });
    expect(legacyDevices(store, [])).toEqual([]);
    const all = sharedRecords(temp);
    const roster = computeRoster(all, all, NOW + 1000);
    expect(roster.devices.map((d) => d.device)).toEqual(["dev-a"]);
    expect(roster.retired).toEqual(["dev-c"]);
  });

  test("retiring this machine's own id is refused and writes nothing", () => {
    temp = makeTempStore("osb-roster-own-");
    const store = temp.open("dev-a");
    const before = sharedRecords(temp).length;
    const err = refusal(() => retireDevice(store, { device: "dev-a", agent: "o2b", vault: null }));
    expect(err.reason).toBe("own-device");
    expect(err.message).toContain("dev-a");
    expect(sharedRecords(temp)).toHaveLength(before);
  });

  test("an invalid device id is refused", () => {
    temp = makeTempStore("osb-roster-invalid-");
    const err = refusal(() =>
      retireDevice(temp!.open("dev-a"), { device: "Not An Id", agent: "o2b", vault: null }),
    );
    expect(err.reason).toBe("invalid-device");
  });

  test("a reason with a <private> region is refused: the record is read by every machine", () => {
    temp = makeTempStore("osb-roster-private-");
    const err = refusal(() =>
      retireDevice(temp!.open("dev-a"), {
        device: "dev-b",
        reason: "<private>home address</private>",
        agent: "o2b",
        vault: null,
      }),
    );
    expect(err.reason).toBe("private-reason");
    expect(sharedRecords(temp).filter((r) => r.kind === DEVICE_RETIRE_KIND)).toHaveLength(0);
  });

  test("a device already retired is not retired twice", () => {
    temp = makeTempStore("osb-roster-twice-");
    const store = temp.open("dev-a");
    retireDevice(store, { device: "dev-b", agent: "o2b", vault: null, now: clock(NOW) });
    const again = retireDevice(store, {
      device: "dev-b",
      agent: "o2b",
      vault: null,
      now: clock(NOW + 1000),
    });
    expect(again.status).toBe("already-retired");
    expect(sharedRecords(temp).filter((r) => r.kind === DEVICE_RETIRE_KIND)).toHaveLength(1);
  });
});

describe("a retired device that writes again", () => {
  test("is back on the list with its real state, and is named for doctor", () => {
    temp = makeTempStore("osb-roster-back-");
    note(temp, "dev-b", NOW - DAY_MS);
    const store = temp.open("dev-a");
    retireDevice(store, { device: "dev-b", agent: "o2b", vault: null, now: clock(NOW) });
    note(temp, "dev-b", NOW + 60_000);
    const listed = listDevices(store, { nowMs: NOW + 120_000 }).find((d) => d.device === "dev-b");
    expect(listed).toMatchObject({ state: "legacy", onRoster: true, returnedAfterRetire: true });
    const returned = returnedRetiredDevices(sharedRecords(temp));
    expect(returned.map((r) => r.device)).toEqual(["dev-b"]);
    expect(returned[0]!.lastRecordMs).toBe(NOW + 60_000);
  });

  test("a device that stayed quiet after its retirement is not named", () => {
    temp = makeTempStore("osb-roster-quiet-");
    note(temp, "dev-b", NOW - DAY_MS);
    retireDevice(temp.open("dev-a"), {
      device: "dev-b",
      agent: "o2b",
      vault: null,
      now: clock(NOW),
    });
    expect(returnedRetiredDevices(sharedRecords(temp))).toEqual([]);
  });
});
