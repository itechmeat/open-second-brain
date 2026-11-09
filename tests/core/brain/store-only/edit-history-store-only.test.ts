/**
 * The `edit-history` ledger on a store-only machine (task 2.10, design
 * D14 items 1 and 13), like the other dual-written ledgers: a switched
 * machine appends `ledger-row` records only, writes no byte under the
 * vault, dedups against the store rows, and the vault identity guard
 * gives way to the store identity check. Unswitched, the sidecar shard
 * and the guard stay.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  appendEditHistory,
  readEditHistory,
  type EditHistoryEntry,
} from "../../../../src/core/brain/health/edit-history.ts";
import { preferenceHistoryPath } from "../../../../src/core/brain/paths.ts";
import { resetVaultIdentityPins } from "../../../../src/core/brain/vault-identity.ts";
import { makeStoreEnv, type StoreEnv } from "../../store/fixtures/store-env.ts";
import { brainTreeDigest, ledgerRows, switchDevice } from "./fixtures.ts";

let env: StoreEnv | undefined;

afterEach(() => {
  env?.cleanup();
  env = undefined;
  resetVaultIdentityPins();
});

const ENTRY: EditHistoryEntry = {
  ts: "2026-11-06T10:00:00Z",
  agent: "claude",
  revision: 2,
  field: "principle",
  before: "old",
  after: "new",
};

/** Write a vault identity marker with `id`. */
function markVault(vault: string, id: string): void {
  writeFileSync(
    join(vault, "Brain", "vault-id.json"),
    `${JSON.stringify({ vault_id: id, created_at: "2026-11-01T00:00:00Z" })}\n`,
  );
}

function rows(e: StoreEnv): unknown[] {
  return [
    ...ledgerRows(e.storeRoot, "shared", "edit-history"),
    ...ledgerRows(e.storeRoot, "private", "edit-history"),
  ];
}

describe("edit history once switched", () => {
  test("appends one row, dedups against the store and leaves the vault alone", () => {
    env = makeStoreEnv("osb-wp7a-edit-history-", { dualWrite: false });
    switchDevice(env.storeRoot);
    const before = brainTreeDigest(env.vault);
    expect(appendEditHistory(env.vault, "alpha", [ENTRY])).toBe(1);
    expect(appendEditHistory(env.vault, "alpha", [ENTRY, ENTRY])).toBe(0);
    expect(rows(env)).toEqual([{ slug: "alpha", entry: ENTRY }]);
    expect(readEditHistory(env.vault, "alpha")).toEqual([ENTRY]);
    expect(readEditHistory(env.vault, "beta")).toEqual([]);
    expect(existsSync(preferenceHistoryPath(env.vault, "alpha"))).toBe(false);
    expect(brainTreeDigest(env.vault)).toBe(before);
  });

  test("the vault identity guard does not run: a changed vault marker refuses nothing", () => {
    env = makeStoreEnv("osb-wp7a-edit-history-guard-", { dualWrite: false });
    switchDevice(env.storeRoot);
    markVault(env.vault, "vault-a");
    expect(appendEditHistory(env.vault, "alpha", [ENTRY])).toBe(1);
    markVault(env.vault, "vault-b");
    expect(appendEditHistory(env.vault, "alpha", [{ ...ENTRY, revision: 3 }])).toBe(1);
    expect(rows(env)).toHaveLength(2);
  });
});

describe("edit history on an unswitched machine", () => {
  test("keeps the sidecar shard and the vault identity guard", () => {
    env = makeStoreEnv("osb-wp7a-edit-history-legacy-", { dualWrite: false });
    markVault(env.vault, "vault-a");
    expect(appendEditHistory(env.vault, "alpha", [ENTRY])).toBe(1);
    expect(existsSync(preferenceHistoryPath(env.vault, "alpha"))).toBe(true);
    expect(rows(env)).toEqual([]);
    markVault(env.vault, "vault-b");
    expect(() => appendEditHistory(env!.vault, "alpha", [{ ...ENTRY, revision: 3 }])).toThrow();
  });
});
