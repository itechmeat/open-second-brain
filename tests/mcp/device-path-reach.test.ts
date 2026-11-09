/**
 * No tool result hands a remote caller an absolute path of this machine
 * (task 2.10, design D14). Once switched, an attestation is a store shard,
 * a snapshot lives in device-local state and the status block names the
 * store and its state directory: at remote reach each is named as
 * `store:<partition>/<path>` or `local:<path>`, or redacted; at local
 * reach the path stays as it is.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { collectAttestationManifest } from "../../src/core/brain/attestation/digest.ts";
import {
  attestationsDir,
  buildAttestationRecord,
  writeAttestationRecord,
} from "../../src/core/brain/attestation/record.ts";
import {
  generateAttestationKeypair,
  signAttestationRecord,
} from "../../src/core/brain/attestation/signing.ts";
import { writeSignal } from "../../src/core/brain/signal.ts";
import { resetVaultIdentityPins } from "../../src/core/brain/vault-identity.ts";
import { TRANSPORT_REACH, type TransportReach } from "../../src/core/graph/transport-reach.ts";
import { forgetMachineStateCache, machineStatePath } from "../../src/core/state/machine-state.ts";
import {
  LOCAL_PATH_PREFIX,
  REDACTED_DEVICE_PATH,
  reportedPath,
  STORE_PATH_PREFIX,
} from "../../src/mcp/brain/device-path.ts";
import { MCPServer } from "../../src/mcp/server.ts";
import { switchDevice } from "../core/brain/store-only/fixtures.ts";
import { makeStoreEnv, type StoreEnv } from "../core/store/fixtures/store-env.ts";

let env: StoreEnv | undefined;

afterEach(() => {
  env?.cleanup();
  env = undefined;
  resetVaultIdentityPins();
  forgetMachineStateCache();
});

const T1 = new Date("2026-11-06T10:00:00.100Z");
const T2 = new Date("2026-11-06T11:00:00.200Z");

function switchedEnv(prefix: string): StoreEnv {
  const e = makeStoreEnv(prefix, { dualWrite: false });
  switchDevice(e.storeRoot);
  return e;
}

/** One stored attestation and one restored into device-local state. */
function seedAttestations(e: StoreEnv): void {
  generateAttestationKeypair(e.vault);
  const sign = (now: Date) =>
    signAttestationRecord(
      buildAttestationRecord(e.vault, collectAttestationManifest(e.vault), {
        now,
        deviceId: "dev-a",
      }),
      e.vault,
    );
  const restored = sign(T1);
  const file = join(attestationsDir(e.vault), `${restored.id}.json`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(restored, null, 2)}\n`);
  writeAttestationRecord(e.vault, sign(T2));
}

async function call(
  e: StoreEnv,
  reach: TransportReach,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const server = new MCPServer({ vault: e.vault, configPath: e.configPath }, { reach });
  const envelope = (await server.callTool(tool, args)) as {
    content: ReadonlyArray<{ text: string }>;
  };
  return JSON.parse(envelope.content[0]!.text) as Record<string, unknown>;
}

/** Every temp path of the fixture (vault, store, state, home) hangs off its parent. */
function namesDevicePath(e: StoreEnv, result: unknown): boolean {
  const text = JSON.stringify(result);
  return [e.parent, e.parent.replaceAll("\\", "\\\\")].some((p) => text.includes(p));
}

describe("reportedPath", () => {
  test("names each kind of path by the caller's reach", () => {
    env = switchedEnv("osb-wp7b-device-path-");
    const inVault = join(env.vault, "notes", "a.md");
    const shard = join(env.storeRoot, "shared", "streams", "events", "x.jsonl");
    const local = machineStatePath(env.vault, "Brain", ".snapshots", "run-1");
    const elsewhere = join(env.parent, "home", "elsewhere.txt");

    for (const reach of [TRANSPORT_REACH.local, TRANSPORT_REACH.remote]) {
      expect(reportedPath(env.vault, inVault, reach)).toBe("notes/a.md");
      expect(reportedPath(env.vault, "notes/a.md", reach)).toBe("notes/a.md");
    }
    for (const target of [shard, local, elsewhere]) {
      expect(reportedPath(env.vault, target, TRANSPORT_REACH.local)).toBe(target);
    }
    expect(reportedPath(env.vault, shard, TRANSPORT_REACH.remote)).toBe(
      `${STORE_PATH_PREFIX}shared/streams/events/x.jsonl`,
    );
    expect(reportedPath(env.vault, local, TRANSPORT_REACH.remote)).toBe(
      `${LOCAL_PATH_PREFIX}Brain/.snapshots/run-1`,
    );
    expect(reportedPath(env.vault, elsewhere, TRANSPORT_REACH.remote)).toBe(REDACTED_DEVICE_PATH);
    expect(reportedPath(null, shard, TRANSPORT_REACH.remote)).toBe(
      `${STORE_PATH_PREFIX}shared/streams/events/x.jsonl`,
    );
  });
});

describe("brain_attestations list", () => {
  test("remote reach names the store record and the device-local file without a host path", async () => {
    env = switchedEnv("osb-wp7b-attest-remote-");
    seedAttestations(env);
    const out = await call(env, TRANSPORT_REACH.remote, "brain_attestations", {
      operation: "list",
    });
    const paths = (out["attestations"] as Array<{ path: string }>).map((a) => a.path);
    expect(paths).toHaveLength(2);
    expect(paths[0]!.startsWith(`${STORE_PATH_PREFIX}shared/`)).toBe(true);
    expect(paths[1]!.startsWith(LOCAL_PATH_PREFIX)).toBe(true);
    expect(namesDevicePath(env, out)).toBe(false);
  });

  test("local reach keeps the full paths", async () => {
    env = switchedEnv("osb-wp7b-attest-local-");
    seedAttestations(env);
    const out = await call(env, TRANSPORT_REACH.local, "brain_attestations", {
      operation: "list",
    });
    const paths = (out["attestations"] as Array<{ path: string }>).map((a) => a.path);
    expect(paths[0]!.startsWith(env.storeRoot)).toBe(true);
    expect(paths[1]!.startsWith(env.parent)).toBe(true);
  });
});

describe("second_brain_status", () => {
  test("remote reach names the store and its state directory without a host path", async () => {
    env = switchedEnv("osb-wp7b-status-remote-");
    const out = await call(env, TRANSPORT_REACH.remote, "second_brain_status");
    const store = out["store"] as {
      root: { path: string };
      partitions: Array<{ name: string; path: string }>;
      device_state_dir: { path: string };
    };
    expect(store.root.path).toBe(`${STORE_PATH_PREFIX}.`);
    expect(store.partitions.map((p) => p.path)).toEqual([
      `${STORE_PATH_PREFIX}shared`,
      `${STORE_PATH_PREFIX}private`,
    ]);
    expect(store.device_state_dir.path.startsWith(LOCAL_PATH_PREFIX)).toBe(true);
    expect(namesDevicePath(env, out["store"])).toBe(false);
  });

  test("local reach keeps the store paths", async () => {
    env = switchedEnv("osb-wp7b-status-local-");
    const out = await call(env, TRANSPORT_REACH.local, "second_brain_status");
    const store = out["store"] as { root: { path: string } };
    expect(store.root.path).toBe(env.storeRoot);
  });
});

describe("brain_dream", () => {
  function seedPromotion(vault: string): void {
    for (const [i, date] of ["2026-11-03", "2026-11-04", "2026-11-05"].entries()) {
      writeSignal(vault, {
        topic: "device-path-reach",
        signal: "positive",
        agent: "claude",
        principle: "Name no host path to a remote caller.",
        created_at: `${date}T10:00:00Z`,
        date,
        slug: `device-path-${i}`,
        scope: "coding",
      });
    }
  }

  // Below local reach only a dry run is served, which writes no snapshot;
  // the pass a local caller runs names its device-local snapshot in full.
  test("local reach names the device-local snapshot in full", async () => {
    env = switchedEnv("osb-wp7b-dream-local-");
    seedPromotion(env.vault);
    const out = await call(env, TRANSPORT_REACH.local, "brain_dream", {});
    expect(out["changed"]).toBe(true);
    const snapshot = String(out["snapshot_path"]);
    expect(snapshot.startsWith(env.parent)).toBe(true);
    expect(
      reportedPath(env.vault, snapshot, TRANSPORT_REACH.remote).startsWith(LOCAL_PATH_PREFIX),
    ).toBe(true);
  });

  test("a remote dry run names no device path", async () => {
    env = switchedEnv("osb-wp7b-dream-remote-");
    seedPromotion(env.vault);
    const out = await call(env, TRANSPORT_REACH.remote, "brain_dream", { dry_run: true });
    expect(namesDevicePath(env, out)).toBe(false);
  });
});
