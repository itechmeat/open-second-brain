/**
 * The state of each migration cohort device (change
 * stale-device-retirement, design D5, D7): switched, retired by a human,
 * pending with its last evidence, or retired by silence; derived from the
 * evidence on every read, never recorded.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  setDefaultTimeout,
  setSystemTime,
  test,
} from "bun:test";

import { appendRecord } from "../../../src/core/store/appender.ts";
import { readCohortStatus } from "../../../src/core/store-migration/cohort-status.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { makeFleet, type Fleet, type Machine } from "./fixtures/fleet.ts";
import { setSilenceDays } from "./fixtures/silence.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";

// Tests here run full migrations and the doctor, seconds each on a loaded
// machine; see tests/helpers/cli-timeout.ts.
setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const FAST = { settleMs: 0 } as const;
// This machine's clock, frozen while each test runs: every store record the
// test writes carries it, so it is the newest evidence and the reference.
const NOW = new Date("2026-11-19T00:00:00Z");
beforeEach(() => {
  setSystemTime(NOW);
});

let fleet: Fleet | null = null;
afterEach(() => {
  setSystemTime();
  fleet?.cleanup();
  fleet = null;
});

function migrated(): Machine {
  fleet = makeFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  expect(runMigration(a.vault, FAST).ok).toBe(true);
  return a;
}

describe("cohort status", () => {
  test("switched, pending with its evidence, and retired by silence", () => {
    const a = migrated();
    const status = readCohortStatus(a.store(), a.vault, NOW);
    expect(status.threshold_days).toBe(30);
    expect(status.as_of).toBe(NOW.toISOString());
    expect(status.devices).toEqual([
      { device: "dev-a", state: "switched", last_evidence: expect.any(String) },
      { device: "dev-b", state: "pending", last_evidence: "2026-11-02T00:00:00.000Z" },
      { device: "dev-c", state: "silent", last_evidence: "2026-09-01T00:00:00.000Z" },
    ]);
    expect(status.switched).toEqual(["dev-a"]);
    expect(status.pending).toEqual([
      { device: "dev-b", last_evidence: "2026-11-02T00:00:00.000Z" },
    ]);
    expect(status.retired_by_silence).toEqual([
      { device: "dev-c", last_evidence: "2026-09-01T00:00:00.000Z" },
    ]);
    expect(status.can_leave).toBe(false);
  });

  test("a human retirement is its own state, and nothing pending means the tree can leave", () => {
    const a = migrated();
    appendRecord(a.store(), {
      partition: "shared",
      stream: "settings",
      kind: "device-retire",
      agent: "t",
      body: { authority: "human", device: "dev-b" },
    });
    const status = readCohortStatus(a.store(), a.vault, NOW);
    expect(status.devices.map((d) => [d.device, d.state])).toEqual([
      ["dev-a", "switched"],
      ["dev-b", "retired"],
      ["dev-c", "silent"],
    ]);
    expect(status.can_leave).toBe(true);
  });

  test("threshold 0: no device is retired by silence", () => {
    const a = migrated();
    setSilenceDays(a, 0);
    const status = readCohortStatus(a.store(), a.vault, NOW);
    expect(status.threshold_days).toBe(0);
    expect(status.retired_by_silence).toEqual([]);
    expect(status.pending.map((p) => p.device)).toEqual(["dev-b", "dev-c"]);
  });

  test("a device retired by silence that writes again is pending again at once", () => {
    const a = migrated();
    expect(
      readCohortStatus(a.store(), a.vault, NOW).retired_by_silence.map((d) => d.device),
    ).toEqual(["dev-c"]);
    // dev-c, still on an old release, syncs a log shard of the day before.
    a.write(
      "Brain/log/2026-11-18.dev-c.jsonl",
      `${JSON.stringify({ ts: "2026-11-18T09:00:00Z", event_type: "note", text: "back" })}\n`,
    );
    const status = readCohortStatus(a.store(), a.vault, NOW);
    expect(status.retired_by_silence).toEqual([]);
    expect(status.pending).toContainEqual({
      device: "dev-c",
      last_evidence: "2026-11-18T09:00:00.000Z",
    });
  });

  test("a store record the device writes is evidence too", () => {
    const a = migrated();
    // dev-c writes into the store (a release that dual-writes), an hour before NOW.
    appendRecord(
      { ...a.store(), device: "dev-c" },
      { partition: "shared", stream: "events", kind: "note", agent: "t", body: { text: "x" } },
      { now: () => NOW.getTime() - 3_600_000 },
    );
    const status = readCohortStatus(a.store(), a.vault, NOW);
    expect(status.devices.find((d) => d.device === "dev-c")?.state).toBe("pending");
  });
});
