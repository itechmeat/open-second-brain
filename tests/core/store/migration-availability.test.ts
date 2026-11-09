/**
 * Whether this machine has a migration to run (design D11, D14.1, task
 * 2.12): a legacy `Brain/` tree in the vault, and no `device-switched`
 * record of this device in the store. Read by both the status block and
 * the doctor, so the two never disagree.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEVICE_ID_ENV } from "../../../src/core/config.ts";
import {
  deviceSwitchedBody,
  MIGRATION_STREAM,
} from "../../../src/core/store-migration/migration-records.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { isStoreOnly } from "../../../src/core/store/store-only.ts";
import { STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import {
  DEVICE_SWITCHED_KIND,
  MIGRATE_STORE_DRY_RUN_COMMAND,
  migrationAvailability,
  STORE_INIT_COMMAND,
} from "../../../src/core/store/migration-availability.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import {
  bindVaultToStore,
  vaultBindingPath,
} from "../../../src/core/vault-adapter/vault-binding.ts";
import { ensureStore } from "./fixtures/temp-store.ts";
import { treeSnapshot } from "../../helpers/vault-digest.ts";

const ENV_KEYS = [STORE_ROOT_ENV, DEVICE_ID_ENV, "XDG_STATE_HOME", "LOCALAPPDATA"] as const;
const saved = new Map<string, string | undefined>();

let parent: string;
let vault: string;
let root: string;
let configPath: string;

beforeEach(() => {
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  parent = mkdtempSync(join(tmpdir(), "osb-migration-available-"));
  vault = join(parent, "vault");
  root = join(parent, "store");
  configPath = join(parent, "config.yaml");
  mkdirSync(vault, { recursive: true });
  writeFileSync(configPath, `vault: ${vault}\n`);
  process.env[STORE_ROOT_ENV] = root;
  process.env[DEVICE_ID_ENV] = "dev-a";
  process.env["XDG_STATE_HOME"] = join(parent, "state");
  process.env["LOCALAPPDATA"] = join(parent, "state");
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** A legacy tree with something to move: one signal in the inbox. */
function legacyTree(): void {
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  writeFileSync(join(vault, "Brain", "inbox", "2026-11-06-a.md"), "---\nid: sig-a\n---\n");
}

function recordAs(device: string, kind: string, body?: Record<string, unknown>): void {
  ensureStore(root);
  const store = openStore({
    root,
    device,
    dirs: {
      platform: process.platform,
      home: join(parent, "home", device),
      env: {
        XDG_STATE_HOME: join(parent, "machines", device),
        LOCALAPPDATA: join(parent, "machines", device),
      },
    },
  });
  appendRecord(store, {
    partition: "shared",
    stream: MIGRATION_STREAM,
    kind,
    agent: "test",
    // A switch record is the one the migration writes (human authority).
    body: body ?? (kind === DEVICE_SWITCHED_KIND ? deviceSwitchedBody(null, device) : { device }),
  });
}

const check = () => migrationAvailability({ vault, configPath });

describe("migration availability", () => {
  test("a freshly bootstrapped tree holds nothing to move: nothing to migrate", () => {
    mkdirSync(join(vault, "Brain", "bases"), { recursive: true });
    writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
    writeFileSync(join(vault, "Brain", "bases", "daily.base"), "views: []\n");
    const result = check();
    expect(result.legacyTreePresent).toBe(true);
    expect(result.legacyDataPresent).toBe(false);
    expect(result.available).toBe(false);
    expect(result.nextCommands).toEqual([]);
  });

  test("no legacy tree: nothing to migrate", () => {
    const result = check();
    expect(result.available).toBe(false);
    expect(result.legacyTreePresent).toBe(false);
    expect(result.nextCommands).toEqual([]);
  });

  test("no vault at all: nothing to migrate", () => {
    const result = migrationAvailability({ vault: null, configPath });
    expect(result.available).toBe(false);
    expect(result.legacyTreePresent).toBe(false);
  });

  test("a legacy tree and no store: create the store, then dry-run the migration", () => {
    legacyTree();
    const result = check();
    expect(result.available).toBe(true);
    expect(result.legacyTreePresent).toBe(true);
    expect(result.storeExists).toBe(false);
    expect(result.switched).toBe(false);
    expect(result.nextCommands).toEqual([STORE_INIT_COMMAND, MIGRATE_STORE_DRY_RUN_COMMAND]);
  });

  test("a legacy tree and a store without this device's switch: dry-run the migration", () => {
    legacyTree();
    ensureStore(root);
    const result = check();
    expect(result.available).toBe(true);
    expect(result.storeExists).toBe(true);
    expect(result.nextCommands).toEqual([MIGRATE_STORE_DRY_RUN_COMMAND]);
  });

  test("another device's switch does not switch this one", () => {
    legacyTree();
    recordAs("dev-b", DEVICE_SWITCHED_KIND);
    recordAs("dev-a", "setting-set");
    const result = check();
    expect(result.available).toBe(true);
    expect(result.switched).toBe(false);
  });

  test("this device's own device-switched record: no migration to offer", () => {
    legacyTree();
    recordAs("dev-a", DEVICE_SWITCHED_KIND);
    // The migration binds the vault it switched with.
    bindVaultToStore(vault, { configPath });
    const result = check();
    expect(result.available).toBe(false);
    expect(result.legacyTreePresent).toBe(true);
    expect(result.switched).toBe(true);
    expect(result.nextCommands).toEqual([]);
    // The writers' own reader agrees: this machine is store-only.
    expect(isStoreOnly({ vault, configPath })).toBe(true);
  });

  test("a vault with legacy data configured after the switch is offered, and bound once imported", () => {
    // Switched with no vault (or another one); this vault was never bound.
    recordAs("dev-a", DEVICE_SWITCHED_KIND);
    legacyTree();
    const before = check();
    expect(before.switched).toBe(true);
    expect(before.available).toBe(true);
    expect(before.nextCommands).toEqual(["o2b brain migrate-store"]);
    bindVaultToStore(vault, { configPath });
    expect(check().available).toBe(false);
  });

  test("a damaged binding file is reported, and no migration is offered over it", () => {
    legacyTree();
    recordAs("dev-a", DEVICE_SWITCHED_KIND);
    bindVaultToStore(vault, { configPath });
    writeFileSync(vaultBindingPath(), "{ damaged");
    const result = check();
    expect(result.error).toContain("cannot be read");
    expect(result.nextCommands).toEqual([]);
  });

  test("a switch record without human authority switches nothing, as the writers read it", () => {
    legacyTree();
    recordAs("dev-a", DEVICE_SWITCHED_KIND, { device: "dev-a" });
    const result = check();
    expect(result.switched).toBe(false);
    expect(result.available).toBe(true);
    expect(isStoreOnly({ vault, configPath })).toBe(false);
  });

  test("no device id: the machine cannot have switched, so the migration is offered", () => {
    legacyTree();
    recordAs("dev-a", DEVICE_SWITCHED_KIND);
    process.env[DEVICE_ID_ENV] = "";
    expect(check().available).toBe(true);
  });

  test("a store root inside the vault is carried as the reason, not thrown", () => {
    legacyTree();
    process.env[STORE_ROOT_ENV] = join(vault, "store");
    const result = check();
    expect(result.available).toBe(true);
    expect(result.error).toContain("inside");
  });

  test("never writes anything, with or without a store", () => {
    legacyTree();
    let before = treeSnapshot(parent);
    check();
    expect(treeSnapshot(parent)).toEqual(before);

    recordAs("dev-b", DEVICE_SWITCHED_KIND);
    before = treeSnapshot(parent);
    check();
    expect(treeSnapshot(parent)).toEqual(before);
  });
});
