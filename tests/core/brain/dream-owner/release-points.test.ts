/**
 * Release points (design D3): a pending request is released by the
 * background maintenance run on the owner's device, and a pass in progress
 * there is not interrupted: while the pass lock is held the release is
 * left to the next look.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { maintainDreamOwner } from "../../../../src/core/brain/dream-owner/gate.ts";
import {
  claimDreamOwner,
  readDreamOwner,
  takeDreamOwner,
  withDreamPassLock,
} from "../../../../src/core/brain/dream-owner/owner.ts";
import { ensureVaultCurrent } from "../../../../src/core/maintenance/ensure-current.ts";
import { STORE_ROOT_ENV } from "../../../../src/core/store/constants.ts";
import { initStore } from "../../../../src/core/store/store-init.ts";
import { openStore } from "../../../../src/core/store/store-open.ts";

let tmp: string;
let vault: string;
let storeRoot: string;
let configPath: string;
const saved: Record<string, string | undefined> = {};
const human = { writer: "o2b", authority: "human" as const };

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "osb-dream-owner-release-"));
  vault = join(tmp, "vault");
  storeRoot = join(tmp, "store");
  configPath = join(tmp, "config.yaml");
  mkdirSync(vault, { recursive: true });
  writeFileSync(join(vault, "note.md"), "# A note\n");
  writeFileSync(configPath, `vault: ${vault}\nagent_name: claude\n`);
  initStore({ root: storeRoot });
  for (const key of [STORE_ROOT_ENV, "O2B_DEVICE_ID", "OPEN_SECOND_BRAIN_LOCK_WAIT_MS"]) {
    saved[key] = process.env[key];
  }
  process.env[STORE_ROOT_ENV] = storeRoot;
  process.env["OPEN_SECOND_BRAIN_LOCK_WAIT_MS"] = "100";
  claimDreamOwner(openStore({ root: storeRoot, device: "dev-a" }), "claude", human);
  takeDreamOwner(openStore({ root: storeRoot, device: "dev-b" }), "codex", {
    ...human,
    force: false,
  });
  process.env["O2B_DEVICE_ID"] = "dev-a";
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

const ownerDevice = () =>
  readDreamOwner(openStore({ root: storeRoot, device: "dev-b" })).owner?.device;

describe("release points", () => {
  test("the background maintenance on the owner's device releases a pending request", async () => {
    const result = await ensureVaultCurrent(vault, { background: false, configPath });
    expect(result.errors.filter((e) => e.startsWith("dream-owner"))).toEqual([]);
    expect(ownerDevice()).toBe("dev-b");
  });

  test("a pass in progress is not interrupted: the release waits for the pass lock", () => {
    const a = openStore({ root: storeRoot, device: "dev-a" });
    withDreamPassLock(a, () => {
      expect(maintainDreamOwner(vault, configPath)).toBeNull();
      expect(ownerDevice()).toBe("dev-a");
    });
    expect(maintainDreamOwner(vault, configPath)).toBe("dev-b");
    expect(ownerDevice()).toBe("dev-b");
  });

  test("another device's maintenance releases nothing", () => {
    process.env["O2B_DEVICE_ID"] = "dev-c";
    expect(maintainDreamOwner(vault, configPath)).toBeNull();
    expect(ownerDevice()).toBe("dev-a");
  });
});
