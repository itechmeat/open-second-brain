/**
 * The shared namespace and the brain store (task 3.12, design D19 item 3):
 * the namespace gets no store of its own. Where it is store-only on this
 * machine it is this machine's brain store, the one every store-only agent
 * of every machine of the store reads. So the mirror writes there when the
 * origin record is not in that store already (the origin vault still
 * writes the legacy layout and dual writes are off), and refuses when it
 * is (a switched machine, a store-only origin, dual writes on) or when
 * there is no store at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { writeSignal } from "../../../src/core/brain/signal.ts";
import {
  MIRROR_OUTCOME,
  mirrorNote,
  mirrorSignal,
} from "../../../src/core/brain/shared-namespace.ts";
import { LOG_EVENT_KIND, SIGNAL_KIND } from "../../../src/core/store/constants.ts";
import type { StoreRecord } from "../../../src/core/store/envelope.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { partitionRecords, switchDevice } from "./store-only/fixtures.ts";
import { sync, twoMachines, use } from "./store-only/two-machines.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const SIGNAL = {
  topic: "mirror-topic",
  signal: "positive" as const,
  agent: "coding-agent",
  principle: "Mirrored facts stay attributed.",
  created_at: "2026-11-15T10:00:00Z",
  date: "2026-11-15",
  slug: "mirror-topic",
};

/** A shared namespace folder with no legacy tree: store-only on this machine. */
function storeOnlyNamespace(e: StoreEnv): string {
  const shared = join(e.parent, "shared-namespace");
  mkdirSync(shared, { recursive: true });
  return shared;
}

const storeRecords = (e: StoreEnv): StoreRecord[] => [
  ...partitionRecords(e.storeRoot, "shared"),
  ...partitionRecords(e.storeRoot, "private"),
];

const mirrored = (e: StoreEnv, kind: string) =>
  storeRecords(e).filter((r) => r.kind === kind && JSON.stringify(r.body).includes("origin_vault"));

describe("a store-only shared namespace on an unswitched machine", () => {
  test("receives the mirror in this machine's store when the origin wrote the legacy layout", () => {
    env = makeStoreEnv("osb-shared-ns-store-", { dualWrite: false });
    const shared = storeOnlyNamespace(env);
    // The origin write goes to the origin vault's legacy tree only.
    writeSignal(env.vault, SIGNAL);
    expect(storeRecords(env).filter((r) => r.kind === SIGNAL_KIND)).toHaveLength(0);

    expect(mirrorSignal(shared, env.vault, SIGNAL)).toEqual({ outcome: MIRROR_OUTCOME.ok });
    expect(mirrorNote(shared, env.vault, { text: "shared fact", agent: "a" })).toEqual({
      outcome: MIRROR_OUTCOME.ok,
    });
    const [signal] = mirrored(env, SIGNAL_KIND);
    expect(JSON.stringify(signal?.body)).toContain('"origin_vault":"vault"');
    expect(mirrored(env, LOG_EVENT_KIND)).toHaveLength(1);
    // Nothing lands in the namespace folder itself.
    expect(readdirSync(shared)).toEqual([]);
  });

  test("with dual writes on, the origin record reaches the store once and the mirror adds none", () => {
    env = makeStoreEnv("osb-shared-ns-dual-", { dualWrite: true });
    const shared = storeOnlyNamespace(env);
    writeSignal(env.vault, SIGNAL);
    const report = mirrorSignal(shared, env.vault, SIGNAL);
    expect(report.outcome).toBe(MIRROR_OUTCOME.misconfigured);
    expect(storeRecords(env).filter((r) => r.kind === SIGNAL_KIND)).toHaveLength(1);
    expect(mirrored(env, SIGNAL_KIND)).toHaveLength(0);
  });

  test("refuses when this machine has no store to write into, and says how to make one", () => {
    env = makeStoreEnv("osb-shared-ns-nostore-", { dualWrite: false, partitions: [] });
    const shared = storeOnlyNamespace(env);
    const report = mirrorSignal(shared, env.vault, SIGNAL);
    expect(report.outcome).toBe(MIRROR_OUTCOME.misconfigured);
    expect(report.reason).toContain("o2b store init");
    expect(readdirSync(shared)).toEqual([]);
  });

  test("refuses for an origin vault that is store-only too, before any switch", () => {
    env = makeStoreEnv("osb-shared-ns-origin-unswitched-", {
      dualWrite: false,
      legacyTree: false,
    });
    const shared = storeOnlyNamespace(env);
    const report = mirrorSignal(shared, env.vault, SIGNAL);
    expect(report.outcome).toBe(MIRROR_OUTCOME.misconfigured);
    expect(report.reason).toContain("already in this machine's brain store");
    expect(mirrored(env, SIGNAL_KIND)).toHaveLength(0);
  });

  test("a private signal on a machine whose store holds only shared fails cleanly", () => {
    env = makeStoreEnv("osb-shared-ns-private-", { dualWrite: false, partitions: ["shared"] });
    const shared = storeOnlyNamespace(env);
    const secret = { ...SIGNAL, principle: "Keep <private>the client</private> out." };
    const report = mirrorSignal(shared, env.vault, secret);
    expect(report.outcome).toBe(MIRROR_OUTCOME.failed);
    expect(mirrored(env, SIGNAL_KIND)).toHaveLength(0);
    expect(readdirSync(shared)).toEqual([]);
  });
});

describe("a shared namespace path that is no directory", () => {
  for (const shape of ["missing", "file"] as const) {
    test(`(${shape}) is reported failed, and nothing is mirrored into this machine's store`, () => {
      env = makeStoreEnv(`osb-shared-ns-${shape}-`, { dualWrite: false });
      const shared = join(env.parent, "shared-namespace");
      if (shape === "file") writeFileSync(shared, "not a vault\n");
      writeSignal(env.vault, SIGNAL);
      const signal = mirrorSignal(shared, env.vault, SIGNAL);
      const note = mirrorNote(shared, env.vault, { text: "shared fact", agent: "a" });
      for (const report of [signal, note]) {
        expect(report.outcome).toBe(MIRROR_OUTCOME.failed);
        expect(report.reason).toContain("not a directory");
      }
      expect(mirrored(env, SIGNAL_KIND)).toHaveLength(0);
      expect(mirrored(env, LOG_EVENT_KIND)).toHaveLength(0);
    });
  }
});

describe("a switched machine", () => {
  test("still refuses the mirror: the origin record is already in the one store every agent reads", () => {
    env = makeStoreEnv("osb-shared-ns-switched-", { dualWrite: false });
    const [a, b] = twoMachines(env);
    const shared = storeOnlyNamespace(env);
    use(a);
    writeSignal(a.vault, SIGNAL);
    const report = mirrorSignal(shared, a.vault, SIGNAL);
    expect(report.outcome).toBe(MIRROR_OUTCOME.misconfigured);
    expect(mirrored(env, SIGNAL_KIND)).toHaveLength(0);
    // No second store is needed: an agent on another machine of the store
    // reads the origin record once the sync delivers it.
    sync(a, b);
    use(b);
    const atB = [
      ...partitionRecords(b.storeRoot, "shared"),
      ...partitionRecords(b.storeRoot, "private"),
    ].filter((r) => r.kind === SIGNAL_KIND);
    expect(JSON.stringify(atB)).toContain(SIGNAL.principle);
  });

  test("refuses for a store-only origin vault too", () => {
    env = makeStoreEnv("osb-shared-ns-origin-", { dualWrite: false, legacyTree: false });
    switchDevice(env.storeRoot);
    const shared = storeOnlyNamespace(env);
    expect(mirrorSignal(shared, env.vault, SIGNAL).outcome).toBe(MIRROR_OUTCOME.misconfigured);
  });
});

describe("a caller that names its machine config", () => {
  test("is refused by that config's dual-write flag, not by the default config's", () => {
    env = makeStoreEnv("osb-shared-ns-config-", { dualWrite: false });
    const shared = storeOnlyNamespace(env);
    // The default config has dual writes off; the caller's config turns
    // them on, so the origin record already reached the store there.
    const callerConfig = join(env.parent, "caller-config.yaml");
    writeFileSync(callerConfig, `vault: ${env.vault}\nstore_dual_write: "true"\n`);
    const note = mirrorNote(shared, env.vault, { text: "shared fact", agent: "a" }, callerConfig);
    const signal = mirrorSignal(shared, env.vault, SIGNAL, {}, callerConfig);
    for (const report of [note, signal]) {
      expect(report.outcome).toBe(MIRROR_OUTCOME.misconfigured);
      expect(report.reason).toContain("already in this machine's brain store");
    }
    expect(mirrored(env, LOG_EVENT_KIND)).toHaveLength(0);
    expect(mirrored(env, SIGNAL_KIND)).toHaveLength(0);
  });
});
