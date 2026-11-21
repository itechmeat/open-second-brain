/**
 * The removal cohort on a store read that cannot see a device's newest
 * record (a shard that is a link or cannot be read). The fold that dates
 * a device skips such a shard, so the device looked older than it is: a
 * live device could be retired by silence, or a retired device that wrote
 * again could drop out of the cohort, and `--remove-legacy` would take the
 * tree while it still writes. A device the store read cannot tell for is
 * now never silent and never retired on that read: the gate holds.
 */
import { afterEach, beforeEach, expect, setDefaultTimeout, setSystemTime, test } from "bun:test";
import { readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { appendRecord } from "../../../src/core/store/appender.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { cohortStatus, readCohortStatus } from "../../../src/core/store-migration/cohort-status.ts";
import { legacyDevices } from "../../../src/core/store-migration/migration-records.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { removeLegacy } from "../../../src/core/store-migration/outcome.ts";
import { IS_WINDOWS } from "../../helpers/platform.ts";
import { CLI_SPAWN_BUDGET_MS } from "../../helpers/cli-timeout.ts";
import { makeFleet, type Fleet, type Machine } from "./fixtures/fleet.ts";
import { setSilenceDays } from "./fixtures/silence.ts";

setDefaultTimeout(CLI_SPAWN_BUDGET_MS);

const NOW = new Date("2026-11-19T00:00:00Z");
let fleet: Fleet | null = null;
beforeEach(() => setSystemTime(NOW));
afterEach(() => {
  setSystemTime();
  fleet?.cleanup();
  fleet = null;
});

function migrated(): Machine {
  fleet = makeFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  expect(runMigration(a.vault, { settleMs: 0 }).ok).toBe(true);
  return a;
}

/** A store record dev-c wrote on `day`, into this machine's copy of the store. */
function devCWrites(a: Machine, day: string): void {
  const c = openStore({ root: a.storeRoot, device: "dev-c" });
  appendRecord(
    c,
    { partition: "shared", stream: "events", kind: "note", agent: "t", body: { text: "alive" } },
    { now: () => Date.parse(`${day}T09:00:00Z`) },
  );
}

/** Every shard of dev-c becomes a link a sync peer swapped in: the reader refuses it. */
function linkDevCShards(a: Machine): void {
  const dir = join(a.storeRoot, "shared", "events", "dev-c");
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    renameSync(path, `${path}.aside`);
    symlinkSync(`${path}.aside`, path);
  }
}

test.skipIf(IS_WINDOWS)(
  "a device whose newest record cannot be read is never retired by silence",
  () => {
    const a = migrated();
    setSilenceDays(a, 10);
    devCWrites(a, "2026-11-15");
    const seen = readCohortStatus(a.store(), a.vault, NOW);
    expect(seen.pending.map((d) => d.device)).toContain("dev-c");

    linkDevCShards(a);
    const blind = readCohortStatus(a.store(), a.vault, NOW);
    expect(blind.retired_by_silence.map((d) => d.device)).not.toContain("dev-c");
    expect(blind.pending.map((d) => d.device)).toContain("dev-c");
    // The removal itself refuses on a shard it cannot read in full.
    expect(() => removeLegacy(a.vault)).toThrow(/cannot be read in full/);
  },
);

test.skipIf(IS_WINDOWS)("a retired device whose return cannot be read stays in the cohort", () => {
  const a = migrated();
  setSilenceDays(a, 0);
  appendRecord(a.store(), {
    partition: "shared",
    stream: "settings",
    kind: "device-retire",
    agent: "t",
    body: { authority: "human", device: "dev-c" },
  });
  expect(readCohortStatus(a.store(), a.vault, NOW).retired).toContain("dev-c");
  // dev-c writes again after its retirement: back in the cohort.
  devCWrites(a, "2026-11-18");
  expect(readCohortStatus(a.store(), a.vault, NOW).pending.map((d) => d.device)).toContain("dev-c");

  linkDevCShards(a);
  const blind = readCohortStatus(a.store(), a.vault, NOW);
  expect(blind.retired).not.toContain("dev-c");
  expect(blind.pending.map((d) => d.device)).toContain("dev-c");
  expect(() => removeLegacy(a.vault)).toThrow(/cannot be read in full/);
});

test("an empty newest shard never makes a live device look silent to the removal", () => {
  const a = migrated();
  setSilenceDays(a, 60);
  // dev-c wrote a month ago, then a crash left an empty shard of this month.
  devCWrites(a, "2026-10-20");
  writeFileSync(join(a.storeRoot, "shared", "events", "dev-c", "2026-11.jsonl"), "");
  const cohort = readCohortStatus(a.store(), a.vault, NOW);
  expect(cohort.retired_by_silence.map((d) => d.device)).not.toContain("dev-c");
  expect(cohort.pending.find((d) => d.device === "dev-c")?.last_evidence).toBe(
    "2026-10-20T09:00:00.000Z",
  );
  const removal = removeLegacy(a.vault);
  if (removal.removed) throw new Error("the tree was removed while dev-c is alive");
  expect(removal.reason).toBe("cohort-pending");
  expect(removal.pending).toContain("dev-c");
});

/** A store record `device` wrote on `day`, its shards then all links. */
function writesThenLinks(a: Machine, device: string, day: string): void {
  const store = openStore({ root: a.storeRoot, device });
  appendRecord(
    store,
    { partition: "shared", stream: "events", kind: "note", agent: "t", body: { text: "x" } },
    { now: () => Date.parse(`${day}T09:00:00Z`) },
  );
  const dir = join(a.storeRoot, "shared", "events", device);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    renameSync(path, `${path}.aside`);
    symlinkSync(`${path}.aside`, path);
  }
}

function retire(a: Machine, device: string, authority: "human" | "agent"): void {
  appendRecord(a.store(), {
    partition: "shared",
    stream: "settings",
    kind: "device-retire",
    agent: "t",
    body: { authority, device },
  });
}

test.skipIf(IS_WINDOWS)("retirement and silence are decided on one store read", () => {
  const a = migrated();
  devCWrites(a, "2026-11-10");
  retire(a, "dev-c", "human");
  // The membership a caller read before the shard turned unreadable: dev-c
  // is retired by hand and has not written since.
  const earlier = legacyDevices(a.store(), ["dev-b", "dev-c"]);
  expect(earlier).not.toContain("dev-c");
  linkDevCShards(a);
  const cohort = cohortStatus(a.store(), {
    legacy: earlier,
    legacyEvidence: new Map(),
    now: NOW,
  });
  // The same read that dates dev-c cannot tell whether it wrote again.
  expect(cohort.retired).not.toContain("dev-c");
  expect(cohort.pending.map((d) => d.device)).toContain("dev-c");
});

test.skipIf(IS_WINDOWS)(
  "a device named only by an unreadable legacy shard is a cohort member",
  () => {
    const a = migrated();
    a.write("Brain/log/2026-11-18.dev-z.jsonl", '{"ts":"2026-11-18T09:00:00Z"}\n');
    const path = join(a.vault, "Brain", "log", "2026-11-18.dev-z.jsonl");
    renameSync(path, `${path}.aside`);
    symlinkSync(`${path}.aside`, path);
    const cohort = readCohortStatus(a.store(), a.vault, NOW);
    expect(cohort.pending.map((d) => d.device)).toContain("dev-z");
  },
);

test.skipIf(IS_WINDOWS)(
  "only a human retirement is held in the cohort by an unreadable shard",
  () => {
    const a = migrated();
    retire(a, "dev-q", "agent");
    writesThenLinks(a, "dev-q", "2026-11-18");
    const cohort = readCohortStatus(a.store(), a.vault, NOW);
    expect(cohort.devices.map((d) => d.device)).not.toContain("dev-q");
  },
);
