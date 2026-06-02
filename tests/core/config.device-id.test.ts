/**
 * Per-install device identity (Memory Integrity Suite, t_6d52641f).
 *
 * The device id keys the per-device Brain log shards. It lives in the
 * DEVICE-LOCAL config (never the synced vault - all devices sharing
 * one id would defeat the sharding), is generated once on first use,
 * and self-heals to a valid value when hand-edited into an invalid one.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveDeviceId } from "../../src/core/config.ts";
import { atomicWriteFileSync } from "../../src/core/fs-atomic.ts";

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
