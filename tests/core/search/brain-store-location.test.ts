/**
 * Where the search index lives (design D5, task 1.8): in the store's
 * device-local state when a store is in use, one file per vault, and at
 * the legacy vault location otherwise; an explicit override wins either
 * way.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { DERIVED_STORE_DIR, DERIVED_STORE_FILE } from "../../../src/core/brain/path-constants.ts";
import { resolveSearchConfig } from "../../../src/core/search/index.ts";
import {
  probeIndexedStore,
  resolveIndexedStore,
  storeIndexPath,
} from "../../../src/core/search/brain-store/location.ts";
import { resolveConfiguredIndexPath, resolveIndexPath } from "../../../src/core/search/paths.ts";
import {
  STORE_IDENTITY_FILE,
  STORE_ROOT_CONFIG_KEY,
  STORE_ROOT_ENV,
} from "../../../src/core/store/constants.ts";
import {
  LOCAL_DEVICE,
  makeStoreIndexFixture,
  type StoreIndexFixture,
} from "./fixtures/brain-store-index.ts";

let fx: StoreIndexFixture;
beforeEach(() => {
  fx = makeStoreIndexFixture("osb-store-location-");
});
afterEach(() => fx.cleanup());

const legacyPath = (vault: string): string => join(vault, DERIVED_STORE_DIR, DERIVED_STORE_FILE);

describe("index location", () => {
  test("no store in use keeps the legacy vault location", () => {
    const dirs = fx.dirs(LOCAL_DEVICE);
    const store = resolveIndexedStore({
      vault: fx.vault,
      config: { [STORE_ROOT_CONFIG_KEY]: fx.root },
      dirs,
    });
    expect(store).toBeNull();
    expect(resolveIndexPath(fx.vault, null, store)).toBe(legacyPath(fx.vault));
  });

  test("a store in use moves the index into its device-local state, one file per vault", () => {
    fx.open(LOCAL_DEVICE);
    const dirs = fx.dirs(LOCAL_DEVICE);
    const store = resolveIndexedStore({
      vault: fx.vault,
      config: { [STORE_ROOT_CONFIG_KEY]: fx.root },
      dirs,
    });
    expect(store).not.toBeNull();
    expect(store!.partitions).toEqual(["shared", "private"]);
    const path = resolveIndexPath(fx.vault, null, store);
    expect(path.startsWith(store!.deviceStateDir)).toBe(true);
    expect(path.endsWith(DERIVED_STORE_FILE)).toBe(true);
    const other = storeIndexPath(store!, join(fx.parent, "other-vault"));
    expect(other).not.toBe(path);
  });

  test("one vault reached through a link keeps one index", () => {
    fx.open(LOCAL_DEVICE);
    const store = probeIndexedStore(fx.root, fx.dirs(LOCAL_DEVICE))!;
    const link = join(fx.parent, "vault-link");
    // A junction needs no privilege on Windows; elsewhere the type is ignored.
    symlinkSync(fx.vault, link, "junction");
    expect(storeIndexPath(store, link)).toBe(storeIndexPath(store, fx.vault));
    expect(storeIndexPath(store, `${fx.vault}/./`)).toBe(storeIndexPath(store, fx.vault));
  });

  test("an explicit override wins over the store location", () => {
    fx.open(LOCAL_DEVICE);
    const store = probeIndexedStore(fx.root, fx.dirs(LOCAL_DEVICE));
    const override = join(fx.parent, "elsewhere", "index.sqlite");
    expect(resolveIndexPath(fx.vault, override, store)).toBe(override);
  });

  test("a store root inside the vault is not used", () => {
    const store = resolveIndexedStore({
      vault: fx.vault,
      config: { [STORE_ROOT_CONFIG_KEY]: join(fx.vault, "store") },
      dirs: fx.dirs(LOCAL_DEVICE),
    });
    expect(store).toBeNull();
  });
});

describe("resolveSearchConfig", () => {
  const saved: Record<string, string | undefined> = {};
  const keys = [STORE_ROOT_ENV, "XDG_STATE_HOME", "LOCALAPPDATA"];
  beforeEach(() => {
    for (const k of keys) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  test("attaches the store and places the index in its device-local state", () => {
    fx.open(LOCAL_DEVICE);
    const env = fx.dirs(LOCAL_DEVICE).env;
    process.env[STORE_ROOT_ENV] = fx.root;
    process.env["XDG_STATE_HOME"] = env["XDG_STATE_HOME"];
    process.env["LOCALAPPDATA"] = env["LOCALAPPDATA"];
    const config = resolveSearchConfig({ vault: fx.vault });
    expect(config.brainStore?.root).toBe(fx.root);
    expect(config.dbPath.startsWith(config.brainStore!.deviceStateDir)).toBe(true);
  });

  test("without a store the config carries none and the index stays in the vault", () => {
    process.env[STORE_ROOT_ENV] = fx.root;
    const config = resolveSearchConfig({ vault: fx.vault });
    expect(config.brainStore).toBeNull();
    expect(config.brainStoreUnknown).toBeUndefined();
    expect(config.dbPath).toBe(legacyPath(fx.vault));
  });

  test("a store that reads as unknown keeps the store index this machine last wrote", () => {
    fx.open(LOCAL_DEVICE);
    const env = fx.dirs(LOCAL_DEVICE).env;
    process.env[STORE_ROOT_ENV] = fx.root;
    process.env["XDG_STATE_HOME"] = env["XDG_STATE_HOME"];
    process.env["LOCALAPPDATA"] = env["LOCALAPPDATA"];
    const known = resolveSearchConfig({ vault: fx.vault }).dbPath;
    mkdirSync(dirname(known), { recursive: true });
    writeFileSync(known, "");
    // A sync tool mid-rewrite of store.json.
    writeFileSync(join(fx.root, "shared", STORE_IDENTITY_FILE), "{");
    const config = resolveSearchConfig({ vault: fx.vault });
    expect(config.brainStore).toBeNull();
    expect(config.brainStoreUnknown).toBe(true);
    expect(config.dbPath).toBe(known);
    expect(resolveConfiguredIndexPath(fx.vault, join(fx.parent, "no-config.yaml"))).toBe(known);
  });

  test("a store that reads as unknown never picks the index of a store at another root", () => {
    fx.open(LOCAL_DEVICE);
    const env = fx.dirs(LOCAL_DEVICE).env;
    process.env[STORE_ROOT_ENV] = fx.root;
    process.env["XDG_STATE_HOME"] = env["XDG_STATE_HOME"];
    process.env["LOCALAPPDATA"] = env["LOCALAPPDATA"];
    const retired = resolveSearchConfig({ vault: fx.vault }).dbPath;
    mkdirSync(dirname(retired), { recursive: true });
    writeFileSync(retired, "");
    // The root moved; the new store's store.json is mid-write.
    const moved = join(fx.parent, "moved-store");
    mkdirSync(join(moved, "shared"), { recursive: true });
    writeFileSync(join(moved, "shared", STORE_IDENTITY_FILE), "{");
    process.env[STORE_ROOT_ENV] = moved;
    const config = resolveSearchConfig({ vault: fx.vault });
    expect(config.brainStoreUnknown).toBe(true);
    expect(config.dbPath).toBe(legacyPath(fx.vault));
  });

  test("a store that reads as unknown with no store index yet uses the legacy location", () => {
    fx.open(LOCAL_DEVICE);
    const env = fx.dirs(LOCAL_DEVICE).env;
    process.env[STORE_ROOT_ENV] = fx.root;
    process.env["XDG_STATE_HOME"] = env["XDG_STATE_HOME"];
    process.env["LOCALAPPDATA"] = env["LOCALAPPDATA"];
    writeFileSync(join(fx.root, "shared", STORE_IDENTITY_FILE), "{");
    expect(resolveSearchConfig({ vault: fx.vault }).dbPath).toBe(legacyPath(fx.vault));
  });

  test("an identity file it cannot read says the store is unknown, not absent", () => {
    mkdirSync(join(fx.root, "shared"), { recursive: true });
    writeFileSync(join(fx.root, "shared", STORE_IDENTITY_FILE), "{");
    process.env[STORE_ROOT_ENV] = fx.root;
    const config = resolveSearchConfig({ vault: fx.vault });
    expect(config.brainStore).toBeNull();
    expect(config.brainStoreUnknown).toBe(true);
  });
});
