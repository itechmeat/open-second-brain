/**
 * Test environment for the automatic view render (the dream pass and the
 * session-start hook): one named temp parent holding a store root, a view
 * target, HOME and device-local state, with every environment variable it
 * sets restored in teardown; plus the unswitched vault a dream pass runs
 * on and the writer store both suites seed.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resetVaultIdentityPins } from "../../../../src/core/brain/vault-identity.ts";
import { STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";
import { initStore } from "../../../../src/core/store/store-init.ts";
import { openStore, type StoreHandle } from "../../../../src/core/store/store-open.ts";
import { VIEW_TARGET_ENV } from "../../../../src/core/view/constants.ts";
import { claimViewWriter } from "../../../../src/core/view/writer.ts";
import { seedLogEvent, seedPreference } from "./seed.ts";

const ENV_KEYS = [
  STORE_ROOT_ENV,
  VIEW_TARGET_ENV,
  "O2B_DEVICE_ID",
  "HOME",
  "XDG_STATE_HOME",
  "LOCALAPPDATA",
] as const;

/** The fixed clock the seeded records sit just before. */
export const AUTO_NOW = Date.UTC(2026, 10, 6, 12, 0, 0);

export interface AutoViewEnv {
  readonly parent: string;
  readonly root: string;
  readonly view: string;
  cleanup(): void;
}

/** A store root and a view target under a fresh parent, this machine `dev-a`. */
export function makeAutoViewEnv(prefix: string): AutoViewEnv {
  const saved = new Map<string, string | undefined>();
  for (const key of ENV_KEYS) saved.set(key, process.env[key]);
  const parent = mkdtempSync(join(tmpdir(), prefix));
  const root = join(parent, "store");
  const view = join(parent, "view");
  process.env[STORE_ROOT_ENV] = root;
  process.env[VIEW_TARGET_ENV] = view;
  process.env["O2B_DEVICE_ID"] = "dev-a";
  process.env["HOME"] = join(parent, "home");
  process.env["XDG_STATE_HOME"] = join(parent, "state");
  process.env["LOCALAPPDATA"] = join(parent, "state");
  resetVaultIdentityPins();
  return {
    parent,
    root,
    view,
    cleanup: () => {
      for (const key of ENV_KEYS) {
        const value = saved.get(key);
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      resetVaultIdentityPins();
      rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

/** An unswitched vault (a legacy `Brain/` tree) for a dream pass, under `parent`. */
export function makeLegacyDreamVault(parent: string): string {
  const vault = join(parent, "vault");
  for (const d of ["preferences", "retired", "inbox", "processed", "log"]) {
    mkdirSync(join(vault, "Brain", d), { recursive: true });
  }
  writeFileSync(join(vault, "Brain", "_brain.yaml"), "schema_version: 1\n");
  return vault;
}

/** A store at `root` with one rule and one log event, `dev-a` claiming the view writer. */
export function seedWriterStore(root: string): StoreHandle {
  initStore({ root });
  const a = openStore({ root, device: "dev-a" });
  seedPreference(a, AUTO_NOW - 10_000, "pref-a", { principle: "Rule A.", status: "confirmed" });
  seedLogEvent(a, AUTO_NOW - 9_000, "note", { text: "Did a thing." });
  claimViewWriter(a, { agent: "t", now: () => AUTO_NOW - 8_000 });
  return a;
}
