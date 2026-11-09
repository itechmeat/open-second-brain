/**
 * Two doctor checks of the store migration (task 2.12): another device's
 * entries in this machine's device-local state directory (it was synced),
 * and a migration this machine has not run yet. Each reports its case,
 * stays silent otherwise, and writes nothing.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import type { DoctorCheckContext, DoctorFindings } from "../../../src/core/brain/doctor/check.ts";
import {
  deviceStateCheck,
  STORE_DEVICE_STATE_FOREIGN_CODE,
} from "../../../src/core/brain/doctor/device-state-check.ts";
import {
  MIGRATION_AVAILABLE_CODE,
  migrationCheck,
} from "../../../src/core/brain/doctor/migration-check.ts";
import { resetVaultIdentityPins } from "../../../src/core/brain/vault-identity.ts";
import { bindVaultToStore } from "../../../src/core/vault-adapter/vault-binding.ts";
import { DEVICE_ID_ENV } from "../../../src/core/config.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { STORE_DUAL_WRITE_ENV, STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import { DEVICE_SWITCHED_KIND } from "../../../src/core/store/migration-availability.ts";
import { openStore, type StoreHandle } from "../../../src/core/store/store-open.ts";
import { defaultStoreRoot } from "../../../src/core/store/store-paths.ts";
import { ensureStore } from "../store/fixtures/temp-store.ts";
import { treeSnapshot } from "../../helpers/vault-digest.ts";

const ENV_KEYS = [
  STORE_DUAL_WRITE_ENV,
  STORE_ROOT_ENV,
  DEVICE_ID_ENV,
  "HOME",
  "XDG_STATE_HOME",
  "XDG_DATA_HOME",
  "LOCALAPPDATA",
] as const;
const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

let parent: string;
let vault: string;
let storeRoot: string;
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  parent = mkdtempSync(join(tmpdir(), "osb-doctor-store-migration-"));
  vault = join(parent, "vault");
  storeRoot = join(parent, "store");
  for (const d of ["preferences", "retired", "inbox", "processed", "log"]) {
    mkdirSync(join(vault, "Brain", d), { recursive: true });
  }
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  process.env["HOME"] = join(parent, "home");
  process.env["XDG_STATE_HOME"] = join(parent, "state");
  process.env["XDG_DATA_HOME"] = join(parent, "data");
  process.env["LOCALAPPDATA"] = join(parent, "state");
  process.env[STORE_ROOT_ENV] = storeRoot;
  process.env[DEVICE_ID_ENV] = "dev-a";
  delete process.env[STORE_DUAL_WRITE_ENV];
  resetVaultIdentityPins();
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  resetVaultIdentityPins();
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

function doctor(): ReturnType<typeof runDoctor> {
  return runDoctor(vault, { now: new Date(NOW) });
}

function findings(code: string) {
  const result = doctor();
  return [...result.warnings, ...(result.uncertain ?? [])].filter((issue) => issue.code === code);
}

/**
 * Open the store as `device` with THIS process's device-local state. For
 * any device but `dev-a` that is exactly what a synced-by-mistake state
 * directory looks like: another machine's clock and locks beside ours.
 */
function asDevice(device: string): StoreHandle {
  ensureStore(storeRoot);
  return openStore({ root: storeRoot, device });
}

function append(
  store: StoreHandle,
  input: {
    stream: "events" | "settings" | "ledgers";
    kind: string;
    ledger?: string;
    body?: Record<string, unknown>;
  },
): void {
  appendRecord(store, {
    partition: "shared",
    stream: input.stream,
    ...(input.ledger !== undefined ? { ledger: input.ledger } : {}),
    kind: input.kind,
    agent: "test",
    body: input.body ?? { n: 1 },
  });
}

describe("another device's entries in the device-local state", () => {
  test("reports every foreign device id, from clocks and shard locks, and says never to sync it", () => {
    append(asDevice("dev-a"), { stream: "events", kind: "note" });
    append(asDevice("dev-b"), { stream: "events", kind: "note" });
    append(asDevice("dev-c"), { stream: "ledgers", ledger: "audit", kind: "ledger-row" });
    const found = findings(STORE_DEVICE_STATE_FOREIGN_CODE);
    expect(found).toHaveLength(1);
    const message = found[0]!.message;
    expect(message).toContain("dev-b");
    expect(message).toContain("dev-c");
    // This device is named as the owner, never as a foreign entry.
    expect(message).toContain("(device dev-a)");
    expect(message).not.toContain("dev-a (");
    expect(message).not.toContain("clock/dev-a");
    expect(message).toContain("never be synced");
    expect(found[0]!.path).toBe(asDevice("dev-a").deviceStateDir);
  });

  test("silent when the state holds only this device's entries and store-wide ones", () => {
    const own = asDevice("dev-a");
    append(own, { stream: "events", kind: "note" });
    append(own, { stream: "ledgers", ledger: "audit", kind: "ledger-row" });
    mkdirSync(join(own.deviceStateDir, "index", "vault-key"), { recursive: true });
    mkdirSync(join(own.deviceStateDir, "tmp"), { recursive: true });
    expect(findings(STORE_DEVICE_STATE_FOREIGN_CODE)).toEqual([]);
  });

  test("silent when no store exists", () => {
    expect(findings(STORE_DEVICE_STATE_FOREIGN_CODE)).toEqual([]);
  });

  test("silent when this machine has no device id, since nothing tells its entries apart", () => {
    append(asDevice("dev-b"), { stream: "events", kind: "note" });
    process.env[DEVICE_ID_ENV] = "";
    expect(findings(STORE_DEVICE_STATE_FOREIGN_CODE)).toEqual([]);
  });
});

describe("an available migration", () => {
  // Something to move: one signal in the legacy inbox.
  beforeEach(() => {
    writeFileSync(join(vault, "Brain", "inbox", "2026-11-06-a.md"), "---\nid: sig-a\n---\n");
  });

  test("dual writes on and no store yet: names o2b store init, then the dry run", () => {
    process.env[STORE_DUAL_WRITE_ENV] = "1";
    const found = findings(MIGRATION_AVAILABLE_CODE);
    expect(found).toHaveLength(1);
    const message = found[0]!.message;
    expect(message).toContain("`o2b store init`");
    expect(message).toContain("`o2b brain migrate-store --dry-run`");
    expect(message.indexOf("o2b store init")).toBeLessThan(message.indexOf("migrate-store"));
    expect(found[0]!.path).toBe(join(vault, "Brain"));
  });

  test("a store without this device's switch: names only the dry run", () => {
    append(asDevice("dev-b"), { stream: "settings", kind: DEVICE_SWITCHED_KIND });
    const found = findings(MIGRATION_AVAILABLE_CODE);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("`o2b brain migrate-store --dry-run`");
    expect(found[0]!.message).not.toContain("o2b store init");
  });

  test("a store at the default root, with no root configured, shows it", () => {
    delete process.env[STORE_ROOT_ENV];
    ensureStore(defaultStoreRoot());
    const found = findings(MIGRATION_AVAILABLE_CODE);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).not.toContain("o2b store init");
  });

  test("reported on a legacy install that never opted into the store, as advice only", () => {
    const found = findings(MIGRATION_AVAILABLE_CODE);
    expect(found).toHaveLength(1);
    const result = doctor();
    expect(result.warnings.map((w) => w.code)).not.toContain(MIGRATION_AVAILABLE_CODE);
    expect(result.uncertain?.map((u) => u.code)).toContain(MIGRATION_AVAILABLE_CODE);
    delete process.env[STORE_ROOT_ENV];
    expect(findings(MIGRATION_AVAILABLE_CODE)).toHaveLength(1);
  });

  test("silent on a freshly bootstrapped tree, which holds nothing to move", () => {
    rmSync(join(vault, "Brain", "inbox", "2026-11-06-a.md"));
    mkdirSync(join(vault, "Brain", "bases"), { recursive: true });
    writeFileSync(join(vault, "Brain", "bases", "daily.base"), "views: []\n");
    writeFileSync(join(vault, "Brain", "_BRAIN.md"), "# Brain\n");
    expect(findings(MIGRATION_AVAILABLE_CODE)).toEqual([]);
  });

  test("silent once this device recorded its switch", () => {
    // The record the migration writes: human authority, naming the device.
    append(asDevice("dev-a"), {
      stream: "settings",
      kind: DEVICE_SWITCHED_KIND,
      body: { authority: "human", vault_id: null, device: "dev-a" },
    });
    // The migration binds the vault it switched with.
    bindVaultToStore(vault, { store: asDevice("dev-a") });
    expect(findings(MIGRATION_AVAILABLE_CODE)).toEqual([]);
  });

  test("a vault configured after the switch, never imported, is offered its import", () => {
    append(asDevice("dev-a"), {
      stream: "settings",
      kind: DEVICE_SWITCHED_KIND,
      body: { authority: "human", vault_id: null, device: "dev-a" },
    });
    const found = findings(MIGRATION_AVAILABLE_CODE);
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain("o2b brain migrate-store`");
  });
});

describe("both checks are read-only", () => {
  // The two checks run on their own here: other doctor checks resolve the
  // search index path, which records the store root in the device-local
  // state, and that write is theirs.
  test("reporting both findings writes nothing in the store, the state or the vault", () => {
    writeFileSync(join(vault, "Brain", "inbox", "2026-11-06-a.md"), "---\nid: sig-a\n---\n");
    append(asDevice("dev-a"), { stream: "events", kind: "note" });
    append(asDevice("dev-b"), { stream: "events", kind: "note" });
    const before = [storeRoot, join(parent, "state"), vault].map((root) => treeSnapshot(root));
    const ctx: DoctorCheckContext = {
      vault,
      now: new Date(NOW),
      config: undefined,
      dbPath: undefined,
      configPath: undefined,
      knownBasenames: new Set(),
      idIndex: new Map(),
      preferences: [],
      logs: [],
    };
    const out: DoctorFindings = { issues: [], uncertain: [] };
    deviceStateCheck.run(ctx, out);
    migrationCheck.run(ctx, out);
    expect(out.issues.map((issue) => issue.code)).toEqual([STORE_DEVICE_STATE_FOREIGN_CODE]);
    expect(out.uncertain.map((entry) => entry.code)).toEqual([MIGRATION_AVAILABLE_CODE]);
    expect([storeRoot, join(parent, "state"), vault].map((root) => treeSnapshot(root))).toEqual(
      before,
    );
  });
});
