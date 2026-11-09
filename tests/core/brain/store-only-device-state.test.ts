/**
 * Device-local machine state once switched (task 2.10, design D14 items 6,
 * 9 and 13): on a switched machine the writers of this machine's state
 * (secrets, signing keys, checkpoints, leases, lockfiles, hook state,
 * write images, graph JSON, artifacts, payloads, snapshots, the freeze
 * marker, search tuning) write into `<device state>/migration/local/`, the
 * folder the migration copies them into, and nothing under the vault
 * changes. The exact-state lane becomes `lane-entry` records. Unswitched,
 * the same calls keep today's vault paths.
 *
 * The Brain log and the ledgers under `Brain/log/` and `Brain/logs/` are
 * another package's surfaces (the log moves to the store with its own
 * writer), so the vault comparison leaves those two folders out.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { writeHookStamp, hookStateFilePath } from "../../../hooks/lib/session-state.ts";
import { generateAttestationKeypair } from "../../../src/core/brain/attestation/signing.ts";
import { buildClaimGraph, writeClaimGraph } from "../../../src/core/brain/claim-graph.ts";
import {
  clearExactState,
  EXACT_STATE_LANE,
  listExactState,
  readExactState,
  writeExactState,
} from "../../../src/core/brain/exact-state.ts";
import { resetFreezeMarkerCache, VaultFrozenError } from "../../../src/core/brain/freeze-marker.ts";
import { freezeVault, unfreezeVault } from "../../../src/core/brain/freeze.ts";
import { checkpointPath, recordCompleted } from "../../../src/core/brain/ingest/checkpoint.ts";
import { acquireLease } from "../../../src/core/brain/maintenance/lease.ts";
import { storeBeforeImage } from "../../../src/core/brain/notes/write-record.ts";
import { claimGraphPath, writeImagePath } from "../../../src/core/brain/paths.ts";
import { secretsDir, setSecret } from "../../../src/core/brain/secrets/store.ts";
import { listSnapshots } from "../../../src/core/brain/snapshot.ts";
import { takeSnapshot } from "../../../src/core/brain/snapshot-gate.ts";
import { BRAIN_SNAPSHOT_REASON } from "../../../src/core/brain/types.ts";
import {
  recordSelfHealUpgradeFailure,
  selfHealUpgradeMarkerPath,
} from "../../../src/core/maintenance/self-heal-upgrade-state.ts";
import { forgetMachineStateCache } from "../../../src/core/state/machine-state.ts";
import { migrationDir } from "../../../src/core/store-migration/journal.ts";
import {
  foldLaneEntries,
  LANE_ENTRY_KIND,
  LANE_ENTRY_REMOVE_KIND,
} from "../../../src/core/store/lane-records.ts";
import { withOperationPrivacy } from "../../../src/core/store/operation-scope.ts";
import { openStore } from "../../../src/core/store/store-open.ts";
import { ArtifactStore } from "../../../src/mcp/artifact-store.ts";
import { treeEntries } from "../../helpers/vault-digest.ts";
import { makeStoreEnv, type StoreEnv } from "../store/fixtures/store-env.ts";
import { partitionRecords, switchDevice as switchDeviceAt } from "./store-only/fixtures.ts";

let env: StoreEnv | undefined;

afterEach(() => {
  env?.cleanup();
  env = undefined;
  forgetMachineStateCache();
  resetFreezeMarkerCache();
});

const NOW = new Date("2026-11-06T12:00:00Z");
const PLAN_ID = "a".repeat(16);

function switchDevice(e: StoreEnv): void {
  switchDeviceAt(e.storeRoot);
  forgetMachineStateCache();
  resetFreezeMarkerCache();
}

function localRoot(e: StoreEnv): string {
  return join(migrationDir(openStore({ root: e.storeRoot, device: "dev-a" })), "local");
}

/** Every file in the vault outside the log folders, with its content digest. */
function vaultOutsideLog(vault: string): Map<string, string> {
  const files = treeEntries(vault);
  for (const key of files.keys()) {
    if (key.startsWith("Brain/log/") || key.startsWith("Brain/logs/")) files.delete(key);
  }
  return files;
}

/** Drive one writer of every device-local surface family; returns the paths it wrote. */
function writeMachineState(vault: string): Record<string, string> {
  setSecret(vault, { name: "api-key", value: "s3cret", agent: "test", now: NOW });
  const keys = generateAttestationKeypair(vault);
  recordCompleted(vault, PLAN_ID, join(vault, "inbox"), ["a.md"], NOW);
  acquireLease(vault, { holder: "test", ttlMs: 60_000, now: NOW });
  recordSelfHealUpgradeFailure(vault, "boom", [], NOW);
  expect(writeHookStamp(vault, "session-1", "probe", { expiresAt: NOW.getTime() + 1000 })).toBe(
    true,
  );
  const image = storeBeforeImage(vault, "the bytes a write replaced\n");
  writeClaimGraph(vault, buildClaimGraph(vault));
  const artifact = new ArtifactStore({ vault, runId: "run-1" }).put("x".repeat(64));
  const snapshot = takeSnapshot(vault, BRAIN_SNAPSHOT_REASON.dream);
  return {
    secrets: secretsDir(vault),
    keys: keys.privatePath,
    checkpoint: checkpointPath(vault, PLAN_ID),
    marker: selfHealUpgradeMarkerPath(vault),
    hook: hookStateFilePath(vault, "session-1"),
    image: writeImagePath(vault, image.sha256),
    claims: claimGraphPath(vault),
    artifact: artifact.path,
    snapshot: snapshot.path,
  };
}

function storeRecords(e: StoreEnv, kind: string) {
  return (["shared", "private"] as const)
    .flatMap((p) => partitionRecords(e.storeRoot, p))
    .filter((r) => r.kind === kind);
}

describe("switched machine", () => {
  test("machine state lands in the device-local state and the vault does not change", () => {
    env = makeStoreEnv("osb-device-state-");
    switchDevice(env);
    const before = vaultOutsideLog(env.vault);

    const written = writeMachineState(env.vault);

    const local = localRoot(env);
    for (const [what, path] of Object.entries(written)) {
      expect({ what, inLocal: path.startsWith(local) }).toEqual({ what, inLocal: true });
      expect({ what, exists: existsSync(path) }).toEqual({ what, exists: true });
    }
    expect(listSnapshots(env.vault).snapshots.map((s) => s.path)).toEqual([written["snapshot"]!]);
    expect(vaultOutsideLog(env.vault)).toEqual(before);
  });

  test("the freeze marker is device-local and still holds the content lane", () => {
    env = makeStoreEnv("osb-device-state-");
    switchDevice(env);
    const before = vaultOutsideLog(env.vault);

    const frozen = freezeVault(env.vault, { reason: "maintenance" });
    expect(frozen.path.startsWith(localRoot(env))).toBe(true);
    expect(() => writeExactState(env!.vault, "deploy", "x")).toThrow(VaultFrozenError);
    unfreezeVault(env.vault);
    expect(writeExactState(env.vault, "deploy", "x").value).toBe("x");

    expect(vaultOutsideLog(env.vault)).toEqual(before);
  });

  test("exact state is lane entries in the store, read back from the fold", () => {
    env = makeStoreEnv("osb-device-state-");
    switchDevice(env);
    const before = vaultOutsideLog(env.vault);

    writeExactState(env.vault, "deploy-target", "staging", NOW.getTime());
    writeExactState(env.vault, "deploy-target", "production", NOW.getTime() + 1000);
    writeExactState(env.vault, "branch", "main", NOW.getTime());

    expect(readExactState(env.vault, "deploy-target")?.value).toBe("production");
    expect(listExactState(env.vault).map((e) => e.aspect)).toEqual(["branch", "deploy-target"]);
    expect(clearExactState(env.vault, "branch")).toBe(true);
    expect(clearExactState(env.vault, "branch")).toBe(false);
    expect(readExactState(env.vault, "branch")).toBeNull();

    const entries = storeRecords(env, LANE_ENTRY_KIND);
    expect(entries.length).toBe(3);
    expect(entries.every((r) => r.body["lane"] === EXACT_STATE_LANE)).toBe(true);
    expect(storeRecords(env, LANE_ENTRY_REMOVE_KIND).length).toBe(1);
    expect(existsSync(join(env.vault, "Brain", "state"))).toBe(false);
    expect(vaultOutsideLog(env.vault)).toEqual(before);
  });
});

describe("an exact-state aspect private by its partition", () => {
  test("an overwrite keeps the aspect out of shared", () => {
    env = makeStoreEnv("osb-device-state-private-");
    switchDevice(env);
    withOperationPrivacy(true, () =>
      writeExactState(env!.vault, "deploy-target", "secret host", NOW.getTime()),
    );
    writeExactState(env.vault, "deploy-target", "secret host two", NOW.getTime() + 1000);
    const shared = partitionRecords(env.storeRoot, "shared");
    expect(shared.filter((r) => r.body["lane"] === EXACT_STATE_LANE)).toEqual([]);
    expect(readExactState(env.vault, "deploy-target")?.value).toBe("secret host two");
  });
});

describe("an exact-state aspect whose private shard is gone since this machine read it", () => {
  test("an overwrite stays out of shared (fail closed)", () => {
    env = makeStoreEnv("osb-device-state-private-gone-");
    switchDevice(env);
    withOperationPrivacy(true, () =>
      writeExactState(env!.vault, "deploy-target", "secret host", NOW.getTime()),
    );
    expect(readExactState(env.vault, "deploy-target")?.value).toBe("secret host");
    const events = join(env.storeRoot, "private", "events");
    for (const device of readdirSync(events)) rmSync(join(events, device), { recursive: true });
    try {
      writeExactState(env.vault, "deploy-target", "secret host two", NOW.getTime() + 1000);
    } catch {
      // refused is fine too; what matters is where nothing went
    }
    const shared = partitionRecords(env.storeRoot, "shared");
    expect(JSON.stringify(shared.map((r) => r.body))).not.toContain("secret host");
  });
});

describe("a shared exact-state aspect overwritten with a private value", () => {
  test("leaves no value for a machine that holds only shared", () => {
    env = makeStoreEnv("osb-device-state-raise-");
    switchDevice(env);
    writeExactState(env.vault, "deploy-target", "public host", NOW.getTime());
    withOperationPrivacy(true, () =>
      writeExactState(env!.vault, "deploy-target", "secret host", NOW.getTime() + 1000),
    );
    const shared = partitionRecords(env.storeRoot, "shared");
    const live = foldLaneEntries(shared).entries.get(`${EXACT_STATE_LANE}/deploy-target`);
    expect(live?.value ?? null).toBeNull();
    expect(JSON.stringify(shared.map((r) => r.body))).not.toContain("secret host");
    // A machine holding both partitions reads the private value.
    expect(readExactState(env.vault, "deploy-target")?.value).toBe("secret host");
  });
});

describe("exact state clears and the dual write", () => {
  test("an unswitched clear dual-writes the tombstone, so the store forgets the aspect", () => {
    env = makeStoreEnv("osb-device-state-clear-");
    writeExactState(env.vault, "branch", "main");
    expect(clearExactState(env.vault, "branch")).toBe(true);
    expect(storeRecords(env, LANE_ENTRY_REMOVE_KIND).map((r) => r.body["entry"])).toEqual([
      "branch",
    ]);
    switchDeviceAt(env.storeRoot);
    expect(readExactState(env.vault, "branch")).toBeNull();
  });

  test("an aspect with a shared and a private record is cleared in shared", () => {
    env = makeStoreEnv("osb-device-state-mixed-", { dualWrite: false });
    switchDeviceAt(env.storeRoot);
    writeExactState(env.vault, "branch", "main");
    writeExactState(env.vault, "branch", "see <private>the secret branch</private>");
    expect(clearExactState(env.vault, "branch")).toBe(true);
    const tombstones = partitionRecords(env.storeRoot, "shared").filter(
      (r) => r.kind === LANE_ENTRY_REMOVE_KIND,
    );
    // The raise to private removed the shared value; the clear's own
    // tombstone reaches shared too.
    expect(tombstones.map((r) => r.body["entry"])).toEqual(["branch", "branch"]);
  });
});

describe("unswitched machine", () => {
  test("the same writers keep today's vault paths", () => {
    env = makeStoreEnv("osb-device-state-");
    const written = writeMachineState(env.vault);
    for (const [what, path] of Object.entries(written)) {
      expect({ what, inVault: path.startsWith(env.vault) }).toEqual({ what, inVault: true });
    }
    expect(existsSync(localRoot(env))).toBe(false);
  });

  test("exact state keeps its lane files; the lane entry is only the phase 1 dual write", () => {
    env = makeStoreEnv("osb-device-state-", { dualWrite: false });
    writeExactState(env.vault, "deploy-target", "staging");
    expect(readdirSync(join(env.vault, "Brain", "state"))).toEqual(["deploy-target.md"]);
    expect(storeRecords(env, LANE_ENTRY_KIND)).toEqual([]);
    env.cleanup();

    env = makeStoreEnv("osb-device-state-");
    writeExactState(env.vault, "deploy-target", "staging");
    expect(readdirSync(join(env.vault, "Brain", "state"))).toEqual(["deploy-target.md"]);
    expect(storeRecords(env, LANE_ENTRY_KIND).map((r) => r.body["entry"])).toEqual([
      "deploy-target",
    ]);
  });
});
