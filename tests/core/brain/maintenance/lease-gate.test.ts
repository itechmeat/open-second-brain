/**
 * A maintenance lane holds its lease across its tasks and releases it in a
 * `finally`. A store migration may take the gate of the vault while the
 * lane runs; the release is then a write the gate refuses. It must not
 * throw from the cleanup (which would replace the lane's result): the
 * lease row stays, and it expires at its time to live like an abandoned one.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  acquireLease,
  currentLease,
  releaseLease,
} from "../../../../src/core/brain/maintenance/lease.ts";
import { holdMigrationGate, releaseMigrationGate } from "../../../../src/core/migration-gate.ts";

let tmp: string;
let vault: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "o2b-lease-gate-"));
  vault = join(tmp, "vault");
  mkdirSync(join(vault, "Brain"), { recursive: true });
  for (const key of ["XDG_STATE_HOME", "LOCALAPPDATA"]) {
    saved[key] = process.env[key];
    process.env[key] = join(tmp, "state");
  }
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(tmp, { recursive: true, force: true });
});

test("a release the gate refuses does not throw, and the lease then expires", () => {
  const now = new Date("2026-11-19T10:00:00Z");
  expect(acquireLease(vault, { holder: "lane-a", ttlMs: 60_000, now })).toBe(true);
  holdMigrationGate(vault, "migrate-mid-run");
  try {
    let result = "";
    // The lane's shape: a result returned from the body, the release in `finally`.
    const lane = (): string => {
      try {
        return "the lane's result";
      } finally {
        releaseLease(vault, { holder: "lane-a" });
      }
    };
    expect(() => {
      result = lane();
    }).not.toThrow();
    expect(result).toBe("the lane's result");
  } finally {
    releaseMigrationGate(vault, "migrate-mid-run");
  }
  // The row was left; it is the lease's own time to live that frees it.
  expect(currentLease(vault, { now })?.holder).toBe("lane-a");
  expect(currentLease(vault, { now: new Date(now.getTime() + 61_000) })).toBeNull();
});
