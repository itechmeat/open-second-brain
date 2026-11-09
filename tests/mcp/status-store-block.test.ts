/**
 * The `store` block of `second_brain_status` (design D12, task 2.11): the
 * store root and its partitions, the device-local state directory, the
 * device id, the dual-write flag, how far the index has caught up with the
 * store, and whether a migration is available. The fields the tool always
 * carried keep their order; the block comes last, and a store that cannot
 * be used degrades the block, never the call.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEVICE_ID_ENV } from "../../src/core/config.ts";
import { TRANSPORT_REACH } from "../../src/core/graph/transport-reach.ts";
import { catchUpBrainStore } from "../../src/core/search/brain-store/catch-up.ts";
import { indexVault } from "../../src/core/search/indexer.ts";
import { appendRecord } from "../../src/core/store/appender.ts";
import { STORE_DUAL_WRITE_ENV, STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { JSONRPC_VERSION, MCPServer } from "../../src/mcp/index.ts";
import {
  fixtureConfig,
  fixtureDirs,
  LOCAL_DEVICE,
} from "../core/search/fixtures/brain-store-index.ts";
import { ensureStore } from "../core/store/fixtures/temp-store.ts";
import { bindVaultToStore } from "../../src/core/vault-adapter/vault-binding.ts";
import { openStore } from "../../src/core/store/store-open.ts";

let parent: string;
let vault: string;
let root: string;
let configPath: string;
const ENV_KEYS = [
  "VAULT_DIR",
  "OPEN_SECOND_BRAIN_CONFIG",
  STORE_ROOT_ENV,
  STORE_DUAL_WRITE_ENV,
  DEVICE_ID_ENV,
  "XDG_STATE_HOME",
  "LOCALAPPDATA",
] as const;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-status-store-"));
  vault = join(parent, "vault");
  root = join(parent, "store");
  configPath = join(parent, "config.yaml");
  mkdirSync(join(vault, "Brain", "inbox"), { recursive: true });
  // Something to move, so a migration is offered.
  writeFileSync(join(vault, "Brain", "inbox", "2026-11-06-a.md"), "---\nid: sig-a\n---\n");
  writeFileSync(configPath, `vault: ${vault}\n`);
  for (const key of ENV_KEYS) saved[key] = process.env[key];
  delete process.env["VAULT_DIR"];
  delete process.env[STORE_DUAL_WRITE_ENV];
  process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
  process.env[STORE_ROOT_ENV] = root;
  process.env[DEVICE_ID_ENV] = LOCAL_DEVICE;
  // The local machine of the shared store-index fixture.
  const dirs = fixtureDirs(parent, LOCAL_DEVICE);
  process.env["XDG_STATE_HOME"] = dirs.env["XDG_STATE_HOME"];
  process.env["LOCALAPPDATA"] = dirs.env["LOCALAPPDATA"];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

/** The block a local caller sees; `device-path-reach.test.ts` covers remote reach. */
async function status(): Promise<Record<string, unknown>> {
  const server = new MCPServer({ vault, configPath }, { reach: TRANSPORT_REACH.local });
  const r = (await server.handleRequest({
    jsonrpc: JSONRPC_VERSION,
    id: 1,
    method: "tools/call",
    params: { name: "second_brain_status", arguments: {} },
  })) as { result?: { structuredContent: Record<string, unknown>; isError?: boolean } };
  expect(r.result?.isError).not.toBe(true);
  return r.result!.structuredContent;
}

interface StoreBlock {
  root: { path: string; origin: string; exists: boolean };
  initialized: boolean;
  store_id: string | null;
  partitions: Array<{ name: string; path: string; held: boolean; exists: boolean }>;
  partitions_held: string[];
  device_state_dir: { scope: string; path: string; origin: string; exists: boolean };
  device_id: string | null;
  dual_write_enabled: boolean;
  index: {
    exists: boolean;
    records_indexed: number | null;
    shards_read: number | null;
    last_catch_up_at: string | null;
  } | null;
  migration: {
    available: boolean;
    legacy_tree_present: boolean;
    store_exists: boolean | null;
    switched: boolean;
    next_commands: string[];
    error?: string;
  };
  error: string | null;
}

describe("second_brain_status store block", () => {
  test("keeps the existing fields in their order and adds the store block last", async () => {
    const body = await status();
    const keys = Object.keys(body);
    expect(keys.slice(0, 6)).toEqual([
      "config_path",
      "config_exists",
      "config_keys",
      "config",
      "vault_path",
      "vault_exists",
    ]);
    expect(keys.at(-1)).toBe("store");
  });

  test("before the store exists: the resolved paths, the device, the flag and an available migration", async () => {
    const store = (await status())["store"] as StoreBlock;
    expect(store.root).toEqual({ path: root, origin: "env", exists: false });
    expect(store.initialized).toBe(false);
    expect(store.store_id).toBeNull();
    expect(store.partitions_held).toEqual([]);
    expect(store.partitions.map((p) => p.name)).toEqual(["shared", "private"]);
    expect(store.device_state_dir.scope).toBe("all-stores");
    expect(store.device_id).toBe(LOCAL_DEVICE);
    expect(store.dual_write_enabled).toBe(false);
    expect(store.index).toMatchObject({ exists: false, records_indexed: null });
    expect(store.migration).toEqual({
      available: true,
      legacy_tree_present: true,
      store_exists: false,
      switched: false,
      next_commands: ["o2b store init", "o2b brain migrate-store --dry-run"],
    });
    expect(store.error).toBeNull();
  });

  test("an initialized store with dual writes on reports the records the index caught up with", async () => {
    ensureStore(root);
    writeFileSync(join(vault, "note.md"), "# Note\n\nA note.\n");
    const config = fixtureConfig(parent);
    await indexVault(config);
    appendRecord(
      openStore({ root, device: LOCAL_DEVICE, dirs: fixtureDirs(parent, LOCAL_DEVICE) }),
      {
        partition: "shared",
        stream: "events",
        kind: "decision",
        agent: "agent",
        body: { text: "a decision" },
      },
    );
    expect((await catchUpBrainStore(config, { force: true })).added).toBe(1);

    process.env[STORE_DUAL_WRITE_ENV] = "1";
    const store = (await status())["store"] as StoreBlock;
    expect(store.initialized).toBe(true);
    expect(store.store_id).toBe(config.brainStore!.storeId);
    expect(store.partitions_held).toEqual(["shared", "private"]);
    expect(store.device_state_dir).toMatchObject({
      scope: "store",
      path: config.brainStore!.deviceStateDir,
    });
    expect(store.dual_write_enabled).toBe(true);
    expect(store.index?.exists).toBe(true);
    expect(store.index?.records_indexed).toBe(1);
    expect(store.index?.shards_read).toBe(1);
    expect(typeof store.index?.last_catch_up_at).toBe("string");
  });

  test("a vault without the legacy Brain tree has no migration to offer", async () => {
    rmSync(join(vault, "Brain"), { recursive: true });
    const store = (await status())["store"] as StoreBlock;
    expect(store.migration).toEqual({
      available: false,
      legacy_tree_present: false,
      store_exists: false,
      switched: false,
      next_commands: [],
    });
  });

  test("a device that recorded its switch has no migration to offer, though the tree is still there", async () => {
    ensureStore(root);
    const own = openStore({ root, device: LOCAL_DEVICE, dirs: fixtureDirs(parent, LOCAL_DEVICE) });
    appendRecord(own, {
      partition: "shared",
      stream: "settings",
      kind: "device-switched",
      agent: "agent",
      // The record the migration writes, which also binds the vault.
      body: { authority: "human", vault_id: null, device: LOCAL_DEVICE },
    });
    bindVaultToStore(vault, { store: own });
    const store = (await status())["store"] as StoreBlock;
    expect(store.migration).toEqual({
      available: false,
      legacy_tree_present: true,
      store_exists: true,
      switched: true,
      next_commands: [],
    });
  });

  test("a store root inside the vault degrades the block with the reason, not the call", async () => {
    root = join(vault, "store");
    process.env[STORE_ROOT_ENV] = root;
    const body = await status();
    const store = body["store"] as StoreBlock;
    expect(store.root.path).toBe(root);
    expect(store.error).toContain("inside the vault");
    expect(body["config_exists"]).toBe(true);
  });
});
