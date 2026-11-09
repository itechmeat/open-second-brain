/**
 * A machine already switched for vault A that is then pointed at a vault
 * B still on the legacy layout (task 2.4, design D11 and D14): the
 * transition import takes B's records and its operator settings, binds B
 * only once nothing of B is left behind, and a rollback never restores
 * A's backup into B.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";

import type { DoctorCheckContext, DoctorFindings } from "../../../src/core/brain/doctor/check.ts";
import {
  PERMISSIONS_LEGACY_ONLY_CODE,
  permissionsLegacyOnlyCheck,
} from "../../../src/core/brain/doctor/permissions-check.ts";
import { loadPermissionsDocumentFor } from "../../../src/core/brain/permissions/document-source.ts";
import { PERMISSIONS_DOCUMENT_SETTING } from "../../../src/core/brain/permissions/document.ts";
import { readVaultIdentity, writeVaultIdentity } from "../../../src/core/brain/vault-identity.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { buildRecord, type StoreRecord } from "../../../src/core/store/envelope.ts";
import { readPartition } from "../../../src/core/store/state-digest.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { AUTHORITY_FIELD, SETTING_SET_KIND } from "../../../src/core/store/constants.ts";
import { holdMigrationGate, readMigrationGate } from "../../../src/core/migration-gate.ts";
import {
  migrationDir,
  readMigrationState,
  writeMigrationState,
} from "../../../src/core/store-migration/journal.ts";
import { runMigration } from "../../../src/core/store-migration/migrate.ts";
import { isDeviceSwitched } from "../../../src/core/store-migration/migration-records.ts";
import { migrateStore, rollback } from "../../../src/core/store-migration/outcome.ts";
import { RollbackRefusedError } from "../../../src/core/store-migration/rollback.ts";
import { migrationAvailability } from "../../../src/core/store/migration-availability.ts";
import {
  readVaultBindings,
  vaultBindingPath,
} from "../../../src/core/vault-adapter/vault-binding.ts";
import { makeFleet, type Fleet, type Machine } from "./fixtures/fleet.ts";
import {
  makeLegacyVault,
  UNMAPPED_LEGACY_ENTRIES,
  type LegacyVaultFixture,
} from "./fixtures/legacy-vault.ts";
import { moveNeverHeld } from "../../helpers/held-partitions.ts";

const FAST = { settleMs: 0 } as const;
const DENY_ALL = "version: 1\ndefault_action: deny\n";
const ALLOW_ALL = "version: 1\ndefault_action: allow\n";

let fleet: Fleet | null = null;
let second: LegacyVaultFixture | null = null;
afterEach(() => {
  fleet?.cleanup();
  fleet = null;
  second?.cleanup();
  second = null;
});

/**
 * The items of vault B a machine without `private` holds back: the
 * fixture's five private items (B's own, though A holds the same ones at
 * the same paths) and the secret page a test adds.
 */
const B_PRIVATE_ITEMS = 6;

const SIGNAL = (id: string, extra = ""): string =>
  `---\nid: ${id}\ntopic: ${id}\nprinciple: ${id}\n${extra}---\nRaw.\n`;

/** Every file below `dir` with its content hash, vault-relative. */
function treeDigest(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (at: string): void => {
    for (const name of readdirSync(at)) {
      const path = join(at, name);
      if (statSync(path).isDirectory()) walk(path);
      else {
        out[relative(dir, path).split(sep).join("/")] = createHash("sha256")
          .update(readFileSync(path))
          .digest("hex");
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Machine dev-a switched for its own vault A (with an identity marker),
 * then a second legacy vault B with an identity of its own and a signal
 * the store does not hold.
 */
function switchedForA(withIdentity = true): { a: Machine; vaultB: string } {
  fleet = makeFleet(["dev-a"]);
  const a = fleet.machine("dev-a");
  a.use();
  if (withIdentity) writeVaultIdentity(a.vault);
  expect(runMigration(a.vault, FAST).ok).toBe(true);
  second = makeLegacyVault("osb-second-vault-");
  for (const rel of UNMAPPED_LEGACY_ENTRIES) {
    rmSync(join(second.vault, ...rel.split("/")), { force: true });
  }
  if (withIdentity) writeVaultIdentity(second.vault);
  second.write("Brain/inbox/2026-11-08-only-b.md", SIGNAL("sig-only-b"));
  return { a, vaultB: second.vault };
}

describe("rollback after a second vault was imported through the transition", () => {
  test("refuses for vault B, whose backup this machine never took, and touches nothing", () => {
    const { a, vaultB } = switchedForA();
    const outcome = migrateStore(vaultB, FAST);
    expect(outcome.mode).toBe("transition");
    const before = treeDigest(vaultB);
    const records = a.records().length;
    expect(() => rollback(vaultB)).toThrow(RollbackRefusedError);
    expect(() => rollback(vaultB)).toThrow(/backup .*another vault|not of this vault/);
    expect(treeDigest(vaultB)).toEqual(before);
    expect(a.records()).toHaveLength(records);
    expect(isDeviceSwitched(a.store(), "dev-a")).toBe(true);
  });

  test("decides by the vault path when neither vault has an identity marker", () => {
    const { a, vaultB } = switchedForA(false);
    migrateStore(vaultB, FAST);
    const before = treeDigest(vaultB);
    expect(() => rollback(vaultB)).toThrow(RollbackRefusedError);
    expect(treeDigest(vaultB)).toEqual(before);
    // Vault A, whose backup it is, still rolls back.
    expect(rollback(a.vault).unswitched).not.toBe("");
  });
});

describe("a private page of vault B on a machine that holds only shared", () => {
  test("keeps B unbound and the outcome not ok, then binds once the partition is back", () => {
    const { a, vaultB } = switchedForA();
    second!.write(
      "Brain/inbox/2026-11-08-secret.md",
      SIGNAL("sig-secret-b", "visibility: private\n"),
    );
    const aside = join(fleet!.parent, "private-aside");
    moveNeverHeld(a.storeRoot, aside);
    const held = migrateStore(vaultB, FAST);
    if (held.mode !== "transition") throw new Error("expected the transition");
    expect(held.held_back).toBe(B_PRIVATE_ITEMS);
    expect(held.ok).toBe(false);
    expect(held.bound).toBe(false);
    expect(readVaultBindings().map((v) => v.vault)).not.toContain(realpathSync(vaultB));
    expect(migrationAvailability({ vault: vaultB }).available).toBe(true);

    renameSync(aside, join(a.storeRoot, "private"));
    const again = migrateStore(vaultB, FAST);
    if (again.mode !== "transition") throw new Error("expected the transition");
    expect(again.held_back).toBe(0);
    expect(again.ok).toBe(true);
    expect(again.bound).toBe(true);
    expect(a.byKey().has("Brain/inbox/2026-11-08-secret.md")).toBe(true);
    expect(migrationAvailability({ vault: vaultB }).available).toBe(false);
  });
});

describe("vault B while a store shard cannot be seen", () => {
  test("is imported but not bound, the shard named, and bound once it reads again", () => {
    const { a, vaultB } = switchedForA();
    // A peer's shard this machine reads, then it is gone.
    const shard = appendRecord(openStore({ root: a.storeRoot, device: "dev-p" }), {
      partition: "shared",
      stream: "events",
      kind: "log-event",
      agent: "t",
      body: { timestamp: "2026-11-08T10:00:00Z", event_type: "note", body: { text: "peer" } },
    }).path;
    expect(a.records().length).toBeGreaterThan(0);
    const bytes = readFileSync(shard);
    rmSync(shard);
    const outcome = migrateStore(vaultB, FAST);
    if (outcome.mode !== "transition") throw new Error(`mode ${outcome.mode}`);
    expect(outcome.ok).toBe(false);
    expect(outcome.bound).toBe(false);
    expect(outcome.unseen_shards.join(",")).toContain("shared/events/dev-p/");
    expect(readVaultBindings().map((v) => realpathSync(v.vault))).toEqual([realpathSync(a.vault)]);
    writeFileSync(shard, bytes);
    const again = migrateStore(vaultB, FAST);
    if (again.mode !== "transition") throw new Error(`mode ${again.mode}`);
    expect(again.unseen_shards).toEqual([]);
    expect(again.bound).toBe(true);
  });
});

describe("operator settings of vault B", () => {
  test("its deny rules become the permissions document when the store holds none", () => {
    const { vaultB } = switchedForA();
    second!.write("Brain/_permissions.yaml", DENY_ALL);
    const outcome = migrateStore(vaultB, FAST);
    if (outcome.mode !== "transition") throw new Error("expected the transition");
    expect(outcome.settings?.written).toContain(PERMISSIONS_DOCUMENT_SETTING);
    expect(outcome.ok).toBe(true);
    expect(loadPermissionsDocumentFor(vaultB).document?.default_action).toBe("deny");
  });

  test("deny rules that differ from the stored document refuse the binding", () => {
    const { a, vaultB } = switchedForA();
    appendRecord(a.store(), {
      partition: "shared",
      stream: "settings",
      kind: SETTING_SET_KIND,
      agent: "o",
      body: { [AUTHORITY_FIELD]: "human", key: PERMISSIONS_DOCUMENT_SETTING, value: ALLOW_ALL },
    });
    second!.write("Brain/_permissions.yaml", DENY_ALL);
    const outcome = migrateStore(vaultB, FAST);
    if (outcome.mode !== "transition") throw new Error("expected the transition");
    // The stored document stays (never overwritten), B stays unbound and
    // offered, and the outcome names the conflict.
    expect(outcome.ok).toBe(false);
    expect(outcome.bound).toBe(false);
    expect(outcome.permissions_conflict).toBe(true);
    expect(loadPermissionsDocumentFor(vaultB).document?.default_action).toBe("allow");
    expect(migrationAvailability({ vault: vaultB }).available).toBe(true);
    // Doctor names the deny rules no gate reads.
    const out: DoctorFindings = { issues: [], uncertain: [] };
    permissionsLegacyOnlyCheck.run(
      {
        vault: vaultB,
        now: new Date("2026-11-08T12:00:00Z"),
        config: undefined,
        dbPath: undefined,
        configPath: undefined,
        knownBasenames: new Set(),
        idIndex: new Map(),
        preferences: [],
        logs: [],
      } satisfies DoctorCheckContext,
      out,
    );
    expect(out.issues.map((i) => i.code)).toContain(PERMISSIONS_LEGACY_ONLY_CODE);
  });

  test("the transition for the vault the machine switched with imports no settings", () => {
    const { a } = switchedForA();
    a.write("Brain/_permissions.yaml", DENY_ALL);
    const outcome = migrateStore(a.vault, FAST);
    if (outcome.mode !== "transition") throw new Error("expected the transition");
    expect(outcome.settings).toBeNull();
    expect(outcome.ok).toBe(true);
    expect(existsSync(join(a.vault, "Brain", "_permissions.yaml"))).toBe(true);
  });
});

describe("a migration of vault A killed after its switch record, then vault B configured", () => {
  /** What a kill right after `device-switched` leaves: the run in progress, the gate held, A unbound. */
  function interruptA(a: Machine): string {
    const dir = migrationDir(a.store());
    const state = readMigrationState(dir)!;
    writeMigrationState(dir, { ...state, phase: "in-progress" });
    holdMigrationGate(a.vault, state.run_id);
    rmSync(vaultBindingPath(), { force: true });
    return dir;
  }

  test("finishes A's switch and binds A, and B still passes the permissions check", () => {
    const { a, vaultB } = switchedForA();
    const dir = interruptA(a);
    appendRecord(a.store(), {
      partition: "shared",
      stream: "settings",
      kind: SETTING_SET_KIND,
      agent: "o",
      body: { [AUTHORITY_FIELD]: "human", key: PERMISSIONS_DOCUMENT_SETTING, value: ALLOW_ALL },
    });
    second!.write("Brain/_permissions.yaml", DENY_ALL);

    const outcome = migrateStore(vaultB, FAST);
    if (outcome.mode !== "transition") throw new Error("expected the transition");
    expect(readMigrationState(dir)?.phase).toBe("done");
    expect(readMigrationGate()).toBeNull();
    const bound = readVaultBindings().map((b) => b.vault);
    expect(bound).toContain(realpathSync(a.vault));
    expect(bound).not.toContain(realpathSync(vaultB));
    expect(outcome.settings).not.toBeNull();
    expect(outcome.permissions_conflict).toBe(true);
    expect(outcome.bound).toBe(false);
    expect(outcome.ok).toBe(false);
  });

  test("decides by the vault path when neither vault has an identity marker", () => {
    const { a, vaultB } = switchedForA(false);
    interruptA(a);
    second!.write(
      "Brain/inbox/2026-11-08-secret.md",
      SIGNAL("sig-secret-b", "visibility: private\n"),
    );
    moveNeverHeld(a.storeRoot, join(fleet!.parent, "private-aside"));
    const outcome = migrateStore(vaultB, FAST);
    if (outcome.mode !== "transition") throw new Error("expected the transition");
    expect(outcome.held_back).toBe(B_PRIVATE_ITEMS);
    expect(outcome.bound).toBe(false);
    const bound = readVaultBindings().map((b) => b.vault);
    expect(bound).toContain(realpathSync(a.vault));
    expect(bound).not.toContain(realpathSync(vaultB));
  });
});

describe("an item of vault B identical to one of vault A at the same path", () => {
  const LOG = "Brain/log/2026-10-01.jsonl";
  const imported = (a: Machine) =>
    a.records().filter((r) => {
      const mark = r.body["migrated"] as { key?: unknown } | undefined;
      return typeof mark?.key === "string" && mark.key.startsWith(`${LOG}#`);
    });

  test.each([true, false])("gets a store record of its own (identity marker: %p)", (marker) => {
    const { a, vaultB } = switchedForA(marker);
    // Both vaults hold the same first log row at the same relative path.
    expect(readFileSync(join(vaultB, ...LOG.split("/")), "utf8")).toBe(
      readFileSync(join(a.vault, ...LOG.split("/")), "utf8"),
    );
    expect(imported(a)).toHaveLength(1);
    const outcome = migrateStore(vaultB, FAST);
    expect(outcome.mode).toBe("transition");
    const records = imported(a);
    expect(records).toHaveLength(2);
    if (marker) {
      expect(new Set(records.map((r) => r.body["vault_id"])).size).toBe(2);
    }
    // A second run of either vault imports nothing more.
    migrateStore(vaultB, FAST);
    migrateStore(a.vault, FAST);
    expect(imported(a)).toHaveLength(2);
  });
});

describe("a rollback of vault A after vault B imported an identical row", () => {
  test.each([true, false])(
    "writes B's occurrence back beside A's (identity marker: %p)",
    (marker) => {
      const { a, vaultB } = switchedForA(marker);
      expect(migrateStore(vaultB, FAST).mode).toBe("transition");
      rollback(a.vault);
      // A's row is restored from its snapshot; B's separate occurrence of the
      // same row is replayed into this device's shard of the day.
      expect(rowsOfDay(a.vault, "2026-10-01")).toBe(2);
    },
  );
});

/** How many legacy log rows of `day` the vault holds, over every shard of the day. */
function rowsOfDay(vault: string, day: string): number {
  const dir = join(vault, "Brain", "log");
  return readdirSync(dir)
    .filter((name) => name.startsWith(day) && name.endsWith(".jsonl"))
    .flatMap((name) => readFileSync(join(dir, name), "utf8").split("\n"))
    .filter((line) => line.includes('"text":"x"')).length;
}

describe("a dual-written copy of an item vault B also holds", () => {
  const LOG = "Brain/log/2026-10-01.jsonl";
  const STORE_ONLY = ["vault_id", "legacy_device", "migrated"];

  /** A's imported record of the shared log row, its partition and its shard dir. */
  function sharedRow(a: Machine): { record: StoreRecord; partition: string; stream: string } {
    for (const partition of ["shared", "private"]) {
      for (const shard of readPartition(join(a.storeRoot, partition))) {
        const record = shard.all.find(
          (r) => (r.body["migrated"] as { key?: string } | undefined)?.key === `${LOG}#1`,
        );
        if (record !== undefined) return { record, partition, stream: shard.stream };
      }
    }
    throw new Error("A's log row is not in the store");
  }

  /**
   * Plant a copy of the row as a dual write left it: `device`'s bytes,
   * stamped before every record A's migration wrote (so not native), with
   * `vaultId` as its vault.
   */
  function plantCopy(a: Machine, device: string, vaultId: string | null): void {
    const { record, partition, stream } = sharedRow(a);
    const body: Record<string, unknown> = { ...record.body };
    for (const field of STORE_ONLY) delete body[field];
    if (vaultId !== null) body["vault_id"] = vaultId;
    const copy = buildRecord({
      hlc: { physical: Date.UTC(2026, 0, 1), counter: 0 },
      device,
      agent: record.agent,
      kind: record.kind,
      scope: record.scope,
      topic: null,
      body,
    });
    const dir = join(a.storeRoot, partition, stream, device);
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "2026-01.jsonl"), `${JSON.stringify(copy)}\n`);
  }

  /** The records of B's own import of the shared row: marked with B's vault. */
  function importedForB(a: Machine, vaultB: string): StoreRecord[] {
    const pathSum = createHash("sha256").update(realpathSync(vaultB)).digest("hex");
    return a.records().filter((r) => {
      const mark = r.body["migrated"] as
        | { key?: string; vault?: { path_sum?: string } }
        | undefined;
      return mark?.key === `${LOG}#1` && mark.vault?.path_sum === pathSum;
    });
  }

  const cases: ReadonlyArray<[string, string, "a" | null]> = [
    ["another device, no vault", "dev-x", null],
    ["another device, vault A's marker", "dev-x", "a"],
    ["this device, no vault (A is the vault it migrated)", "dev-a", null],
    ["this device, vault A's marker", "dev-a", "a"],
  ];
  test.each(cases)("from %s is no import of B's item", (_label, device, vault) => {
    const { a, vaultB } = switchedForA(true);
    const markerA = readVaultIdentity(a.vault)!.vault_id;
    plantCopy(a, device, vault === "a" ? markerA : null);
    expect(migrateStore(vaultB, FAST).mode).toBe("transition");
    expect(importedForB(a, vaultB)).toHaveLength(1);
  });

  test("dual-written from vault B itself, it stands in for B's item", () => {
    const { a, vaultB } = switchedForA(true);
    plantCopy(a, "dev-a", readVaultIdentity(vaultB)!.vault_id);
    expect(migrateStore(vaultB, FAST).mode).toBe("transition");
    expect(importedForB(a, vaultB)).toHaveLength(0);
  });

  test("dual-written from vault B, a rollback of A writes it back beside A's row", () => {
    const { a, vaultB } = switchedForA(true);
    plantCopy(a, "dev-a", readVaultIdentity(vaultB)!.vault_id);
    expect(migrateStore(vaultB, FAST).mode).toBe("transition");
    rollback(a.vault);
    expect(rowsOfDay(a.vault, "2026-10-01")).toBe(2);
  });

  test.each(cases)("from %s, a rollback of A counts it as A's row", (_label, device, vault) => {
    const { a } = switchedForA(true);
    const markerA = readVaultIdentity(a.vault)!.vault_id;
    plantCopy(a, device, vault === "a" ? markerA : null);
    rollback(a.vault);
    expect(rowsOfDay(a.vault, "2026-10-01")).toBe(1);
  });
});
