/**
 * The doctor reports the files a switch kept aside under
 * `adopt-conflicts/` (`state/machine-state.ts`): two fresh vaults of one
 * machine both held a file with different bytes, the first one's copy is
 * live, the other's waits there. The finding names the folder, the count
 * and the remedy; silent when nothing was kept aside. Read-only.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { DoctorFindings } from "../../../src/core/brain/doctor/check.ts";
import {
  ADOPT_CONFLICTS_CODE,
  adoptConflictsCheck,
} from "../../../src/core/brain/doctor/adopt-conflicts-check.ts";
import {
  adoptConflictFolders,
  forgetMachineStateCache,
  freshVaultStateRoot,
  machineStatePath,
  machineStateRoot,
} from "../../../src/core/state/machine-state.ts";
import { appendRecord } from "../../../src/core/store/appender.ts";
import { DEVICE_SWITCHED_KIND } from "../../../src/core/store/store-only.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { treeSnapshot } from "../../helpers/vault-digest.ts";

let env: StoreEnv | undefined;
afterEach(() => {
  env?.cleanup();
  env = undefined;
  forgetMachineStateCache();
});

function run(e: StoreEnv): DoctorFindings {
  const out: DoctorFindings = { issues: [], uncertain: [] };
  adoptConflictsCheck.run(
    { vault: e.vault, now: new Date(), dbPath: undefined, configPath: e.configPath },
    out,
  );
  return out;
}

function put(vault: string, text: string, ...segments: string[]): void {
  const path = machineStatePath(vault, ...segments);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

describe("adopt-conflicts doctor check", () => {
  test("is silent with nothing kept aside", () => {
    env = makeStoreEnv("osb-doctor-adopt-none-", { legacyTree: false });
    expect(run(env).issues).toEqual([]);
  });

  test("names the folder, the count and the remedy, and changes nothing", () => {
    env = makeStoreEnv("osb-doctor-adopt-", { legacyTree: false });
    const second = join(env.parent, "second-vault");
    mkdirSync(second);
    for (const [vault, text] of [
      [env.vault, "first"],
      [second, "second"],
    ] as const) {
      put(vault, text, ".open-second-brain", "hook-state", "s.json");
      put(vault, text, ".open-second-brain", "ingest-manifest.json");
    }
    appendRecord(openStore({ root: env.storeRoot, device: "dev-a" }), {
      partition: "shared",
      stream: "settings",
      kind: DEVICE_SWITCHED_KIND,
      agent: "o2b",
      body: { authority: "human", vault_id: null, device: "dev-a" },
    });
    forgetMachineStateCache();
    const live = machineStateRoot(env.vault);
    machineStateRoot(second);

    const state = join(env.parent, "state");
    const before = treeSnapshot(state);
    const { issues } = run(env);
    expect(treeSnapshot(state)).toEqual(before);
    expect(issues.map((i) => i.code)).toEqual([ADOPT_CONFLICTS_CODE]);
    const [issue] = issues;
    expect(issue!.severity).toBe("warning");
    expect(issue!.path).toBe(join(live, "..", "adopt-conflicts"));
    expect(issue!.message).toContain("2 file(s)");
    expect(issue!.message).toContain(live);
    expect(issue!.message).toContain("delete");
  });

  test("a fresh vault's kept copies are named beside the live folder of that vault", () => {
    env = makeStoreEnv("osb-doctor-adopt-fresh-", { legacyTree: false });
    forgetMachineStateCache();
    const live = freshVaultStateRoot(env.vault, env.configPath);
    const kept = join(dirname(live), "adopt-conflicts", basename(live));
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, "s.json"), "older");
    const found = adoptConflictFolders(env.configPath).find((f) => f.folder === kept);
    expect(found).toMatchObject({ live, files: 1 });
  });
});
