/**
 * The removal of the legacy tree with devices retired by silence (change
 * stale-device-retirement, design D6): a silent device is not pending, the
 * result and the `legacy-tree-removed` record name it with its last
 * evidence apart from the devices that switched, a pending device still
 * refuses the removal, and `--force` names only the pending ones.
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
import { existsSync } from "node:fs";
import { join } from "node:path";

import { removeLegacy } from "../../../src/core/store-migration/outcome.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { readRemovalMarker } from "../../../src/core/store-migration/removal-marker.ts";
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
const DEV_B_LAST = "2026-11-02T00:00:00.000Z";
const DEV_C_LAST = "2026-09-01T00:00:00.000Z";

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

describe("removal with devices retired by silence", () => {
  test("a pending device still refuses; the refusal names the silent one apart", () => {
    const a = migrated();
    const kept = removeLegacy(a.vault, { now: NOW });
    expect(kept).toEqual({
      removed: false,
      reason: "cohort-pending",
      pending: ["dev-b"],
      pending_evidence: [{ device: "dev-b", last_evidence: DEV_B_LAST }],
      switched: ["dev-a"],
      retired_by_silence: [{ device: "dev-c", last_evidence: DEV_C_LAST }],
      silence_threshold_days: 30,
      as_of: NOW.toISOString(),
    });
    expect(existsSync(join(a.vault, "Brain"))).toBe(true);
  });

  test("once only silent devices are left the tree leaves, and the record says why", () => {
    const a = migrated();
    setSilenceDays(a, 10);
    const removed = removeLegacy(a.vault, { now: NOW });
    if (!removed.removed) throw new Error(`not removed: ${removed.reason}`);
    expect(removed.forced).toBe(false);
    expect(removed.stopped).toEqual([]);
    expect(removed.switched).toEqual(["dev-a"]);
    expect(removed.retired_by_silence).toEqual([
      { device: "dev-b", last_evidence: DEV_B_LAST },
      { device: "dev-c", last_evidence: DEV_C_LAST },
    ]);
    expect(removed.silence_threshold_days).toBe(10);
    expect(removed.as_of).toBe(NOW.toISOString());
    expect(existsSync(join(a.vault, "Brain"))).toBe(false);

    const record = a.records().find((r) => r.kind === "legacy-tree-removed");
    expect(record?.body).toMatchObject({
      forced: false,
      stopped: [],
      retired_by_silence: [
        { device: "dev-b", last_evidence: DEV_B_LAST },
        { device: "dev-c", last_evidence: DEV_C_LAST },
      ],
      silence_threshold_days: 10,
      as_of: NOW.toISOString(),
    });
    expect(readRemovalMarker(a.store(), a.vault)?.retired_by_silence).toEqual([
      { device: "dev-b", last_evidence: DEV_B_LAST },
      { device: "dev-c", last_evidence: DEV_C_LAST },
    ]);
  });

  test("--force names only the pending devices as stopped", () => {
    const a = migrated();
    const removed = removeLegacy(a.vault, { now: NOW, force: true });
    if (!removed.removed) throw new Error("not removed");
    expect(removed.forced).toBe(true);
    expect(removed.stopped).toEqual(["dev-b"]);
    expect(removed.retired_by_silence.map((d) => d.device)).toEqual(["dev-c"]);
  });

  test("threshold 0: the cohort has no age limit, as before", () => {
    const a = migrated();
    setSilenceDays(a, 0);
    const kept = removeLegacy(a.vault, { now: NOW });
    expect(kept.removed).toBe(false);
    if (kept.removed || kept.reason !== "cohort-pending") throw new Error("expected a refusal");
    expect(kept.pending).toEqual(["dev-b", "dev-c"]);
    expect(kept.retired_by_silence).toEqual([]);
  });

  test("a silent device that writes again blocks the removal at once", () => {
    const a = migrated();
    setSilenceDays(a, 10);
    a.write(
      "Brain/log/2026-11-18.dev-c.jsonl",
      `${JSON.stringify({ ts: "2026-11-18T09:00:00Z", event_type: "note", text: "back" })}\n`,
    );
    const kept = removeLegacy(a.vault, { now: NOW });
    if (kept.removed || kept.reason !== "cohort-pending") throw new Error("expected a refusal");
    expect(kept.pending).toEqual(["dev-c"]);
    expect(kept.retired_by_silence.map((d) => d.device)).toEqual(["dev-b"]);
  });
});
