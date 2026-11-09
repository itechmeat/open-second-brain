/**
 * The explicit test vault (task 2.10): a test that needs a vault gets one
 * configured for its life, whatever default the preload chose.
 */
import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";

import { resolveDeviceId, resolveVault } from "../../src/core/config.ts";
import { machineStateRoot } from "../../src/core/state/machine-state.ts";
import { makeTestVault, TEST_DEVICE_ID } from "./test-vault.ts";

describe("makeTestVault", () => {
  test("configures a vault with a Brain tree until cleanup, over a VAULT_DIR set earlier", () => {
    const before = process.env["OPEN_SECOND_BRAIN_CONFIG"];
    process.env["VAULT_DIR"] = join(homedir(), "some-other-vault");
    // The outer `finally` drops VAULT_DIR whatever fails: the preload
    // clears it once per process, so a leak would fail later tests.
    try {
      const tv = makeTestVault();
      try {
        expect(resolveVault()).toBe(tv.vault);
        expect(existsSync(join(tv.vault, "Brain"))).toBe(true);
      } finally {
        tv.cleanup();
      }
      expect(process.env["OPEN_SECOND_BRAIN_CONFIG"]).toBe(before);
      expect(process.env["VAULT_DIR"]).toBe(join(homedir(), "some-other-vault"));
      expect(existsSync(tv.vault)).toBe(false);
    } finally {
      delete process.env["VAULT_DIR"];
    }
  });

  test("cleanup drops a VAULT_DIR set while the vault lived, when none was set before", () => {
    const tv = makeTestVault();
    try {
      process.env["VAULT_DIR"] = join(homedir(), "set-meanwhile");
    } finally {
      tv.cleanup();
    }
    try {
      expect(process.env["VAULT_DIR"]).toBeUndefined();
    } finally {
      delete process.env["VAULT_DIR"];
    }
  });
});

describe("vault-free preload", () => {
  test("configures no vault and runs under the test device id", () => {
    expect(resolveVault()).toBeNull();
    expect(resolveDeviceId()).toBe(TEST_DEVICE_ID);
  });

  // Off Windows, whose state lives under the redirected `%LOCALAPPDATA%`.
  test.skipIf(process.platform === "win32")(
    "the device-local state directory is a root of this run, never the real one",
    () => {
      const state = process.env["XDG_STATE_HOME"];
      expect(state).toBeDefined();
      expect(basename(state!).startsWith("osb-test-state-")).toBe(true);
      // The machine state of a vault-free machine lands under that root.
      expect(relative(state!, machineStateRoot(null)).startsWith("..")).toBe(false);
      expect(
        relative(join(homedir(), ".local", "state"), machineStateRoot(null)).startsWith(".."),
      ).toBe(true);
    },
  );
});
