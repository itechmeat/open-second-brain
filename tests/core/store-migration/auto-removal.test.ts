/**
 * The automatic removal of the legacy tree (release 2.0.1,
 * `src/core/store-migration/auto-removal.ts`): the setting beside
 * `auto_store_migration`, the cadence a start asks at, the one line a day
 * while a device of the cohort is still on the legacy layout, and the tree
 * leaving by itself once that device switched. The removal itself, its
 * archive and every refusal are `removal.ts`'s and tested there.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AUTO_LEGACY_REMOVAL_ENV,
  AUTO_STORE_MIGRATION_ENV,
  autoLegacyRemovalSetting,
} from "../../../src/core/config.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { migrateStore } from "../../../src/core/store-migration/outcome.ts";
import {
  AUTO_REMOVAL_REFUSED_RETRY_MS,
  AUTO_REMOVAL_RETRY_MS,
  autoRemovalNoticeFor,
  runAutoLegacyRemoval,
  shouldStartAutoLegacyRemoval,
  takeAutoRemovalNotice,
  type AutoRemovalState,
} from "../../../src/core/store-migration/auto-removal.ts";
import { autoMigrationStateDir } from "../../../src/core/store-migration/auto-state.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeFleet, type Fleet, type Machine } from "./fixtures/fleet.ts";
import { setSilenceDays } from "./fixtures/silence.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const FAST = { settleMs: 0 } as const;
const HOUR = 60 * 60 * 1000;
const T0 = new Date("2026-11-24T09:00:00Z");
const at = (ms: number): Date => new Date(T0.getTime() + ms);

let fleet: Fleet | null = null;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {
    [AUTO_STORE_MIGRATION_ENV]: process.env[AUTO_STORE_MIGRATION_ENV],
    [AUTO_LEGACY_REMOVAL_ENV]: process.env[AUTO_LEGACY_REMOVAL_ENV],
  };
  // The test preload turns the automatic migration off; these tests are
  // about what follows it, at its default.
  delete process.env[AUTO_STORE_MIGRATION_ENV];
  delete process.env[AUTO_LEGACY_REMOVAL_ENV];
});

afterEach(() => {
  fleet?.cleanup();
  fleet = null;
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function retire(machine: Machine, device: string): void {
  appendRecord(machine.store(), {
    partition: "shared",
    stream: "settings",
    kind: "device-retire",
    agent: "t",
    body: { authority: "human", device },
  });
}

describe("the auto_legacy_removal setting", () => {
  const cases: ReadonlyArray<{
    readonly config: string;
    readonly env?: Record<string, string>;
    readonly enabled: boolean;
  }> = [
    { config: "", enabled: true },
    { config: "auto_legacy_removal: false\n", enabled: false },
    { config: "auto_legacy_removal: maybe\n", enabled: false },
    { config: "auto_store_migration: false\n", enabled: false },
    { config: "auto_legacy_removal: on\n", enabled: true },
    { config: "", env: { [AUTO_LEGACY_REMOVAL_ENV]: "0" }, enabled: false },
    { config: "", env: { [AUTO_STORE_MIGRATION_ENV]: "off" }, enabled: false },
    {
      config: "auto_legacy_removal: false\n",
      env: { [AUTO_LEGACY_REMOVAL_ENV]: "1" },
      enabled: false,
    },
  ];
  for (const c of cases) {
    test(`${JSON.stringify(c.config)} ${JSON.stringify(c.env ?? {})} -> ${c.enabled ? "on" : "off"}`, () => {
      const dir = mkdtempSync(join(tmpdir(), "osb-auto-removal-setting-"));
      try {
        const path = join(dir, "config.yaml");
        writeFileSync(path, c.config);
        Object.assign(process.env, c.env ?? {});
        expect(autoLegacyRemovalSetting(path).enabled).toBe(c.enabled);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }
});

describe("the session line", () => {
  const pending: AutoRemovalState = {
    at: T0.toISOString(),
    outcome: "pending",
    pending: [{ device: "dev-b", last_evidence: "2026-11-20T10:00:00.000Z" }],
  };

  test("names the device to update, once a day, while the tree is there", () => {
    const line = autoRemovalNoticeFor(pending, T0, true);
    expect(line?.code).toBe("legacy_tree_waiting");
    expect(line?.message).toContain(
      "until device dev-b (last seen 2026-11-20) runs Open Second Brain 2.0",
    );
    expect(line?.message).toContain("the tree leaves by itself");
    const day = `${T0.getFullYear()}-${String(T0.getMonth() + 1).padStart(2, "0")}-${String(T0.getDate()).padStart(2, "0")}`;
    expect(autoRemovalNoticeFor({ ...pending, shown_day: day }, T0, true)).toBeNull();
    expect(
      autoRemovalNoticeFor({ ...pending, shown_day: day }, at(24 * HOUR), true),
    ).not.toBeNull();
    expect(autoRemovalNoticeFor(pending, T0, false)).toBeNull();
  });

  test("a refusal names its reason and the manual command", () => {
    const line = autoRemovalNoticeFor(
      { at: T0.toISOString(), outcome: "refused", reason: "2 settings shard(s) cannot be read" },
      T0,
      true,
    );
    expect(line?.severity).toBe("warning");
    expect(line?.message).toContain("2 settings shard(s) cannot be read");
    expect(line?.message).toContain("o2b brain migrate-store --remove-legacy");
  });

  test("a wait for records in flight names what holds it", () => {
    const line = autoRemovalNoticeFor(
      {
        at: T0.toISOString(),
        outcome: "pending",
        in_flight: true,
        pending: [{ device: "dev-b", last_evidence: null }],
        reason:
          "device dev-b switched on a release that did not record which records its migration " +
          "wrote; it records them at its first start on Open Second Brain 2.0.1 or later",
      },
      T0,
      true,
    );
    expect(line?.message).toContain("until the records of device dev-b have arrived");
    expect(line?.message).toContain("What holds it: device dev-b switched on a release");
    expect(line?.message).toContain("2.0.1 or later");
  });

  test("a finished removal is said once", () => {
    const removed: AutoRemovalState = { at: T0.toISOString(), outcome: "removed", archive: "/a" };
    expect(autoRemovalNoticeFor(removed, T0, false)?.code).toBe("legacy_tree_removed");
    expect(autoRemovalNoticeFor({ ...removed, shown_removed: true }, T0, false)).toBeNull();
  });
});

describe("a vault whose cohort is two machines", () => {
  test("the tree stays while one is on the legacy layout and leaves by itself once it switched", () => {
    fleet = makeFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    // The silence rule off, so the fixture's fixed dates retire no one;
    // dev-c is a machine that is gone, retired by hand.
    setSilenceDays(a, 0);
    retire(a, "dev-c");

    expect(shouldStartAutoLegacyRemoval(a.vault, undefined, T0)).toBe(true);
    const waiting = runAutoLegacyRemoval(a.vault, { now: T0 });
    expect(waiting?.outcome).toBe("pending");
    expect(waiting?.pending?.map((d) => d.device)).toEqual(["dev-b"]);
    expect(existsSync(join(a.vault, "Brain"))).toBe(true);

    const line = takeAutoRemovalNotice(a.vault, undefined, T0);
    expect(line?.message).toContain("dev-b");
    expect(takeAutoRemovalNotice(a.vault, undefined, at(HOUR))).toBeNull();

    // A start asks again only once the retry interval has passed.
    expect(shouldStartAutoLegacyRemoval(a.vault, undefined, at(AUTO_REMOVAL_RETRY_MS - 1))).toBe(
      false,
    );
    expect(shouldStartAutoLegacyRemoval(a.vault, undefined, at(AUTO_REMOVAL_RETRY_MS))).toBe(true);

    // dev-b updates and migrates; its switch reaches dev-a by sync.
    fleet.syncVaultFile("dev-a", "dev-b", "Brain/vault-id.json");
    fleet.syncStore("dev-a", "dev-b");
    b.use();
    expect(migrateStore(b.vault, FAST).ok).toBe(true);
    fleet.syncStore("dev-b", "dev-a");
    a.use();

    const removed = runAutoLegacyRemoval(a.vault, { now: at(2 * HOUR) });
    expect(removed?.outcome).toBe("removed");
    expect(existsSync(join(a.vault, "Brain"))).toBe(false);
    expect(existsSync(join(a.vault, ".open-second-brain"))).toBe(false);
    expect(shouldStartAutoLegacyRemoval(a.vault, undefined, at(4 * HOUR))).toBe(false);
    expect(takeAutoRemovalNotice(a.vault, undefined, at(3 * HOUR))?.code).toBe(
      "legacy_tree_removed",
    );
    expect(takeAutoRemovalNotice(a.vault, undefined, at(3 * HOUR))).toBeNull();
  });

  test("a lock a worker left without its claim is taken over, not waited on forever", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    // A worker that died between creating the lock and writing its claim.
    const state = autoMigrationStateDir(a.vault);
    mkdirSync(state, { recursive: true });
    writeFileSync(join(state, "legacy-removal.lock"), "");
    const attempt = runAutoLegacyRemoval(a.vault, { now: T0 });
    expect(attempt?.outcome).toBe("refused");
    expect(existsSync(join(state, "legacy-removal.lock"))).toBe(false);
  });

  test("a refusal waits a day, and the setting off never removes", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    // Not switched: the removal refuses.
    const refused = runAutoLegacyRemoval(a.vault, { now: T0 });
    expect(refused?.outcome).toBe("refused");
    expect(shouldStartAutoLegacyRemoval(a.vault, undefined, at(AUTO_REMOVAL_RETRY_MS))).toBe(false);
    expect(
      shouldStartAutoLegacyRemoval(a.vault, undefined, at(AUTO_REMOVAL_REFUSED_RETRY_MS)),
    ).toBe(true);
    process.env[AUTO_LEGACY_REMOVAL_ENV] = "false";
    // Off: a start asks only for this device's own migration cut, which the
    // other devices' removals wait for, at most once an hour until it is
    // recorded; the removal itself never runs.
    const off = at(AUTO_REMOVAL_REFUSED_RETRY_MS);
    expect(runAutoLegacyRemoval(a.vault, { now: off })).toBeNull();
    expect(
      shouldStartAutoLegacyRemoval(
        a.vault,
        undefined,
        at(AUTO_REMOVAL_REFUSED_RETRY_MS + HOUR / 2),
      ),
    ).toBe(false);
    expect(existsSync(join(a.vault, "Brain"))).toBe(true);
  });
});
