/**
 * Test helper: a vault, a brain store and the search index of one machine
 * ("dev-a") that lives in the store's device-local state, all under one
 * named temp parent removed in teardown.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  probeIndexedStore,
  storeIndexPath,
} from "../../../../src/core/search/brain-store/location.ts";
import type { ResolvedSearchConfig } from "../../../../src/core/search/types.ts";
import type { PlatformDirsEnv } from "../../../../src/core/platform-dirs.ts";
import { openStore, type StoreHandle } from "../../../../src/core/store/store-open.ts";
import { ensureStore } from "../../store/fixtures/temp-store.ts";
import { makeConfig } from "../../../helpers/search-fixtures.ts";

export const LOCAL_DEVICE = "dev-a";
export const REMOTE_DEVICE = "dev-b";

export interface StoreIndexFixture {
  readonly parent: string;
  readonly vault: string;
  readonly root: string;
  /** Platform source whose state base is private to `machine`. */
  dirs(machine: string): PlatformDirsEnv;
  /** The store as `device` opens it (creating it on first use). */
  open(device: string): StoreHandle;
  /** The search config of the local machine, with the store attached. */
  config(): ResolvedSearchConfig;
  writeNote(rel: string, text: string): void;
  cleanup(): void;
}

/** Platform source whose state base under `parent` is private to `machine`. */
export function fixtureDirs(parent: string, machine: string): PlatformDirsEnv {
  return {
    platform: process.platform,
    home: join(parent, "home", machine),
    env: {
      XDG_STATE_HOME: join(parent, "state", machine),
      LOCALAPPDATA: join(parent, "state", machine),
    },
  };
}

/** The local machine's search config for the fixture under `parent`. */
export function fixtureConfig(parent: string): ResolvedSearchConfig {
  const vault = join(parent, "vault");
  const store = probeIndexedStore(join(parent, "store"), fixtureDirs(parent, LOCAL_DEVICE));
  if (store === null) throw new Error("no store under the fixture root");
  return Object.freeze({
    ...makeConfig({ vault, dbPath: storeIndexPath(store, vault) }),
    brainStore: store,
  });
}

export function makeStoreIndexFixture(prefix = "osb-store-index-"): StoreIndexFixture {
  const parent = mkdtempSync(join(tmpdir(), prefix));
  const vault = join(parent, "vault");
  const root = join(parent, "store");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  const dirs = (machine: string): PlatformDirsEnv => fixtureDirs(parent, machine);
  return {
    parent,
    vault,
    root,
    dirs,
    open: (device) => {
      ensureStore(root);
      return openStore({ root, device, dirs: dirs(device) });
    },
    config: () => fixtureConfig(parent),
    writeNote: (rel, text) => {
      const abs = join(vault, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
    },
    cleanup: () => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}
