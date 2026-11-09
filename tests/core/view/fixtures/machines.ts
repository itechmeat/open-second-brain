/**
 * Test helper: several simulated machines, each with its own copy of one
 * brain store, its own device-local state and its own view folder, all
 * under one named temp parent removed in teardown. `sync` copies each
 * machine's own shards and every blob to the other copies, the way a file
 * sync tool delivers whole files.
 */
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";

import type { PlatformDirsEnv } from "../../../../src/core/platform-dirs.ts";
import { STORE_PARTITIONS } from "../../../../src/core/store/constants.ts";
import { initStore } from "../../../../src/core/store/store-init.ts";
import { openStore, type StoreHandle } from "../../../../src/core/store/store-open.ts";

export interface Machines {
  readonly parent: string;
  root(device: string): string;
  view(device: string): string;
  open(device: string): StoreHandle;
  /** Deliver every machine's shards and blobs to every other machine. */
  sync(): void;
  /** Deliver `from`'s shards and blobs to `to` only. */
  deliver(from: string, to: string): void;
  cleanup(): void;
}

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(path));
    else out.push(path);
  }
  return out;
}

export function makeMachines(devices: ReadonlyArray<string>, prefix = "osb-view-"): Machines {
  const parent = mkdtempSync(join(tmpdir(), prefix));
  const root = (device: string) => join(parent, "stores", device);
  const view = (device: string) => join(parent, "views", device);
  const dirs = (device: string): PlatformDirsEnv => ({
    platform: process.platform,
    home: join(parent, "home", device),
    env: {
      XDG_STATE_HOME: join(parent, "state", device),
      LOCALAPPDATA: join(parent, "state", device),
    },
  });
  const first = devices[0]!;
  initStore({ root: root(first) });
  for (const device of devices.slice(1)) cpSync(root(first), root(device), { recursive: true });
  const deliver = (from: string, to: string): void => {
    for (const partition of STORE_PARTITIONS) {
      const src = join(root(from), partition);
      for (const file of walk(src)) {
        const parts = relative(src, file).split(sep);
        const device = parts[0] === "ledgers" ? parts[2] : parts[1];
        if (parts[0] !== "blobs" && device !== from) continue;
        const dst = join(root(to), partition, ...parts);
        if (parts[0] === "blobs" && existsSync(dst)) continue;
        mkdirSync(dirname(dst), { recursive: true });
        copyFileSync(file, dst);
      }
    }
  };
  return {
    parent,
    root,
    view,
    open: (device) => openStore({ root: root(device), device, dirs: dirs(device) }),
    deliver,
    sync: () => {
      for (const from of devices) for (const to of devices) if (from !== to) deliver(from, to);
    },
    cleanup: () => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  };
}
