/**
 * Two fresh vaults (no legacy tree) on one machine keep their machine
 * state apart while the machine is unswitched; once it switches, both
 * folders move into the one switched folder. A file both vaults hold with
 * different bytes is never dropped: the first vault's copy is the live
 * one and the other's is kept aside under `adopt-conflicts/`, so no
 * vault's state is lost through the switch.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  forgetMachineStateCache,
  machineStatePath,
  machineStateRoot,
} from "../../../src/core/state/machine-state.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { DEVICE_SWITCHED_KIND } from "../../../src/core/store/store-only.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
  forgetMachineStateCache();
});

function put(vault: string, text: string, ...segments: string[]): void {
  const path = machineStatePath(vault, ...segments);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

/** The text of every file below `dir`. */
function texts(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (lstatSync(path).isDirectory()) texts(path, out);
    else out.push(readFileSync(path, "utf8"));
  }
  return out;
}

describe("two fresh vaults through a switch", () => {
  test("keep apart before it, and lose no file at it", () => {
    env = makeStoreEnv("osb-fresh-switch-", { legacyTree: false });
    const first = env.vault;
    const second = join(env.parent, "second-vault");
    mkdirSync(second);
    expect(machineStateRoot(first)).not.toBe(machineStateRoot(second));
    put(first, "first hook state", ".open-second-brain", "hook-state", "s.json");
    put(second, "second hook state", ".open-second-brain", "hook-state", "s.json");
    put(first, "first manifest", ".open-second-brain", "ingest-manifest.json");
    put(second, "second only", ".open-second-brain", "checkpoints", "c.json");

    appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "settings",
      kind: DEVICE_SWITCHED_KIND,
      agent: "o2b",
      body: { authority: "human", vault_id: null, device: "dev-a" },
    });
    forgetMachineStateCache();

    const live = machineStateRoot(first);
    expect(machineStateRoot(second)).toBe(live);
    const read = (...segments: string[]) =>
      readFileSync(machineStatePath(first, ...segments), "utf8");
    expect(read(".open-second-brain", "hook-state", "s.json")).toBe("first hook state");
    expect(read(".open-second-brain", "ingest-manifest.json")).toBe("first manifest");
    expect(read(".open-second-brain", "checkpoints", "c.json")).toBe("second only");

    // The second vault's own hook state is kept, aside from the live folder.
    const all = texts(join(live, ".."));
    for (const text of ["first hook state", "second hook state", "first manifest", "second only"]) {
      expect({ text, kept: all.includes(text) }).toEqual({ text, kept: true });
    }
  });
});
