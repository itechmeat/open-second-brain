/**
 * `appendAuditRecord` on a machine switched to the brain store (task 2.10,
 * design D14 item 1): a trail inside the vault becomes one
 * `reliability-audit` ledger row and no byte under the vault; a trail that
 * already lives in the device-local state stays a file there; when the
 * store write fails, the hook trail fails open with an empty path and any
 * other trail throws `StoreWriteError`. The unswitched cases live in
 * `tests/core/reliability.test.ts`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  AUDIT_STORE_LEDGER_NAME,
  appendAuditRecord,
  type AuditRecord,
} from "../../../src/core/reliability/audit.ts";
import { machineStateRoot } from "../../../src/core/state/machine-state.ts";
import { isStoreOnly } from "../../../src/core/store/store-only.ts";
import { StoreWriteError } from "../../../src/core/store/store-write.ts";
import { digestVaultTree } from "../../helpers/vault-digest.ts";
import { ledgerRows, switchDevice } from "../brain/store-only/fixtures.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv;

beforeEach(() => {
  env = makeStoreEnv("osb-audit-store-only-");
  switchDevice(env.storeRoot);
});

afterEach(() => env.cleanup());

const RECORD: AuditRecord = {
  timestamp: "2026-11-06T12:00:00.000Z",
  actor: "test",
  action: "probe",
  target: "notes/x.md",
  ok: true,
} as AuditRecord;

function auditRows(): unknown[] {
  return [
    ...ledgerRows(env.storeRoot, "shared", "reliability-audit"),
    ...ledgerRows(env.storeRoot, "private", "reliability-audit"),
  ];
}

describe("the reliability audit on a switched machine", () => {
  test("a trail inside the vault is one store row and no byte under the vault", () => {
    const before = digestVaultTree(env.vault);
    const path = appendAuditRecord(
      join(env.vault, ".open-second-brain", "audit"),
      RECORD,
      env.vault,
    );
    // The ledger's name, never the device path of a store shard.
    expect(path).toBe(AUDIT_STORE_LEDGER_NAME);
    expect(auditRows()).toHaveLength(1);
    expect(digestVaultTree(env.vault)).toBe(before);
  });

  test("a device-local trail stays a file in the device-local state", () => {
    const root = join(machineStateRoot(env.vault), "hook-audit-probe");
    const path = appendAuditRecord(root, RECORD, env.vault);
    expect(path.startsWith(root)).toBe(true);
    expect(readdirSync(root).length).toBe(1);
    expect(auditRows()).toEqual([]);
  });

  test("a failed store write: fail-open returns an empty path, otherwise it throws", () => {
    // A run on this machine has seen its switch (a switch is sticky)...
    expect(isStoreOnly({ vault: env.vault })).toBe(true);
    const before = digestVaultTree(env.vault);
    // ...and then the store has gone (unsynced, unmounted).
    rmSync(env.storeRoot, { recursive: true, force: true });
    const trail = join(env.vault, ".open-second-brain", "audit");
    expect(appendAuditRecord(trail, RECORD, env.vault, { failOpen: true })).toBe("");
    expect(() => appendAuditRecord(trail, RECORD, env.vault)).toThrow(StoreWriteError);
    expect(digestVaultTree(env.vault)).toBe(before);
    expect(existsSync(env.storeRoot)).toBe(false);
  });
});
