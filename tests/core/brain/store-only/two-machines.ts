/**
 * Two store-only machines of one store in one test process (task 3.12):
 * machine A is the store env, machine B a second machine with its own
 * config, vault, device id, device-local state and copy of the store.
 * `use` points the process at one of them; `sync` delivers the shards one
 * machine wrote to the other, as a file-sync tool does.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { bootstrapBrain } from "../../../../src/core/brain/init.ts";
import { STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";
import type { StoreEnv } from "../../store/fixtures/store-env.ts";
import { switchDevice } from "./fixtures.ts";

export interface Machine {
  readonly device: string;
  readonly root: string;
  readonly vault: string;
  readonly storeRoot: string;
  readonly configPath: string;
}

/** Point this process at one machine: its config, store, device and local state. */
export function use(m: Machine): void {
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = m.configPath;
  process.env[STORE_ROOT_ENV] = m.storeRoot;
  process.env["O2B_DEVICE_ID"] = m.device;
  process.env["HOME"] = join(m.root, "home");
  process.env["XDG_STATE_HOME"] = join(m.root, "state");
  process.env["LOCALAPPDATA"] = join(m.root, "state");
}

/** Machine A from the store env, machine B a second machine of the same store. */
export function twoMachines(e: StoreEnv): [Machine, Machine] {
  const a: Machine = {
    device: "dev-a",
    root: e.parent,
    vault: e.vault,
    storeRoot: e.storeRoot,
    configPath: e.configPath,
  };
  const rootB = join(e.parent, "machine-b");
  const b: Machine = {
    device: "dev-b",
    root: rootB,
    vault: join(rootB, "vault"),
    storeRoot: join(rootB, "store"),
    configPath: join(rootB, "config.yaml"),
  };
  mkdirSync(b.vault, { recursive: true });
  writeFileSync(b.configPath, `vault: ${b.vault}\n`);
  // The same store, as the sync tool delivers it before anything is written.
  cpSync(a.storeRoot, b.storeRoot, { recursive: true });
  use(b);
  bootstrapBrain(b.vault);
  switchDevice(b.storeRoot, b.device);
  use(a);
  switchDevice(a.storeRoot, a.device);
  return [a, b];
}

/** Deliver every shard `from` wrote into `to`'s store, as a file sync does. */
export function sync(from: Machine, to: Machine): void {
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (!statSync(path).isDirectory()) continue;
      if (name === from.device) {
        cpSync(path, join(to.storeRoot, relative(from.storeRoot, path)), {
          recursive: true,
          force: true,
        });
      } else walk(path);
    }
  };
  for (const partition of ["shared", "private"]) {
    const dir = join(from.storeRoot, partition);
    if (existsSync(dir)) walk(dir);
  }
}
