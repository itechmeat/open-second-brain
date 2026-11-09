/**
 * A switched machine whose store cannot be opened (design D14, fail
 * closed): `store.json` missing or corrupt, or the `shared` partition no
 * longer shown. Every protection reader treats that as unknown, never as
 * "no store, no rules"; a machine that never switched still reads "no
 * store" plainly.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { listAttestationRecordFiles } from "../../../src/core/brain/attestation/record.ts";
import { queryDecisionLedger } from "../../../src/core/brain/permissions/ledger.ts";
import { removeStoreSignal } from "../../../src/core/brain/signal-state.ts";
import { writeSignal } from "../../../src/core/brain/signal.ts";
import { laneStoreFold } from "../../../src/core/store/lane-fold-cache.ts";
import {
  protectionStore,
  StoreUnavailableError,
} from "../../../src/core/store/read/protection-store.ts";
import { isStoreOnly } from "../../../src/core/store/store-only.ts";
import { StoreWriteError } from "../../../src/core/store/store-write.ts";
import { switchDevice } from "../brain/store-only/fixtures.ts";
import { makeStoreEnv, type StoreEnv } from "./fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

function identity(e: StoreEnv, partition: "shared" | "private"): string {
  return join(e.storeRoot, partition, "store.json");
}

/** A machine switched to its store, with the sticky marker recorded. */
function switched(prefix: string): StoreEnv {
  const e = makeStoreEnv(prefix, { dualWrite: false });
  switchDevice(e.storeRoot);
  expect(isStoreOnly({ vault: e.vault })).toBe(true);
  return e;
}

function noStore(e: StoreEnv): void {
  rmSync(identity(e, "shared"));
  rmSync(identity(e, "private"));
}

describe("protectionStore", () => {
  test("a machine that never switched: no store is no store", () => {
    env = makeStoreEnv("osb-protect-store-legacy-");
    noStore(env);
    expect(protectionStore()).toBeNull();
  });

  test("a switched machine: a missing, a corrupt store or a missing shared partition throws", () => {
    env = switched("osb-protect-store-switched-");
    expect(protectionStore()?.partitions.has("shared")).toBe(true);
    rmSync(identity(env, "shared"));
    // `shared` was held here, so its loss alone makes the store unavailable.
    expect(() => protectionStore()).toThrow(StoreUnavailableError);
    expect(() => protectionStore(undefined, { needShared: true })).toThrow(StoreUnavailableError);
    writeFileSync(identity(env, "shared"), "{ not json");
    expect(() => protectionStore()).toThrow(StoreUnavailableError);
    rmSync(identity(env, "shared"));
    rmSync(identity(env, "private"));
    expect(() => protectionStore()).toThrow(/no longer show store\.json/);
  });
});

describe("a partition this machine has held lost its identity file", () => {
  test("a switched machine: the store is unavailable, the partition named", () => {
    env = switched("osb-protect-held-lost-");
    rmSync(identity(env, "private"));
    expect(() => protectionStore()).toThrow(/private partition .* no longer shows store\.json/);
    expect(laneStoreFold().unreadable).toHaveLength(1);
  });

  test("a machine with no legacy tree fails closed too, without a switch marker", () => {
    env = makeStoreEnv("osb-protect-held-fresh-", { legacyTree: false, dualWrite: false });
    expect(isStoreOnly({ vault: env.vault })).toBe(true);
    rmSync(identity(env, "private"));
    expect(() => protectionStore()).toThrow(StoreUnavailableError);
  });

  test("a machine that still writes its legacy tree reads no store, as for any it cannot open", () => {
    env = makeStoreEnv("osb-protect-held-legacy-");
    rmSync(identity(env, "private"));
    expect(protectionStore()).toBeNull();
  });

  test("a switched machine that never held private keeps working as shared-only", () => {
    env = makeStoreEnv("osb-protect-shared-only-", { dualWrite: false, partitions: ["shared"] });
    switchDevice(env.storeRoot);
    expect([...protectionStore(undefined, { needShared: true })!.partitions]).toEqual(["shared"]);
    expect(laneStoreFold().unreadable).toEqual([]);
  });
});

describe("protection readers on a switched machine whose store cannot be opened", () => {
  test("the lane fold lists the store as unseen, so lane privacy fails closed", () => {
    env = switched("osb-protect-lanes-");
    expect(laneStoreFold().unreadable).toEqual([]);
    noStore(env);
    expect(laneStoreFold().unreadable).toHaveLength(1);
  });

  test("forgetting a signal refuses instead of answering that there is none", () => {
    env = switched("osb-protect-forget-");
    const { id } = writeSignal(env.vault, {
      topic: "forget-me",
      signal: "positive",
      agent: "claude",
      principle: "Principle of forget-me",
      created_at: "2026-11-06T10:00:00Z",
      date: "2026-11-06",
      slug: "forget-me",
    });
    noStore(env);
    expect(() => removeStoreSignal(env!.vault, id)).toThrow(StoreWriteError);
  });

  test("the decision ledger refuses to read as empty", () => {
    env = switched("osb-protect-ledger-");
    expect(queryDecisionLedger(env.vault)).toEqual([]);
    noStore(env);
    expect(() => queryDecisionLedger(env!.vault)).toThrow(/permissions ledger cannot be read/);
  });

  test("attestations list an entry that refuses, never none", () => {
    env = switched("osb-protect-attest-");
    expect(listAttestationRecordFiles(env.vault)).toEqual([]);
    noStore(env);
    const entries = listAttestationRecordFiles(env.vault);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.unreadable).toContain("switched to the brain store");
  });
});
