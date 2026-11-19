/**
 * The doctor and the store status block on the migration cohort (change
 * stale-device-retirement, design D7): every cohort device as switched,
 * pending with its last evidence, or retired by silence with the date and
 * the threshold; once nothing is pending, advice that the legacy tree can
 * leave the vault with the command. Advice, never a warning.
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

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import {
  LEGACY_DEVICES_PENDING_CODE,
  LEGACY_TREE_CAN_LEAVE_CODE,
} from "../../../src/core/brain/doctor/migration-check.ts";
import { buildStoreStatusBlock } from "../../../src/core/store/store-status.ts";
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

describe("doctor on the migration cohort", () => {
  test("lists each device: switched, pending with its date, retired by silence with the threshold", () => {
    const a = migrated();
    const result = runDoctor(a.vault, { now: NOW });
    const pending = (result.uncertain ?? []).find((u) => u.code === LEGACY_DEVICES_PENDING_CODE);
    expect(pending?.message).toContain("dev-b still writes the legacy Brain/ tree");
    expect(pending?.message).toContain("dev-a switched");
    expect(pending?.message).toContain("dev-b pending (last evidence 2026-11-02)");
    expect(pending?.message).toContain(
      "dev-c retired by silence (last evidence 2026-09-01, more than 30 days before 2026-11-19)",
    );
    const codes = result.warnings.map((w) => w.code);
    expect(codes).not.toContain(LEGACY_DEVICES_PENDING_CODE);
    expect((result.uncertain ?? []).map((u) => u.code)).not.toContain(LEGACY_TREE_CAN_LEAVE_CODE);
  });

  test("nothing pending: advice that the tree can leave the vault, with the command", () => {
    const a = migrated();
    setSilenceDays(a, 10);
    const result = runDoctor(a.vault, { now: NOW });
    const uncertain = result.uncertain ?? [];
    expect(uncertain.map((u) => u.code)).not.toContain(LEGACY_DEVICES_PENDING_CODE);
    const leave = uncertain.find((u) => u.code === LEGACY_TREE_CAN_LEAVE_CODE);
    expect(leave?.message).toContain("the legacy Brain/ tree can leave the vault");
    expect(leave?.message).toContain("`o2b brain migrate-store --remove-legacy`");
    expect(leave?.message).toContain(
      "dev-b retired by silence (last evidence 2026-11-02, more than 10 days before 2026-11-19)",
    );
    expect(result.warnings.map((w) => w.code)).not.toContain(LEGACY_TREE_CAN_LEAVE_CODE);
  });

  test("a device retired by silence that writes again shows pending again", () => {
    const a = migrated();
    setSilenceDays(a, 10);
    const before = runDoctor(a.vault, { now: NOW }).uncertain ?? [];
    expect(before.map((u) => u.code)).not.toContain(LEGACY_DEVICES_PENDING_CODE);
    expect(before.find((u) => u.code === LEGACY_TREE_CAN_LEAVE_CODE)?.message).toContain(
      "dev-c retired by silence (last evidence 2026-09-01",
    );
    a.write(
      "Brain/log/2026-11-18.dev-c.jsonl",
      `${JSON.stringify({ ts: "2026-11-18T09:00:00Z", event_type: "note", text: "back" })}\n`,
    );
    const uncertain = runDoctor(a.vault, { now: NOW }).uncertain ?? [];
    const pending = uncertain.find((u) => u.code === LEGACY_DEVICES_PENDING_CODE);
    expect(pending?.message).toContain("dev-c pending (last evidence 2026-11-18)");
    expect(uncertain.map((u) => u.code)).not.toContain(LEGACY_TREE_CAN_LEAVE_CODE);
  });
});

describe("the store status block on the migration cohort", () => {
  test("carries every cohort device with its state and evidence", () => {
    const a = migrated();
    // 10 days: both dated devices are older than that before NOW.
    setSilenceDays(a, 10);
    const block = buildStoreStatusBlock({ vault: a.vault, configPath: null });
    const migration = block["migration"] as Record<string, unknown>;
    expect(migration["cohort"]).toMatchObject({
      threshold_days: 10,
      can_leave: true,
      devices: [
        { device: "dev-a", state: "switched" },
        { device: "dev-b", state: "silent", last_evidence: "2026-11-02T00:00:00.000Z" },
        { device: "dev-c", state: "silent", last_evidence: "2026-09-01T00:00:00.000Z" },
      ],
    });
    expect(typeof (migration["cohort"] as Record<string, unknown>)["as_of"]).toBe("string");
  });

  test("is null on a machine that has not switched", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    const block = buildStoreStatusBlock({ vault: a.vault, configPath: null });
    expect((block["migration"] as Record<string, unknown>)["cohort"]).toBeNull();
  });
});
