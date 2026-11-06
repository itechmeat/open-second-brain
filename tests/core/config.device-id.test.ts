/**
 * Per-install device identity (Memory Integrity Suite, t_6d52641f).
 *
 * The device id keys the per-device Brain log shards. It lives in the
 * DEVICE-LOCAL config (never the synced vault - all devices sharing
 * one id would defeat the sharding), is generated once on first use,
 * and self-heals to a valid value when hand-edited into an invalid one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  isUsableLocalDeviceId,
  isValidDeviceId,
  readDeviceId,
  resolveDeviceId,
} from "../../src/core/config.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";
import { IS_WINDOWS } from "../helpers/platform.ts";

let configHome: string;
let configPath: string;
let savedEnvId: string | undefined;

beforeEach(() => {
  configHome = mkdtempSync(join(tmpdir(), "o2b-device-id-"));
  configPath = join(configHome, "config.yaml");
  savedEnvId = process.env["O2B_DEVICE_ID"];
  delete process.env["O2B_DEVICE_ID"];
});

afterEach(() => {
  rmSync(configHome, { recursive: true, force: true });
  if (savedEnvId === undefined) delete process.env["O2B_DEVICE_ID"];
  else process.env["O2B_DEVICE_ID"] = savedEnvId;
});

describe("resolveDeviceId", () => {
  test("generates an 8-hex id on first use and persists it", () => {
    const id = resolveDeviceId(configPath);
    expect(id).toMatch(/^[a-f0-9]{8}$/);
    expect(readFileSync(configPath, "utf8")).toContain(`device_id: "${id}"`);
  });

  test("returns the same id on every subsequent call", () => {
    const first = resolveDeviceId(configPath);
    const second = resolveDeviceId(configPath);
    expect(second).toBe(first);
  });

  test("respects an existing valid value", () => {
    atomicWriteFileSync(configPath, 'device_id: "vps-main"\n');
    expect(resolveDeviceId(configPath)).toBe("vps-main");
  });

  test("regenerates when the stored value is invalid", () => {
    atomicWriteFileSync(configPath, 'device_id: "NOT/valid id!"\n');
    const id = resolveDeviceId(configPath);
    expect(id).toMatch(/^[a-f0-9]{8}$/);
    expect(readFileSync(configPath, "utf8")).toContain(`device_id: "${id}"`);
  });

  test("rejects a stored value shaped like a sync-conflict marker", () => {
    atomicWriteFileSync(configPath, 'device_id: "sync-conflict-x"\n');
    const id = resolveDeviceId(configPath);
    expect(id).toMatch(/^[a-f0-9]{8}$/);
  });
});

describe("isValidDeviceId", () => {
  test("accepts the names Windows reserves for devices: peers' data is judged alike everywhere", () => {
    for (const name of ["con", "prn", "aux", "nul", "com1", "lpt9"]) {
      expect(isValidDeviceId(name)).toBe(true);
    }
    expect(isValidDeviceId("sync-conflict-x")).toBe(false);
    expect(isValidDeviceId("Upper")).toBe(false);
  });
});

describe("isUsableLocalDeviceId", () => {
  test("on Windows refuses the names Windows reserves for devices, and only those", () => {
    for (const name of ["con", "prn", "aux", "nul", "com1", "com9", "lpt1", "lpt9"]) {
      expect(isUsableLocalDeviceId(name, "win32")).toBe(false);
    }
    for (const name of ["con1", "nul-box", "com10", "lpt0", "console", "aux-2"]) {
      expect(isUsableLocalDeviceId(name, "win32")).toBe(true);
    }
  });

  test("elsewhere a reserved Windows name stays a usable id", () => {
    for (const name of ["con", "nul", "com1", "lpt9"]) {
      expect(isUsableLocalDeviceId(name, "linux")).toBe(true);
      expect(isUsableLocalDeviceId(name, "darwin")).toBe(true);
    }
  });

  test("a reserved name in the config is replaced on Windows and kept elsewhere", () => {
    atomicWriteFileSync(configPath, 'device_id: "nul"\n');
    if (IS_WINDOWS) expect(resolveDeviceId(configPath)).toMatch(/^[a-f0-9]{8}$/);
    else expect(resolveDeviceId(configPath)).toBe("nul");
  });
});

describe("readDeviceId", () => {
  test("answers the configured id and never mints one", () => {
    expect(readDeviceId(configPath)).toBeNull();
    expect(existsSync(configPath)).toBe(false);
    atomicWriteFileSync(configPath, 'device_id: "vps-main"\n');
    expect(readDeviceId(configPath)).toBe("vps-main");
  });

  test("agrees with resolveDeviceId on the env override, opt-out included", () => {
    atomicWriteFileSync(configPath, 'device_id: "vps-main"\n');
    process.env["O2B_DEVICE_ID"] = "laptop-1";
    expect(readDeviceId(configPath)).toBe(resolveDeviceId(configPath));
    // The empty string opts out of a device identity: the writers then
    // write nothing, so a reader has no local device either.
    process.env["O2B_DEVICE_ID"] = "";
    expect(resolveDeviceId(configPath)).toBe("");
    expect(readDeviceId(configPath)).toBeNull();
  });
});
