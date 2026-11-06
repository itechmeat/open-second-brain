/**
 * Test helper: one named temp parent per test holding a store root and a
 * device-local state base per simulated machine, removed in teardown.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlatformDirsEnv } from "../../../../src/core/platform-dirs.ts";
import { initStore } from "../../../../src/core/store/store-init.ts";
import {
  inspectStore,
  openStore,
  type StoreHandle,
} from "../../../../src/core/store/store-open.ts";

/**
 * Create the store at `root` with both partitions unless one is there,
 * as `o2b store init` would on the first machine. Writers never create a
 * store, so every fixture that writes needs one first.
 */
export function ensureStore(root: string): void {
  if (inspectStore(root) === null) initStore({ root });
}

export interface TempStore {
  readonly parent: string;
  readonly root: string;
  /** Platform source whose state base is private to `machine`. */
  dirs(machine: string): PlatformDirsEnv;
  /** Open the store as `device` (created first when absent), with that device's own device-local state. */
  open(device: string): StoreHandle;
  cleanup(): void;
}

export function makeTempStore(prefix = "osb-store-"): TempStore {
  const parent = mkdtempSync(join(tmpdir(), prefix));
  const root = join(parent, "store");
  const dirs = (machine: string): PlatformDirsEnv => ({
    platform: process.platform,
    home: join(parent, "home", machine),
    env: {
      XDG_STATE_HOME: join(parent, "state", machine),
      LOCALAPPDATA: join(parent, "state", machine),
    },
  });
  return {
    parent,
    root,
    dirs,
    open: (device) => {
      ensureStore(root);
      return openStore({ root, device, dirs: dirs(device) });
    },
    cleanup: () => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}
