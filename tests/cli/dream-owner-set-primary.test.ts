/**
 * `o2b brain set-primary` and the dream owner (design D4): on a brain with
 * an owner it changes the owner's agent on the owner's device and refuses
 * elsewhere with `dream_not_owner`; on a brain with no owner it writes the
 * declared name as before and binds no owner.
 */
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  claimDreamOwner,
  readDreamOwner,
  takeDreamOwner,
} from "../../src/core/brain/dream-owner/owner.ts";
import * as ownerModule from "../../src/core/brain/dream-owner/owner.ts";
import { cmdBrainSetPrimary } from "../../src/cli/brain/verbs/set-primary.ts";
import { STORE_ROOT_ENV } from "../../src/core/store/constants.ts";
import { initStore } from "../../src/core/store/store-init.ts";
import { openStore } from "../../src/core/store/store-open.ts";
import { runCli } from "../helpers/run-cli.ts";

let parent: string;
let storeRoot: string;
let configPath: string;
beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-dream-owner-set-primary-"));
  storeRoot = join(parent, "store");
  configPath = join(parent, "config.yaml");
  writeFileSync(configPath, "agent_name: claude\n");
  initStore({ root: storeRoot });
});
afterEach(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function cli(device: string, ...args: string[]) {
  return runCli(args, {
    env: {
      OPEN_SECOND_BRAIN_CONFIG: configPath,
      [STORE_ROOT_ENV]: storeRoot,
      O2B_DEVICE_ID: device,
    },
  });
}

const owner = () => readDreamOwner(openStore({ root: storeRoot, device: "dev-x" })).owner;

describe("brain set-primary and the dream owner", () => {
  test("on a brain with no owner it writes the declared name and binds no owner", async () => {
    const res = await cli("dev-a", "brain", "set-primary", "hermes");
    expect(res.returncode).toBe(0);
    expect(owner()).toBeNull();
    const status = JSON.parse((await cli("dev-a", "dream", "owner", "--json")).stdout);
    expect(status).toMatchObject({ owner: null, declared_primary_agent: "hermes" });
  });

  test("on the owner's device it changes the owner's agent", async () => {
    claimDreamOwner(openStore({ root: storeRoot, device: "dev-a" }), "claude", {
      writer: "o2b",
      authority: "human",
    });
    const res = await cli("dev-a", "brain", "set-primary", "codex");
    expect(res.returncode).toBe(0);
    expect(owner()).toMatchObject({ device: "dev-a", agent: "codex" });
  });

  test("on another device it refuses with dream_not_owner and changes nothing", async () => {
    claimDreamOwner(openStore({ root: storeRoot, device: "dev-a" }), "claude", {
      writer: "o2b",
      authority: "human",
    });
    const res = await cli("dev-b", "brain", "set-primary", "codex");
    expect(res.returncode).toBe(1);
    expect(res.stderr).toContain("not the dream owner");
    const json = await cli("dev-b", "brain", "set-primary", "codex", "--json");
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: false, code: "dream_not_owner" });
    expect(owner()).toMatchObject({ device: "dev-a", agent: "claude" });
  });

  test("it rechecks ownership under the pass lock before changing primary_agent", async () => {
    claimDreamOwner(openStore({ root: storeRoot, device: "dev-a" }), "claude", {
      writer: "o2b",
      authority: "human",
    });
    const envBefore = {
      config: process.env["OPEN_SECOND_BRAIN_CONFIG"],
      store: process.env[STORE_ROOT_ENV],
      device: process.env["O2B_DEVICE_ID"],
    };
    process.env["OPEN_SECOND_BRAIN_CONFIG"] = configPath;
    process.env[STORE_ROOT_ENV] = storeRoot;
    process.env["O2B_DEVICE_ID"] = "dev-a";
    const original = ownerModule.withDreamPassLock;
    let moved = false;
    const spy = spyOn(ownerModule, "withDreamPassLock").mockImplementation((...args) => {
      if (!moved) {
        moved = true;
        takeDreamOwner(openStore({ root: storeRoot, device: "dev-b" }), "codex", {
          writer: "o2b",
          authority: "human",
          force: true,
        });
      }
      return original(...args);
    });
    try {
      expect(await cmdBrainSetPrimary(["sonnet"])).toBe(1);
      expect(owner()).toMatchObject({ device: "dev-b", agent: "codex" });
      const status = JSON.parse((await cli("dev-b", "dream", "owner", "--json")).stdout);
      expect(status.declared_primary_agent).toBeNull();
    } finally {
      spy.mockRestore();
      if (envBefore.config === undefined) delete process.env["OPEN_SECOND_BRAIN_CONFIG"];
      else process.env["OPEN_SECOND_BRAIN_CONFIG"] = envBefore.config;
      if (envBefore.store === undefined) delete process.env[STORE_ROOT_ENV];
      else process.env[STORE_ROOT_ENV] = envBefore.store;
      if (envBefore.device === undefined) delete process.env["O2B_DEVICE_ID"];
      else process.env["O2B_DEVICE_ID"] = envBefore.device;
    }
  });
});
