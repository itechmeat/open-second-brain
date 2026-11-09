/**
 * The migration journal keys an import by the vault it came from
 * (`journal-scope.ts`): records and journal rows written before the vault
 * was recorded keep matching for the first vault this machine migrated
 * and never match another vault.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { sha256Hex } from "../../../src/core/integrity/digest.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { openStore, type StoreHandle } from "../../../src/core/store/store-open.ts";
import { journalGet, loadJournal } from "../../../src/core/store-migration/journal.ts";
import {
  dualWriteFromVault,
  journalScope,
  type VaultByPath,
} from "../../../src/core/store-migration/journal-scope.ts";
import { makeTestStore, type TestStore } from "../../helpers/test-store.ts";

const A: VaultByPath = { vault_id: null, path: "/vaults/a" };
const B: VaultByPath = { vault_id: null, path: "/vaults/b" };
const KEY = "Brain/log/2026-10-01.jsonl#1";
const SUM = "c".repeat(64);

let scratch: TestStore;
let store: StoreHandle;
let dir: string;
beforeEach(() => {
  scratch = makeTestStore("osb-journal-scope-");
  store = openStore({ root: scratch.root, device: "dev-a" });
  dir = join(scratch.root, "migration-dir");
  mkdirSync(dir, { recursive: true });
});
afterEach(() => scratch.cleanup());

function importedBefore(vaultId: string | null, device = "dev-a"): string {
  const handle = device === store.device ? store : openStore({ root: scratch.root, device });
  return appendRecord(handle, {
    partition: "shared",
    stream: "events",
    kind: "log-event",
    agent: "t",
    // A mark written before the vault was recorded: no `vault` in it.
    body: {
      vault_id: vaultId,
      migrated: { key: KEY, sum: SUM, part: 0, parts: 1 },
    },
  }).record.id;
}

describe("a mark that names no vault", () => {
  test("matches the vault this machine migrated, and not another one", () => {
    const id = importedBefore(null);
    expect(journalGet(loadJournal(dir, store, journalScope(A, A, "dev-a")), KEY, SUM)?.ids).toEqual(
      [id],
    );
    expect(journalGet(loadJournal(dir, store, journalScope(B, A, "dev-a")), KEY, SUM)).toBe(
      undefined,
    );
  });

  test("before this machine took a backup it matches the vault the run imports", () => {
    const id = importedBefore(null);
    expect(
      journalGet(loadJournal(dir, store, journalScope(A, null, "dev-a")), KEY, SUM)?.ids,
    ).toEqual([id]);
  });

  test("written by another device it matches no vault here", () => {
    importedBefore(null, "dev-b");
    expect(journalGet(loadJournal(dir, store, journalScope(A, null, "dev-a")), KEY, SUM)).toBe(
      undefined,
    );
    expect(journalGet(loadJournal(dir, store, journalScope(A, A, "dev-a")), KEY, SUM)).toBe(
      undefined,
    );
  });

  test("whose record names a vault id matches only the vault with that marker", () => {
    importedBefore("vault-a");
    const markedA = { vault_id: "vault-a", path: "/elsewhere/a" };
    const markedB = { vault_id: "vault-b", path: "/vaults/a" };
    expect(
      journalGet(loadJournal(dir, store, journalScope(markedA, A, "dev-a")), KEY, SUM),
    ).not.toBe(undefined);
    expect(journalGet(loadJournal(dir, store, journalScope(markedB, A, "dev-a")), KEY, SUM)).toBe(
      undefined,
    );
  });
});

/** A record whose mark names its vault by `vault`, written on `device`. */
function importedWith(vault: { vault_id: string | null; path: string }, device: string): string {
  const handle = device === store.device ? store : openStore({ root: scratch.root, device });
  const named = { vault_id: vault.vault_id, path_sum: sha256Hex(vault.path) };
  return appendRecord(handle, {
    partition: "shared",
    stream: "events",
    kind: "log-event",
    agent: "t",
    body: {
      vault_id: vault.vault_id,
      migrated: { key: KEY, sum: SUM, part: 0, parts: 1, vault: named },
    },
  }).record.id;
}

describe("a mark that names its vault by path alone", () => {
  test("matches the vault at that path on the device that wrote it", () => {
    const id = importedWith(A, "dev-a");
    expect(journalGet(loadJournal(dir, store, journalScope(A, A, "dev-a")), KEY, SUM)?.ids).toEqual(
      [id],
    );
    // The same vault with a marker it was given since still matches by path.
    const markedA = { vault_id: "vault-a", path: A.path };
    expect(
      journalGet(loadJournal(dir, store, journalScope(markedA, A, "dev-a")), KEY, SUM)?.ids,
    ).toEqual([id]);
    expect(journalGet(loadJournal(dir, store, journalScope(B, A, "dev-a")), KEY, SUM)).toBe(
      undefined,
    );
  });

  test("written by another device matches no vault here, not even at the same path", () => {
    importedWith(A, "dev-b");
    for (const migrated of [null, A]) {
      expect(
        journalGet(loadJournal(dir, store, journalScope(A, migrated, "dev-a")), KEY, SUM),
      ).toBe(undefined);
    }
  });
});

describe("a mark that names its vault by marker", () => {
  test("from another device matches the vault with that marker, never a path", () => {
    const id = importedWith({ vault_id: "vault-a", path: A.path }, "dev-b");
    const markedA = { vault_id: "vault-a", path: "/elsewhere/a" };
    expect(
      journalGet(loadJournal(dir, store, journalScope(markedA, null, "dev-a")), KEY, SUM)?.ids,
    ).toEqual([id]);
    // A vault without a marker at the same path is not that vault.
    expect(journalGet(loadJournal(dir, store, journalScope(A, null, "dev-a")), KEY, SUM)).toBe(
      undefined,
    );
  });
});

describe("a journal row on disk that names no vault", () => {
  test("matches the vault this machine migrated, and not another one", () => {
    writeFileSync(
      join(dir, "journal.jsonl"),
      `${JSON.stringify({ key: KEY, sum: SUM, ids: ["r1"], sums: ["s1"], partition: "shared" })}\n`,
    );
    expect(journalGet(loadJournal(dir, store, journalScope(A, A, "dev-a")), KEY, SUM)?.ids).toEqual(
      ["r1"],
    );
    expect(journalGet(loadJournal(dir, store, journalScope(B, A, "dev-a")), KEY, SUM)).toBe(
      undefined,
    );
  });
});

describe("a dual-written copy (no migrated mark)", () => {
  const copy = (device: string, vaultId?: string) => ({
    device,
    body: vaultId === undefined ? {} : { vault_id: vaultId },
  });
  const MARKED_A: VaultByPath = { vault_id: "vid-a", path: "/vaults/a" };
  const MARKED_B: VaultByPath = { vault_id: "vid-b", path: "/vaults/b" };

  test("with a vault id counts only for the vault with that marker, from any device", () => {
    const forA = journalScope(MARKED_A, MARKED_A, "dev-a");
    expect(dualWriteFromVault(forA, copy("dev-x", "vid-a"))).toBe(true);
    expect(dualWriteFromVault(forA, copy("dev-a", "vid-b"))).toBe(false);
    // A vault without a marker is no vault with one.
    expect(dualWriteFromVault(journalScope(A, A, "dev-a"), copy("dev-a", "vid-a"))).toBe(false);
  });

  test("without one counts only on its device, for the vault that device migrated", () => {
    // Before this machine took a backup the run's vault is the one it migrates.
    expect(dualWriteFromVault(journalScope(A, null, "dev-a"), copy("dev-a"))).toBe(true);
    expect(dualWriteFromVault(journalScope(MARKED_B, MARKED_A, "dev-a"), copy("dev-a"))).toBe(
      false,
    );
    expect(dualWriteFromVault(journalScope(B, A, "dev-a"), copy("dev-a"))).toBe(false);
    expect(dualWriteFromVault(journalScope(A, A, "dev-a"), copy("dev-x"))).toBe(false);
  });
});
