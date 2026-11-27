/**
 * A brain served from the store alone, owned by `dev-a` (its claim settled
 * by one look), on a machine config of its own, for the tests of the
 * dream session trigger. Everything lives under one temp directory the
 * caller removes with {@link TriggerFixture.cleanup}; the process
 * environment it changes is put back there.
 *
 * Two layouts: `env` names the store root in `OPEN_SECOND_BRAIN_STORE_ROOT`
 * on a machine with no vault; `vault` configures a vault and names no
 * root, so the store sits at the default with a vault, the vault's
 * reserved folder, as on a real machine with a vault since 2.0.1.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverConfig } from "../../../../src/core/config.ts";
import { assertDreamOwner } from "../../../../src/core/brain/dream-owner/gate.ts";
import { claimDreamOwner } from "../../../../src/core/brain/dream-owner/owner.ts";
import { DREAM_AUTO_ENV } from "../../../../src/core/brain/dream-trigger/constants.ts";
import {
  dreamTriggerRecordPath,
  readDreamTriggerRecord,
} from "../../../../src/core/brain/dream-trigger/record.ts";
import { appendRecord } from "../../../../src/core/store/appender.ts";
import {
  SETTING_SET_KIND,
  STORE_ROOT_ENV,
  STORE_VAULT_DIR,
} from "../../../../src/core/store/constants.ts";
import { initStore } from "../../../../src/core/store/store-init.ts";
import { openStore, type StoreHandle } from "../../../../src/core/store/store-open.ts";
import type { ConfigDiscovery } from "../../../../src/core/types.ts";
import { withDeviceId } from "../../../helpers/device-id.ts";

const KEYS = [
  "OPEN_SECOND_BRAIN_CONFIG",
  STORE_ROOT_ENV,
  "O2B_DEVICE_ID",
  "VAULT_DIR",
  DREAM_AUTO_ENV,
] as const;

export interface TriggerFixture {
  readonly tmp: string;
  /** The configured vault (`vault` layout), or `null`. */
  readonly vault: string | null;
  readonly storeRoot: string;
  readonly configPath: string;
  readonly recordPath: string;
  readonly config: () => ConfigDiscovery;
  readonly store: (device: string) => StoreHandle;
  readonly record: () => ReturnType<typeof readDreamTriggerRecord>;
  /** Write the shared setting `dream.auto`. */
  readonly setAuto: (value: boolean) => void;
  readonly cleanup: () => void;
}

export function makeTriggerFixture(
  options: { readonly owner?: string | null; readonly layout?: "env" | "vault" } = {},
): TriggerFixture {
  const tmp = mkdtempSync(join(tmpdir(), "osb-trigger-"));
  const vault = options.layout === "vault" ? join(tmp, "vault") : null;
  const storeRoot = vault !== null ? join(vault, STORE_VAULT_DIR) : join(tmp, "store");
  const configPath = join(tmp, "config.yaml");
  const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  // Defined before anything is set up: a setup step that throws puts the
  // environment back and removes the directory before the error goes on.
  const cleanup = (): void => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  };
  try {
    if (vault !== null) mkdirSync(vault, { recursive: true });
    initStore({ root: storeRoot });
    writeFileSync(
      configPath,
      vault !== null ? `agent_name: claude\nvault: ${vault}\n` : "agent_name: claude\n",
    );
    delete process.env["VAULT_DIR"];
    process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
    if (vault !== null) delete process.env[STORE_ROOT_ENV];
    else process.env[STORE_ROOT_ENV] = storeRoot;
    // The suite turns the trigger off (tests/setup.ts); these tests run it.
    delete process.env[DREAM_AUTO_ENV];
    process.env["O2B_DEVICE_ID"] = "dev-a";
    const owner = options.owner === undefined ? "dev-a" : options.owner;
    if (owner !== null) {
      claimDreamOwner(openStore({ root: storeRoot, device: owner }), "claude", {
        writer: "o2b",
        authority: "human",
      });
      withDeviceId(owner, () => {
        try {
          assertDreamOwner(vault, { live: true, configPath });
        } catch {
          // the first look notes the claim
        }
      });
    }
  } catch (err) {
    cleanup();
    throw err;
  }
  const recordPath = dreamTriggerRecordPath(storeRoot);
  return {
    tmp,
    vault,
    storeRoot,
    configPath,
    recordPath,
    config: () => discoverConfig(configPath),
    store: (device) => openStore({ root: storeRoot, device }),
    record: () => readDreamTriggerRecord(recordPath, storeRoot),
    setAuto: (value) => {
      appendRecord(openStore({ root: storeRoot, device: "dev-a" }), {
        partition: "shared",
        stream: "settings",
        kind: SETTING_SET_KIND,
        agent: "o2b",
        body: { authority: "human", key: "dream.auto", value },
      });
    },
    cleanup,
  };
}
