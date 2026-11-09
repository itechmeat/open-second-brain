/**
 * `describeStoreLocation` (`store-location.ts`): where the brain store, its
 * partitions and the device-local state directory are, which setting put
 * each there, and whether each exists. It reads only: a store that does not
 * exist yet is described, never created.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  STORE_IDENTITY_FILE,
  STORE_ROOT_CONFIG_KEY,
  STORE_ROOT_ENV,
} from "../../../src/core/store/constants.ts";
import { initStore } from "../../../src/core/store/store-init.ts";
import { VIEW_TARGET_CONFIG_KEY, VIEW_TARGET_ENV } from "../../../src/core/view/constants.ts";
import { describeStoreLocation } from "../../../src/core/store/store-location.ts";
import { storesStateDir, type StoreRootSource } from "../../../src/core/store/store-paths.ts";

let parent: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-store-location-"));
});
afterEach(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function source(overrides: Partial<StoreRootSource> = {}): StoreRootSource {
  return {
    platform: process.platform,
    home: join(parent, "home"),
    env: { XDG_DATA_HOME: join(parent, "data"), XDG_STATE_HOME: join(parent, "state") },
    config: {},
    configPath: join(parent, "config", "config.yaml"),
    vault: null,
    ...overrides,
  };
}

describe("describeStoreLocation", () => {
  test("a store that does not exist yet is described with its resolved paths and created nowhere", () => {
    const report = describeStoreLocation(source());
    expect(report.root.origin).toBe("default");
    expect(report.root.path).toBe(join(parent, "data", "open-second-brain", "store"));
    expect(report.root.exists).toBe(false);
    expect(report.initialized).toBe(false);
    expect(report.storeId).toBeNull();
    expect(report.partitions.map((p) => [p.name, p.held, p.exists])).toEqual([
      ["shared", false, false],
      ["private", false, false],
    ]);
    // Without a store id the per-store directory has no name yet: the
    // directory that will hold it is reported instead.
    expect(report.deviceStateDir.scope).toBe("all-stores");
    expect(report.deviceStateDir.path).toBe(join(parent, "state", "open-second-brain", "stores"));
    expect(report.deviceStateDir.origin).toBe("env");
    expect(report.error).toBeNull();
    expect(existsSync(report.root.path)).toBe(false);
  });

  test("an initialized store names its id, the partitions it holds and its own state directory", () => {
    const root = join(parent, "store");
    const created = initStore({ root, partitions: ["shared"] });
    const src = source({ env: { [STORE_ROOT_ENV]: root } });
    const report = describeStoreLocation(src);
    expect(report.root).toEqual({ path: root, origin: "env", exists: true });
    expect(report.initialized).toBe(true);
    expect(report.storeId).toBe(created.storeId);
    expect(report.partitions).toEqual([
      { name: "shared", path: join(root, "shared"), held: true, exists: true },
      { name: "private", path: join(root, "private"), held: false, exists: false },
    ]);
    expect(report.deviceStateDir.scope).toBe("store");
    expect(report.deviceStateDir.path).toBe(join(storesStateDir(src), created.storeId));
    expect(report.deviceStateDir.origin).toBe("default");
    expect(report.deviceStateDir.exists).toBe(false);
  });

  test("a state home of only spaces moves the path, so its origin is the environment", () => {
    const report = describeStoreLocation(
      source({ env: { XDG_DATA_HOME: join(parent, "data"), XDG_STATE_HOME: "  " } }),
    );
    expect(report.deviceStateDir.origin).toBe("env");
  });

  test("a root from the machine config reports the config as its origin", () => {
    const root = join(parent, "configured");
    const report = describeStoreLocation(source({ config: { [STORE_ROOT_CONFIG_KEY]: root } }));
    expect(report.root.origin).toBe("config");
    expect(report.root.path).toBe(root);
  });

  test("a root inside the vault is still described, with the refusal as the error", () => {
    const vault = join(parent, "vault");
    mkdirSync(vault);
    const root = join(vault, "store");
    const report = describeStoreLocation(source({ vault, env: { [STORE_ROOT_ENV]: root } }));
    expect(report.root).toEqual({ path: root, origin: "env", exists: false });
    expect(report.initialized).toBe(false);
    expect(report.error).toContain("inside the vault");
    expect(report.error).toContain(STORE_ROOT_ENV);
  });

  test("a corrupt identity file is an error, and the partition still counts as present", () => {
    const root = join(parent, "store");
    mkdirSync(join(root, "shared"), { recursive: true });
    writeFileSync(join(root, "shared", STORE_IDENTITY_FILE), "not json");
    const report = describeStoreLocation(source({ env: { [STORE_ROOT_ENV]: root } }));
    expect(report.initialized).toBe(false);
    expect(report.error).toContain(STORE_IDENTITY_FILE);
    expect(report.partitions[0]).toMatchObject({ name: "shared", held: false, exists: true });
  });

  test("no view target configured is reported as none, not as an error", () => {
    const report = describeStoreLocation(source());
    expect(report.viewTarget).toEqual({ path: null, origin: "none", exists: false, error: null });
  });

  test("a view target from the machine config resolves against the config's folder", () => {
    mkdirSync(join(parent, "config", "view"), { recursive: true });
    const report = describeStoreLocation(source({ config: { [VIEW_TARGET_CONFIG_KEY]: "view" } }));
    expect(report.viewTarget).toEqual({
      path: join(parent, "config", "view"),
      origin: "config",
      exists: true,
      error: null,
    });
  });

  test("the environment wins over the config, and ~ expands to the home given", () => {
    const report = describeStoreLocation(
      source({
        env: { [VIEW_TARGET_ENV]: "~/pages" },
        config: { [VIEW_TARGET_CONFIG_KEY]: join(parent, "other") },
      }),
    );
    expect(report.viewTarget).toEqual({
      path: join(parent, "home", "pages"),
      origin: "env",
      exists: false,
      error: null,
    });
  });

  test("a view target inside the store is described with the refusal as its own error", () => {
    const root = join(parent, "store");
    const report = describeStoreLocation(
      source({ env: { [STORE_ROOT_ENV]: root, [VIEW_TARGET_ENV]: join(root, "shared", "view") } }),
    );
    expect(report.viewTarget.path).toBe(join(root, "shared", "view"));
    expect(report.viewTarget.origin).toBe("env");
    expect(report.viewTarget.error).toContain("inside the brain store");
    // The store itself is still usable: only the view is refused.
    expect(report.error).toBeNull();
  });
});
