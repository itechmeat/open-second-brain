/**
 * Doctor with no vault or no legacy tree (design D14, task 2.10): a
 * machine whose brain is the store gets no false failure; a machine with
 * neither a legacy tree nor a store is still told so.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { runDoctor } from "../../../src/core/brain/doctor.ts";
import { brainConfigPath } from "../../../src/core/brain/paths.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { STORE_ROOT_ENV } from "../../../src/core/store/constants.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import { defaultStoreRoot } from "../../../src/core/store/store-paths.ts";
import { bindVaultToStore } from "../../../src/core/vault-adapter/vault-binding.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv | null = null;
afterEach(() => {
  env?.cleanup();
  env = null;
});

const codes = (r: ReturnType<typeof runDoctor>) => [
  ...r.warnings.map((w) => w.code),
  ...r.errors.map((e) => e.code),
];

/** A removed signal: the removal backlog finding the store check reports. */
function seedRemovedSignal(e: StoreEnv): void {
  const store = openStore({ root: e.storeRoot, device: "dev-a" });
  appendRecord(store, {
    partition: "shared",
    stream: "events",
    kind: "signal",
    agent: "t",
    body: { id: "sig-x", path: "Brain/inbox/sig-x.md", staged: false, frontmatter: {}, raw: "x" },
  });
  appendRecord(store, {
    partition: "shared",
    stream: "events",
    kind: "signal-removed",
    agent: "t",
    body: { authority: "human", signal: "sig-x" },
  });
}

describe("doctor without a legacy tree", () => {
  test("no vault and a store: clean", () => {
    env = makeStoreEnv("osb-doctor-novault-store-", { legacyTree: false, configureVault: false });
    const result = runDoctor(null);
    expect(codes(result)).toEqual([]);
    expect(result.trust_verdict).toBe("clean");
  });

  test("no vault and a store: the store-side checks run and report what they find", () => {
    env = makeStoreEnv("osb-doctor-novault-finding-", { legacyTree: false, configureVault: false });
    const store = openStore({ root: env.storeRoot, device: "dev-a" });
    appendRecord(store, {
      partition: "shared",
      stream: "events",
      kind: "signal",
      agent: "t",
      body: { id: "sig-x", path: "Brain/inbox/sig-x.md", staged: false, frontmatter: {}, raw: "x" },
    });
    appendRecord(store, {
      partition: "shared",
      stream: "events",
      kind: "signal-removed",
      agent: "t",
      body: { authority: "human", signal: "sig-x" },
    });
    // The store check (store-check.ts) ran: its removal backlog finding is here.
    expect(codes(runDoctor(null))).toEqual(["store-removed-awaiting-compaction"]);
  });

  test("no vault and no store: the absence is named with the remedy", () => {
    env = makeStoreEnv("osb-doctor-novault-none-", {
      legacyTree: false,
      configureVault: false,
      partitions: [],
    });
    const result = runDoctor(null);
    expect(codes(result)).toEqual(["brain-root-absent"]);
    expect(result.warnings[0]!.message).toContain("o2b init");
    expect(result.warnings[0]!.path).toBe(env.storeRoot);
  });

  test("a bound vault with no Brain/ and a store: clean", () => {
    env = makeStoreEnv("osb-doctor-fresh-store-", { legacyTree: false });
    bindVaultToStore(env.vault, { configPath: env.configPath });
    expect(codes(runDoctor(env.vault))).toEqual([]);
  });

  test("an unbound vault with no Brain/ keeps the root-absent warning despite a store", () => {
    // The Unit J case: a legacy machine whose vault root resolved wrong,
    // with a store that phase 1 dual write created.
    env = makeStoreEnv("osb-doctor-misresolved-", { legacyTree: false });
    const result = runDoctor(env.vault);
    expect(codes(result)).toEqual(["brain-root-absent"]);
    expect(result.warnings[0]!.message).toContain("o2b init --vault");
  });

  test("a vault with no Brain/ on a switched machine and an empty store: clean", () => {
    env = makeStoreEnv("osb-doctor-switched-fresh-", { legacyTree: false });
    appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "settings",
      kind: "device-switched",
      agent: "test",
      body: { authority: "human", device: "dev-a" },
    });
    expect(codes(runDoctor(env.vault))).toEqual([]);
  });

  test("a vault with no Brain/ on a switched machine: the store-side checks still run", () => {
    env = makeStoreEnv("osb-doctor-switched-finding-", { legacyTree: false });
    const store = openStore({ root: env.storeRoot, device: "dev-a" });
    appendRecord(store, {
      partition: "shared",
      stream: "settings",
      kind: "device-switched",
      agent: "test",
      body: { authority: "human", device: "dev-a" },
    });
    seedRemovedSignal(env);
    expect(codes(runDoctor(env.vault))).toEqual(["store-removed-awaiting-compaction"]);
  });

  test("no vault, the default store root and no dual write: the store is still checked", () => {
    env = makeStoreEnv("osb-doctor-default-root-", {
      legacyTree: false,
      configureVault: false,
      dualWrite: false,
      partitions: [],
    });
    // The store at the default root, as `o2b init` makes it.
    delete process.env[STORE_ROOT_ENV];
    const root = defaultStoreRoot();
    initStore({ root });
    try {
      seedRemovedSignal({ ...env, storeRoot: root });
      expect(codes(runDoctor(null))).toEqual(["store-removed-awaiting-compaction"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a vault with no Brain/ and no store keeps the root-absent warning", () => {
    env = makeStoreEnv("osb-doctor-fresh-none-", { legacyTree: false, partitions: [] });
    expect(codes(runDoctor(env.vault))).toEqual(["brain-root-absent"]);
  });

  test("a switched machine without _brain.yaml reports no missing config", () => {
    env = makeStoreEnv("osb-doctor-switched-");
    appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "settings",
      kind: "device-switched",
      agent: "test",
      body: { authority: "human", device: "dev-a" },
    });
    rmSync(brainConfigPath(env.vault));
    const result = runDoctor(env.vault);
    expect(codes(result)).not.toContain("config-missing");
    expect(codes(result)).not.toContain("config-invalid");
  });

  test("an explicit machine config decides the mode, not the default one", () => {
    env = makeStoreEnv("osb-doctor-explicit-config-");
    appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "settings",
      kind: "device-switched",
      agent: "test",
      body: { authority: "human", device: "dev-a" },
    });
    rmSync(brainConfigPath(env.vault));
    // Only the explicit config names this machine's device.
    delete process.env["O2B_DEVICE_ID"];
    const explicit = join(env.parent, "explicit.yaml");
    writeFileSync(explicit, `vault: ${env.vault}\ndevice_id: dev-a\n`);
    expect(codes(runDoctor(env.vault))).toContain("config-missing");
    expect(codes(runDoctor(env.vault, { configPath: explicit }))).not.toContain("config-missing");
  });

  test("an unswitched machine without _brain.yaml still reports it missing", () => {
    env = makeStoreEnv("osb-doctor-legacy-noconfig-");
    rmSync(join(env.vault, "Brain", "_brain.yaml"));
    expect(codes(runDoctor(env.vault))).toContain("config-missing");
  });
});
