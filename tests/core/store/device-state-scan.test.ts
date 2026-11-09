/**
 * Which entries of a device-local state directory carry another device's
 * id (task 2.12): clocks and shard locks only, valid ids only, never this
 * device's own.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { foreignDeviceEntries } from "../../../src/core/store/device-state-scan.ts";

let parent: string;
let state: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-device-state-scan-"));
  state = join(parent, "state");
});
afterEach(() => rmSync(parent, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));

function file(...segments: string[]): void {
  mkdirSync(join(state, ...segments.slice(0, -1)), { recursive: true });
  writeFileSync(join(state, ...segments), "x");
}

function dir(...segments: string[]): void {
  mkdirSync(join(state, ...segments), { recursive: true });
}

describe("foreign device entries", () => {
  test("a missing state directory has none", () => {
    expect(foreignDeviceEntries(state, "dev-a")).toEqual([]);
  });

  test("a clock, its lock folder and its temp file all count for their device", () => {
    file("clock", "dev-a.json");
    file("clock", "dev-b.json");
    dir("clock", "dev-b.json.lock");
    file("clock", "dev-b.json.tmp-123");
    expect(foreignDeviceEntries(state, "dev-a")).toEqual([
      {
        device: "dev-b",
        entries: ["clock/dev-b.json", "clock/dev-b.json.lock", "clock/dev-b.json.tmp-123"],
      },
    ]);
  });

  test("shard locks of streams and ledgers count, in both partitions", () => {
    dir("locks", "shared", "events", "dev-a");
    dir("locks", "shared", "events", "dev-b");
    dir("locks", "private", "settings", "dev-c");
    dir("locks", "shared", "ledgers", "audit", "dev-c");
    expect(foreignDeviceEntries(state, "dev-a")).toEqual([
      { device: "dev-b", entries: ["locks/shared/events/dev-b"] },
      {
        device: "dev-c",
        entries: ["locks/private/settings/dev-c", "locks/shared/ledgers/audit/dev-c"],
      },
    ]);
  });

  test("store-wide entries, unknown folders and names that are no device id are left out", () => {
    dir("index", "vault-key");
    dir("tmp", "dev-b");
    file("clock", "README");
    file("clock", "Not_An_Id.json");
    dir("locks", "elsewhere", "events", "dev-b");
    dir("locks", "shared", "blobs", "dev-b");
    dir("locks", "shared", "events", "sync-conflict-x");
    expect(foreignDeviceEntries(state, "dev-a")).toEqual([]);
  });
});
