/**
 * The later-machine path and the transition (task 2.4): two and three
 * devices, each with its own copy of the vault and of the store, synced
 * explicitly. A later machine imports only its own legacy records the
 * store lacks; a completion record that arrives before its data makes it
 * wait; a machine still on the old release keeps writing and a switched
 * machine imports those writes exactly once, naming the machine as still
 * on the legacy layout.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { STORE_DUAL_WRITE_ENV } from "../../../src/core/store/constants.ts";
import { withLocalLock } from "../../../src/core/store/local-lock.ts";
import { migrationDir } from "../../../src/core/store-migration/journal.ts";
import { cutWait } from "../../../src/core/store-migration/later.ts";
import { importLateLegacyWrites } from "../../../src/core/store-migration/transition.ts";
import { recordFreshInstallSwitch } from "../../../src/core/store/fresh-switch.ts";
import { migrationAvailability } from "../../../src/core/store/migration-availability.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import {
  DEVICE_SWITCHED_KIND,
  isDeviceSwitched,
  MIGRATION_DONE_KIND,
  MIGRATION_STREAM,
} from "../../../src/core/store-migration/migration-records.ts";
import { migrateStore } from "../../../src/core/store-migration/outcome.ts";
import { writeVaultIdentity } from "../../../src/core/brain/vault-identity.ts";
import { readVaultBindings } from "../../../src/core/vault-adapter/vault-binding.ts";
import { readViewWriter } from "../../../src/core/view/writer.ts";
import { makeFleet, type Fleet } from "./fixtures/fleet.ts";

const FAST = { settleMs: 0 } as const;
/** The vault identity marker the first migration gives a vault; sync carries it. */
const MARKER = "Brain/vault-id.json";
let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
});

const SIGNAL = (id: string): string =>
  `---\nid: ${id}\ntopic: ${id}\nprinciple: ${id}\n---\nRaw.\n`;
const LOG_LINE = (text: string): string =>
  `${JSON.stringify({ ts: "2026-11-05T10:00:00Z", kind: "note", payload: { text } })}\n`;

/**
 * Item keys whose records `device` wrote, leaving out the snapshot log
 * event each migration's own snapshot appends to its machine's log.
 */
function importedBy(byKey: Map<string, StoreRecord[]>, device: string): string[] {
  return [...byKey]
    .filter(([, records]) => records.some((r) => r.device === device))
    .filter(([, records]) => records[0]!.body["event_type"] !== "snapshot")
    .map(([key]) => key)
    .toSorted();
}

/** Every imported item key holds exactly one record set (one record per part). */
function expectOnce(byKey: Map<string, StoreRecord[]>): void {
  for (const [key, records] of byKey) {
    const parts = new Set(records.map((r) => (r.body["migrated"] as { part: number }).part));
    expect([key, records.length]).toEqual([key, parts.size]);
  }
}

describe("a later machine", () => {
  test("imports exactly its own legacy records the store lacks, then records its switch", () => {
    fleet = makeFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    // B holds a signal and a log line that never reached A.
    b.write("Brain/inbox/2026-11-05-only-b.md", SIGNAL("sig-only-b"));
    b.write("Brain/log/2026-11-05.dev-b.jsonl", LOG_LINE("only on b"));

    a.use();
    const first = runMigration(a.vault, FAST);
    expect(first.ok).toBe(true);
    expect(first.role).toBe("first");
    fleet.syncVaultFile("dev-a", "dev-b", MARKER);
    fleet.syncStore("dev-a", "dev-b");

    b.use();
    const second = migrateStore(b.vault, FAST);
    expect(second.mode).toBe("migration");
    if (second.mode !== "migration") throw new Error("unreachable");
    expect(second.ok).toBe(true);
    expect(second.role).toBe("later");
    expect(second.migration_done).toBeNull();

    const byKey = b.byKey();
    expect(importedBy(byKey, "dev-b")).toEqual([
      "Brain/inbox/2026-11-05-only-b.md",
      "Brain/log/2026-11-05.dev-b.jsonl#1",
    ]);
    expectOnce(byKey);
    expect(byKey.get("Brain/inbox/2026-11-05-only-b.md")?.[0]?.device).toBe("dev-b");
    expect(byKey.get("Brain/inbox/2026-11-01-tabs.md")?.[0]?.device).toBe("dev-a");
    const kinds = b.records().map((r) => r.kind);
    expect(kinds.filter((k) => k === MIGRATION_DONE_KIND)).toHaveLength(1);
    expect(kinds.filter((k) => k === DEVICE_SWITCHED_KIND)).toHaveLength(2);
    expect(isDeviceSwitched(b.store(), "dev-b")).toBe(true);
    expect(readViewWriter(b.store()).writer).toBe("dev-a");
    // Its own machine state moves to device-local state: the secrets, not
    // the search index, which the switched machine rebuilds.
    expect(second.device_local).toContain(".open-second-brain/secrets/keyfile");
    expect(second.device_local).not.toContain(".open-second-brain/brain.sqlite");
    // Each machine bound its own vault to the store in its device-local state.
    expect(readVaultBindings().map((v) => [v.device, v.vault])).toEqual([
      ["dev-b", realpathSync(b.vault)],
    ]);
    a.use();
    expect(readVaultBindings().map((v) => [v.device, v.vault])).toEqual([
      ["dev-a", realpathSync(a.vault)],
    ]);
  });

  test("waits while the completion record arrived before its data, then proceeds", () => {
    fleet = makeFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    fleet.syncVaultFile("dev-a", "dev-b", MARKER);
    // Only the settings shard (with migration-done) has synced so far.
    fleet.syncStore("dev-a", "dev-b", (rel) => !rel.includes("/events/") && !rel.includes("/log/"));

    b.use();
    const before = b.records().length;
    const waiting = migrateStore(b.vault, FAST);
    expect(waiting.mode).toBe("waiting");
    if (waiting.mode !== "waiting") throw new Error("unreachable");
    expect(waiting.wait.missing.some((m) => m.startsWith("shared/events/dev-a/"))).toBe(true);
    expect(waiting.wait.firstMachines).toEqual(["dev-a"]);
    expect(b.records()).toHaveLength(before);
    expect(isDeviceSwitched(b.store(), "dev-b")).toBe(false);

    fleet.syncStore("dev-a", "dev-b");
    const done = migrateStore(b.vault, FAST);
    expect(done.mode).toBe("migration");
    expect(done.ok).toBe(true);
    expect(importedBy(b.byKey(), "dev-b")).toEqual([]);
    expectOnce(b.byKey());
  });
});

describe("a dual write the first machine matched", () => {
  /** A signal dual-written on dev-a, its page synced to dev-b; then A migrates. */
  function dualWrittenOnA(marked: boolean): Fleet {
    const f = makeFleet(["dev-a", "dev-b"]);
    const [a] = [f.machine("dev-a")];
    a.use();
    // `o2b brain init` stamps the marker; the dual write then names the vault.
    if (marked) writeVaultIdentity(a.vault);
    const prior = process.env[STORE_DUAL_WRITE_ENV];
    process.env[STORE_DUAL_WRITE_ENV] = "1";
    let written = "";
    try {
      written = writeSignal(a.vault, {
        topic: "dw",
        signal: "positive",
        agent: "@dw",
        principle: "Dual written on A",
        created_at: "2026-11-03T10:00:00Z",
        date: "2026-11-03",
        slug: "dw-sig",
      }).path;
    } finally {
      if (prior === undefined) delete process.env[STORE_DUAL_WRITE_ENV];
      else process.env[STORE_DUAL_WRITE_ENV] = prior;
    }
    const page = relative(a.vault, written).split(sep).join("/");
    f.syncVaultFile("dev-a", "dev-b", page);
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    f.syncVaultFile("dev-a", "dev-b", MARKER);
    f.syncStore("dev-a", "dev-b");
    return f;
  }

  const dwSignals = (records: ReadonlyArray<StoreRecord>) =>
    records.filter((r) => r.kind === "signal" && String(r.body["id"]).includes("dw-sig"));

  test("is matched by a later machine too, never imported a second time", () => {
    fleet = dualWrittenOnA(true);
    const b = fleet.machine("dev-b");
    b.use();
    expect(runMigration(b.vault, FAST).ok).toBe(true);
    expect(dwSignals(b.records())).toHaveLength(1);
  });

  test("written before the vault had a marker, a later machine imports its own copy", () => {
    // The unmarked copy names no vault; only dev-a can tell it is A's.
    fleet = dualWrittenOnA(false);
    const b = fleet.machine("dev-b");
    b.use();
    expect(runMigration(b.vault, FAST).ok).toBe(true);
    const signals = dwSignals(b.records());
    expect(signals).toHaveLength(2);
    expect(signals.filter((r) => r.body["migrated"] !== undefined).map((r) => r.device)).toEqual([
      "dev-b",
    ]);
  });
});

describe("the transition", () => {
  test("a machine on the old release keeps writing; switched machines import it once", () => {
    fleet = makeFleet(["dev-a", "dev-b", "dev-c"]);
    const [a, b, c] = ["dev-a", "dev-b", "dev-c"].map((n) => fleet!.machine(n)) as [
      ReturnType<Fleet["machine"]>,
      ReturnType<Fleet["machine"]>,
      ReturnType<Fleet["machine"]>,
    ];
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    for (const to of ["dev-b", "dev-c"]) fleet.syncVaultFile("dev-a", to, MARKER);
    fleet.syncStore("dev-a", "dev-b");
    fleet.syncStore("dev-a", "dev-c");

    // C is still on the old release and writes the legacy layout; the vault
    // sync delivers its files to A and B.
    c.write("Brain/inbox/2026-11-06-from-c.md", SIGNAL("sig-from-c"));
    c.write("Brain/log/2026-11-06.dev-c.jsonl", LOG_LINE("written by c"));
    for (const rel of ["Brain/inbox/2026-11-06-from-c.md", "Brain/log/2026-11-06.dev-c.jsonl"]) {
      fleet.syncVaultFile("dev-c", "dev-a", rel);
      fleet.syncVaultFile("dev-c", "dev-b", rel);
    }

    a.use();
    const late = migrateStore(a.vault, FAST);
    expect(late.mode).toBe("transition");
    if (late.mode !== "transition") throw new Error("unreachable");
    expect(late.imported).toBe(2);
    expect(late.legacy_devices).toEqual(["dev-b", "dev-c"]);
    const again = migrateStore(a.vault, FAST);
    if (again.mode !== "transition") throw new Error("unreachable");
    expect(again.imported).toBe(0);

    // B upgrades: everything it holds is in the store already.
    fleet.syncStore("dev-a", "dev-b");
    b.use();
    const second = migrateStore(b.vault, FAST);
    if (second.mode !== "migration") throw new Error(`unexpected ${second.mode}`);
    expect(second.ok).toBe(true);
    expect(importedBy(b.byKey(), "dev-b")).toEqual([]);
    fleet.syncStore("dev-b", "dev-a");

    a.use();
    const still = migrateStore(a.vault, FAST);
    if (still.mode !== "transition") throw new Error("unreachable");
    expect(still.legacy_devices).toEqual(["dev-c"]);

    // C upgrades at last.
    fleet.syncStore("dev-a", "dev-c");
    c.use();
    const third = migrateStore(c.vault, FAST);
    if (third.mode !== "migration") throw new Error(`unexpected ${third.mode}`);
    expect(third.ok).toBe(true);
    expect(importedBy(c.byKey(), "dev-c")).toEqual([]);
    fleet.syncStore("dev-c", "dev-a");

    a.use();
    const after = migrateStore(a.vault, FAST);
    if (after.mode !== "transition") throw new Error("unreachable");
    expect(after.legacy_devices).toEqual([]);
    expectOnce(a.byKey());
    const fromC = a.byKey().get("Brain/inbox/2026-11-06-from-c.md");
    expect(fromC).toHaveLength(1);
  });
});

describe("a synced completion record", () => {
  test("whose cut is malformed is waited on and named, never a crash", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    const store = a.store();
    for (const cuts of [{ shared: { cut: "nope" } }, { shared: { cut: [{ shard: 1 }] } }, 7]) {
      appendRecord(store, {
        partition: "shared",
        stream: MIGRATION_STREAM,
        kind: MIGRATION_DONE_KIND,
        agent: "test",
        body: {
          authority: "human",
          vault_id: null,
          device: "dev-a",
          cuts,
          imported: 0,
        },
      });
    }
    const wait = cutWait(store);
    expect(wait.missing).toHaveLength(3);
    expect(wait.missing.every((m) => m.includes("unreadable cut"))).toBe(true);
  });
});

describe("a transition import", () => {
  test("whose legacy tree keeps changing past the pass limit is not ok", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    a.write("Brain/inbox/2026-11-05-late-0.md", SIGNAL("sig-late-0"));
    let n = 0;
    // A machine on the old release writes a new signal for every item imported.
    const grow = (): void => {
      n += 1;
      a.write(`Brain/inbox/2026-11-05-late-${n}.md`, SIGNAL(`sig-late-${n}`));
    };
    const outcome = migrateStore(a.vault, {
      ...FAST,
      hooks: { afterItemAppended: grow },
    });
    expect(outcome.mode).toBe("transition");
    if (outcome.mode !== "transition") throw new Error("unreachable");
    expect(outcome.converged).toBe(false);
    expect(outcome.ok).toBe(false);
  });

  test("runs one at a time on a machine", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    const store = a.store();
    const prior = process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"];
    process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"] = "50";
    try {
      withLocalLock(join(migrationDir(store), "transition-import"), () => {
        expect(() => importLateLegacyWrites(a.vault, store, "t", null)).toThrow(/busy/);
      });
    } finally {
      if (prior === undefined) delete process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"];
      else process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"] = prior;
    }
  });
});

describe("a vault configured after a vault-free switch", () => {
  test("is offered its migration, imported through the transition, then bound", () => {
    fleet = makeFleet(["dev-a"]);
    const a = fleet.machine("dev-a");
    a.use();
    // The machine switched with no vault (a fresh vault-free install).
    expect(recordFreshInstallSwitch({ vault: null })).toBe("recorded");
    const before = migrationAvailability({ vault: a.vault });
    expect(before.switched).toBe(true);
    expect(before.available).toBe(true);

    const outcome = migrateStore(a.vault, FAST);
    expect(outcome.mode).toBe("transition");
    if (outcome.mode !== "transition") throw new Error("unreachable");
    expect(outcome.imported).toBeGreaterThan(0);
    expect(a.byKey().has("Brain/inbox/2026-11-01-tabs.md")).toBe(true);
    expect(readVaultBindings().map((v) => v.vault)).toEqual([realpathSync(a.vault)]);
    expect(migrationAvailability({ vault: a.vault }).available).toBe(false);
  });
});

describe("vaults without an identity marker on two devices", () => {
  const LOG = "Brain/log/2026-10-01.jsonl#1";

  test("two distinct vaults with an identical row get a record each", () => {
    fleet = makeFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    // Two different vaults, neither with a marker, holding the same first
    // log row at the same relative path.
    expect(existsSync(join(a.vault, ...MARKER.split("/")))).toBe(false);
    expect(existsSync(join(b.vault, ...MARKER.split("/")))).toBe(false);
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    fleet.syncStore("dev-a", "dev-b");

    b.use();
    // A's migration named its vault by the marker it gave it. B has none:
    // it waits, since sync may still be delivering that marker.
    const waiting = migrateStore(b.vault, FAST);
    if (waiting.mode !== "waiting") throw new Error(`unexpected ${waiting.mode}`);
    expect(waiting.wait.marker).toBe(true);
    expect(waiting.wait.firstMachines).toEqual(["dev-a"]);
    expect(importedBy(b.byKey(), "dev-b")).toEqual([]);
    // B is another vault: the operator gives it its own marker (`o2b brain init`).
    writeVaultIdentity(b.vault);
    expect(runMigration(b.vault, FAST).ok).toBe(true);
    const devices = (b.byKey().get(LOG) ?? []).map((r) => r.device).toSorted();
    expect(devices).toEqual(["dev-a", "dev-b"]);
    const ids = new Set((b.byKey().get(LOG) ?? []).map((r) => r.body["vault_id"]));
    expect(ids.size).toBe(2);
  });

  test("the same vault migrated on both devices is imported once", () => {
    fleet = makeFleet(["dev-a", "dev-b"]);
    const [a, b] = [fleet.machine("dev-a"), fleet.machine("dev-b")];
    a.use();
    expect(runMigration(a.vault, FAST).ok).toBe(true);
    // The migration gave the vault its marker. The store reaches dev-b
    // first: dev-b waits rather than mint a marker of its own.
    expect(existsSync(join(a.vault, ...MARKER.split("/")))).toBe(true);
    fleet.syncStore("dev-a", "dev-b");
    b.use();
    const waiting = migrateStore(b.vault, FAST);
    expect(waiting.mode).toBe("waiting");
    expect(existsSync(join(b.vault, ...MARKER.split("/")))).toBe(false);

    fleet.syncVaultFile("dev-a", "dev-b", MARKER);
    expect(runMigration(b.vault, FAST).ok).toBe(true);
    expect((b.byKey().get(LOG) ?? []).map((r) => r.device)).toEqual(["dev-a"]);
    expect(importedBy(b.byKey(), "dev-b")).toEqual([]);
    expectOnce(b.byKey());
  });
});
