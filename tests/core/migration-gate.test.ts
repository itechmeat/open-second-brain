/**
 * The device-local migration gate: which vault it names (however the vault
 * is spelled), who may hold and release it, and how a gate that cannot be
 * read is answered.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertNoMigrationInProgress,
  holdMigrationGate,
  MigrationGateHeldError,
  MigrationInProgressError,
  migrationGatePath,
  readMigrationGate,
  releaseMigrationGate,
} from "../../src/core/migration-gate.ts";

let parent: string;
let vault: string;
let other: string;

beforeEach(() => {
  parent = mkdtempSync(join(tmpdir(), "osb-migration-gate-"));
  vault = join(parent, "vault");
  other = join(parent, "other");
  mkdirSync(vault);
  mkdirSync(other);
});

afterEach(() => {
  try {
    rmSync(migrationGatePath(), { recursive: true, force: true });
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("a vault reached through a link is the gated vault", () => {
  if (process.platform === "win32") return;
  const link = join(parent, "vault-link");
  symlinkSync(vault, link);
  holdMigrationGate(vault, "run-1");
  expect(() => assertNoMigrationInProgress(link)).toThrow(MigrationInProgressError);
  expect(() => assertNoMigrationInProgress(other)).not.toThrow();
  releaseMigrationGate(link, "run-1");
  expect(readMigrationGate()).toBeNull();
});

test("a gate held for another vault is refused, and only its own run releases it", () => {
  holdMigrationGate(vault, "run-1");
  expect(() => holdMigrationGate(other, "run-2")).toThrow(MigrationGateHeldError);
  // Another run of the same vault takes the gate over (a resume, or the
  // rollback of an interrupted run); the first run's release then leaves it.
  holdMigrationGate(vault, "rollback-run-1");
  releaseMigrationGate(vault, "run-1");
  expect(readMigrationGate()?.run_id).toBe("rollback-run-1");
  releaseMigrationGate(vault, "rollback-run-1");
  expect(readMigrationGate()).toBeNull();
});

test("no gate file is no gate; a damaged one refuses every vault", () => {
  expect(readMigrationGate()).toBeNull();
  writeFileSync(migrationGatePath(), "{ damaged");
  expect(() => assertNoMigrationInProgress(other)).toThrow(MigrationInProgressError);
  // The migration is a damaged gate's remedy: any run replaces or releases it.
  holdMigrationGate(other, "run-2");
  expect(readMigrationGate()?.run_id).toBe("run-2");
  writeFileSync(migrationGatePath(), "{ damaged");
  releaseMigrationGate(other, "any-run");
  expect(readMigrationGate()).toBeNull();
});

test("a gate that exists but cannot be read is neither taken over nor released", () => {
  // A folder at the gate's name: every read fails with an I/O error, the
  // way a sharing violation does while another run rewrites the file.
  mkdirSync(migrationGatePath(), { recursive: true });
  try {
    expect(() => assertNoMigrationInProgress(other)).toThrow(MigrationInProgressError);
    expect(() => holdMigrationGate(other, "run-2")).toThrow(MigrationGateHeldError);
    releaseMigrationGate(other, "run-2");
    expect(readMigrationGate()?.run_id).toBe("unknown");
  } finally {
    rmSync(migrationGatePath(), { recursive: true, force: true });
  }
});
